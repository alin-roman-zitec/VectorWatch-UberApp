var Promise = require('bluebird');
var mysql = require('mysql');
var UberApi = require('./UberApi.js');
if (process.env.NODE_ENV === 'production' && process.env.CONFIRM_PROD === 'YES') {
    UberApi.sandbox = false;
}
var GoogleApi = require('./GoogleApi.js');
var VectorWatch = require('vectorwatch-sdk');
var OAuth2Provider = require('vectorwatch-authprovider-oauth2');
//var FileSystemStorageProvider = require('vectorwatch-storageprovider-filesystem');
var MySQLStorageProvider = require('vectorwatch-storageprovider-mysql');

var vectorWatch = new VectorWatch({
    streamUID: process.env.STREAM_UID,
    token: process.env.VECTOR_TOKEN
});

var dbSettings = {
    connectionLimit: 10,
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'NewUberApp'
};

//var storageProvider = new FileSystemStorageProvider('data');
var storageProvider = new MySQLStorageProvider(dbSettings);

var authProvider = new OAuth2Provider(storageProvider, {
    clientId: process.env.UBER_KEY,
    clientSecret: process.env.UBER_SECRET,

    callbackUrl: 'https://vectorwatch-proxy.azurewebsites.net/uber-app/oauth_callback',
    accessTokenUrl: 'https://login.uber.com/oauth/v2/token',
    grantType: 'authorization_code',

    authorizeUrl: 'https://login.uber.com/oauth/v2/authorize?response_type=code&scope=request history places profile all_trips request_receipt'
});
vectorWatch.setStorageProvider(storageProvider);
vectorWatch.setAuthProvider(authProvider);

var googleApi = new GoogleApi(process.env.GOOGLE_API_KEY);

var connection = mysql.createPool(dbSettings);
connection.queryAsync = Promise.promisify(connection.query);

var ChooseLocationOptions = {
    LOCATE: 0,
    HOME: 1,
    WORK: 2
};

var TTL = {
    TripStatus: 30
};

var Watchfaces = {
    COVER: 0,
    CHOOSE_LOCATION: 1,
    RETRIEVE_LOCATION: 2,
    ESTIMATE_LOCATION: 3,
    ESTIMATE_PLACE: 10,
    SEARCHING: 4,
    ARRIVING: 5,
    READY: 6,
    TRIP: 7,
    RECEIPT: 8,
    ERROR: 9,
    LOADING_ESTIMATE_PLACE: 12
};

var Places = {
    WORK: 'work',
    HOME: 'home'
};

var Icons = {
    CLOCK: '\ue02b',
    MULTIPLIER: '\ue022',
    PROFILE: '\ue023',
    PIN: '\ue021',
    PRICE: '\ue020'
};



vectorWatch.on('config', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        //if (!event.getLocation()) {
        //    response.sendBadRequestError('Invalid location.');
        //}

        var api = new UberApi(authTokens.access_token);
        var productsPromise = null;
        if (!event.getLocation()) {
            productsPromise = Promise.resolve({});
        } else {
            productsPromise = api.getProductsForLocation(event.getLocation());
        }

        productsPromise.then(function(products) {
            var productSetting = response.createAutocomplete('Product');
            productSetting.setHint('Select the Uber product you\'d like to use.');
            for (var id in products) {
                var name = products[id];
                productSetting.addOption(name, id);
            }
            response.send();
        }).catch(function(err) {
            response.sendBadRequestError(err.message);
        });
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

vectorWatch.on('call', function(event, response) {
    return response.sendBadRequestError('Invalid method name.');
});

vectorWatch.on('call:loadChooseLocation', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        var uberApi = new UberApi(authTokens.access_token);

        var list = response.createListData(0).setTTL(VectorWatch.TTL.ExpireOnWatchfaceEnter);

        uberApi.getCurrentTrip().then(function(trip) {
            if (trip) {
                return uberApi.getProfile().then(function(profile) {
                    updateLastTripIdForUser(profile.uuid, trip.request_id).then(function() {
                        // maybe we should save the destination also? in this case, we can't do it here
                    });

                    if (trip.status == 'processing') {
                        response.createChangeWatchfaceCommand(Watchfaces.SEARCHING);
                    } else if (trip.status == 'accepted') {
                        response.createChangeWatchfaceCommand(Watchfaces.ARRIVING);
                    } else if (trip.status == 'arriving') {
                        response.createChangeWatchfaceCommand(Watchfaces.READY);
                    } else {
                        response.createChangeWatchfaceCommand(Watchfaces.TRIP);
                    }

                    response.send();
                });
            }

            return uberApi.getAvailablePlaces().then(function(places) {
                list.createTextItem(ChooseLocationOptions.LOCATE, 'Locate Me')
                    .setOnSelectAction(list.createChangeWatchfaceAction(Watchfaces.RETRIEVE_LOCATION));

                if (places.home) {
                    list.createTextItem(ChooseLocationOptions.HOME, 'Home: ' + places.home.address)
                        .setOnSelectAction(list.createChangeWatchfaceAction(Watchfaces.LOADING_ESTIMATE_PLACE));
                }

                if (places.work) {
                    list.createTextItem(ChooseLocationOptions.WORK, 'Work: ' + places.work.address)
                        .setOnSelectAction(list.createChangeWatchfaceAction(Watchfaces.LOADING_ESTIMATE_PLACE));
                }

                response.send();
            });
        }).catch(UberApi.APIError, function(err) {
            uberInternalServerError(response);
            response.send();
        }).catch(function(err) {
            // todo: log this error
            internalServerError(response);
            response.send();
        });
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

vectorWatch.on('call:estimate', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        var uberApi = new UberApi(authTokens.access_token);

        var args = event.getArguments();
        var state = event.getUserSettings().toObject();
        var location = event.getLocation();

        var estimationPromise, locationPromise, withPlace = true;
        if (ChooseLocationOptions.HOME == args.id) {
            response.createTextElementData(1, '')
                .setWatchface(Watchfaces.LOADING_ESTIMATE_PLACE)
                .setTTL(VectorWatch.TTL.ExpireOnWatchfaceEnter);

            estimationPromise = uberApi.estimateByPlace(state.Product, Places.HOME);
            locationPromise = uberApi.getPlace(Places.HOME);
        } else if (ChooseLocationOptions.WORK == args.id) {
            response.createTextElementData(1, '')
                .setWatchface(Watchfaces.LOADING_ESTIMATE_PLACE)
                .setTTL(VectorWatch.TTL.ExpireOnWatchfaceEnter);

            estimationPromise = uberApi.estimateByPlace(state.Product, Places.WORK);
            locationPromise = uberApi.getPlace(Places.WORK);
        } else {
            response.createTextElementData(0, '')
                .setWatchface(Watchfaces.RETRIEVE_LOCATION)
                .setTTL(VectorWatch.TTL.ExpireOnWatchfaceEnter);

            if (!location) {
                var popup = response.createPopup('Cannot retrieve location');
                var changeToChooseLocationAction = popup.createChangeWatchfaceAction(Watchfaces.CHOOSE_LOCATION);

                popup.setTitle('Alert')
                    .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                    .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                    .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction);
                return response.send();
            }

            withPlace = false;
            estimationPromise = uberApi.estimateByLocation(state.Product, location);
            locationPromise = getLocationName(location).then(function (locationName) {
                return {address: locationName};
            });
        }
        var productPromise = uberApi.getProductDetails(state.Product);

        Promise.join(estimationPromise, locationPromise, productPromise).spread(function (estimation, location, product) {
            if (estimation.price.surge_multiplier > 1) {
                var popup = response.createPopup('Confirmation on the Uber app is required');
                var retryAction = popup.createRefreshElementAction();
                var changeToChooseLocationAction = popup.createChangeWatchfaceAction(Watchfaces.CHOOSE_LOCATION);

                popup.setTitle('Surge pricing')
                    .setLabel('Retry')
                    .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                    .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                    .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, retryAction);
                return response.send();
            }

            // we could use this code to format the multiplier nicely, but we can't have any multiplier but 1.0
            //var surge = estimation.price.surge_multiplier;
            //var multiplier = [Math.floor(surge), '.', Math.floor((surge * 10) % 10)].join('');
            var multiplier = '1.0';

            var watchface = Watchfaces.ESTIMATE_LOCATION;
            if (withPlace) {
                watchface = Watchfaces.ESTIMATE_PLACE;
            }

            response.createTextElementData(1, location.address).setWatchface(watchface);
            response.createTextElementData(2, [Icons.CLOCK, estimation.pickup_estimate || '?', 'MIN'].join(' ')).setWatchface(watchface);
            response.createTextElementData(3, [Icons.MULTIPLIER, multiplier, 'x'].join(' ')).setWatchface(watchface);
            response.createTextElementData(4, 'Request ' + product.display_name).setWatchface(watchface);
            response.createChangeWatchfaceCommand(watchface);
            return response.send();
        }).catch(UberApi.InvalidProductError, function(err) {
            var popup = response.createPopup('Please reconfigure or reinstall the app');
            var changeToCoverAction = popup.createChangeWatchfaceAction(Watchfaces.COVER);

            popup.setTitle('Error')
                .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToCoverAction)
                .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToCoverAction)
                .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToCoverAction);
            response.send();
        }).catch(UberApi.APIError, function(err) {
            uberInternalServerError(response);
            response.send();
        }).catch(function(err) {
            // todo: log this error
            internalServerError(response);
            response.send();
        });
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

function uberInternalServerError(response) {
    var popup = response.createPopup('Uber internal server error');
    var changeToCoverAction = popup.createChangeWatchfaceAction(Watchfaces.COVER);

    popup.setTitle('Error')
        .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToCoverAction)
        .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToCoverAction)
        .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToCoverAction);
}

function internalServerError(response) {
    var popup = response.createPopup('Internal server error');
    var changeToCoverAction = popup.createChangeWatchfaceAction(Watchfaces.COVER);

    popup.setTitle('Error')
        .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToCoverAction)
        .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToCoverAction)
        .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToCoverAction);
}

vectorWatch.on('call:requestRide', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        var uberApi = new UberApi(authTokens.access_token);

        var args = event.getArguments();
        var state = event.getUserSettings().toObject();
        var location = event.getLocation();

        var promise;
        if (ChooseLocationOptions.HOME == args.id) {
            promise = uberApi.requestRideAtPlace(state.Product, Places.HOME);
        } else if (ChooseLocationOptions.WORK == args.id) {
            promise = uberApi.requestRideAtPlace(state.Product, Places.WORK);
        } else {
            if (!location) {
                var popup = response.createPopup('Cannot retrieve location');
                var changeToChooseLocationAction = popup.createChangeWatchfaceAction(Watchfaces.CHOOSE_LOCATION);

                popup.setTitle('Alert')
                    .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                    .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                    .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction);
                return response.send();
            }
            promise = uberApi.requestRideAtLocation(state.Product, location);
        }

        promise.then(function(trip) {
            uberApi.getProfile().then(function(profile) {
                return updateLastTripIdForUser(profile.uuid, trip.request_id);
            }).then(function() {

            });

            response.createChangeWatchfaceCommand(Watchfaces.SEARCHING);
            response.send();
        }).catch(UberApi.NoDriversError, function() {
            var popup = response.createPopup('No cars available');
            var changeToChooseLocationAction = popup.createChangeWatchfaceAction(Watchfaces.CHOOSE_LOCATION);

            popup.setTitle('Alert')
                .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction);
            response.send();
        }).catch(UberApi.SurgeEnabledError, function() {
            var popup = response.createPopup('Confirmation on the Uber app is required');
            var retryAction = popup.createRefreshElementAction();
            var changeToChooseLocationAction = popup.createChangeWatchfaceAction(Watchfaces.CHOOSE_LOCATION);

            popup.setTitle('Surge pricing')
                .setLabel('Retry')
                .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, retryAction);
            response.send();
        }).catch(UberApi.InvalidProductError, function(err) {
            var popup = response.createPopup('Please reconfigure or reinstall the app');
            var changeToCoverAction = popup.createChangeWatchfaceAction(Watchfaces.COVER);

            popup.setTitle('Error')
                .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToCoverAction)
                .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToCoverAction)
                .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToCoverAction);
            response.send();
        }).catch(UberApi.APIError, function(err) {
            uberInternalServerError(response);
            response.send();
        }).catch(function(err) {
            // todo: log this error
            internalServerError(response);
            response.send();
        });
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

vectorWatch.on('call:cancelRideRequest', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        var uberApi = new UberApi(authTokens.access_token);

        uberApi.getCurrentTrip().then(function(trip) {
            if (!trip) {
                return response.send();
            }

            if ('in_progress' == trip.status) {
                response.createChangeWatchfaceCommand(Watchfaces.TRIP).setAnimation(VectorWatch.Animations.None);
                return response.send();
            }

            return uberApi.cancelTrip(trip.request_id).then(function() {
                var popup = response.createPopup('Trip canceled');
                var changeToChooseLocationAction = popup.createChangeWatchfaceAction(Watchfaces.CHOOSE_LOCATION);

                popup.setTitle('Alert')
                    .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                    .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                    .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction);
                return response.send();
            });
        }).catch(UberApi.APIError, function(err) {
            uberInternalServerError(response);
            response.send();
        }).catch(function(err) {
            // todo: log this error
            internalServerError(response);
            response.send();
        });
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

vectorWatch.on('call:getSearchingUpdates', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        var uberApi = new UberApi(authTokens.access_token);

        return handleStatusUpdates(event, response, uberApi, 'processing');
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

vectorWatch.on('call:getArrivingUpdates', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        var uberApi = new UberApi(authTokens.access_token);

        return handleStatusUpdates(event, response, uberApi, 'accepted');
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

vectorWatch.on('call:getReadyUpdates', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        var uberApi = new UberApi(authTokens.access_token);

        return handleStatusUpdates(event, response, uberApi, 'arriving');
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

vectorWatch.on('call:getTripUpdates', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) return response.sendInvalidAuthTokens();
        var uberApi = new UberApi(authTokens.access_token);

        return handleStatusUpdates(event, response, uberApi, 'in_progress');
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});


function handleTripEnded(event, response, uberApi) {
    return uberApi.getProfile().then(function(profile) {
        return getLastTripIdForUser(profile.uuid);
    }).then(function(lastTripId) {
        if (!lastTripId) {
            // how did he even got here?
        }

        return uberApi.getTripDetails(lastTripId);
    }).then(function(trip) {
        if (trip.status == 'driver_canceled' || trip.status == 'rider_canceled') {
            var popup = response.createPopup('Trip canceled');
            var changeToChooseLocationAction = popup.createChangeWatchfaceAction(Watchfaces.CHOOSE_LOCATION);

            popup.setTitle('Alert')
                .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction)
                .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToChooseLocationAction);
            return response.send();
        }

        return Promise.delay(15000).then(function() {
            return uberApi.getTripReceipt(lastTripId);
        }).then(function(receipt) {
            var locationPromise;
            if (trip.destination) {
                locationPromise = getLocationName(trip.destination);
            } else {
                locationPromise = Promise.resolve('No destination set');
            }
            return locationPromise.then(function(locationName) {
                response.createTextElementData(2, [Icons.PIN, locationName].join(' ')).setWatchface(Watchfaces.RECEIPT)
                response.createTextElementData(3, [Icons.PRICE, receipt.total_charged].join(' ')).setWatchface(Watchfaces.RECEIPT);
                response.createChangeWatchfaceCommand(Watchfaces.RECEIPT).setAlert();
            });
        }).catch(UberApi.APIError, function(err) {
            var popup = response.createPopup('Error retrieving the receipt');
            var changeToCoverAction = popup.createChangeWatchfaceAction(Watchfaces.CHOOSE_LOCATION);

            popup.setTitle('Error')
                .addCallback(VectorWatch.Buttons.Top, VectorWatch.ButtonEvents.Press, changeToCoverAction)
                .addCallback(VectorWatch.Buttons.Middle, VectorWatch.ButtonEvents.Press, changeToCoverAction)
                .addCallback(VectorWatch.Buttons.Bottom, VectorWatch.ButtonEvents.Press, changeToCoverAction);
            return Promise.resolve();
        });
    });
}

function handleTripStatusChange(event, response, trip) {
    var data = getWatchfaceAndHandlersByStatus(trip.status);

    return Promise.resolve().then(function () {
        return data.updatesHandler(event, response, trip);
    }).then(function () {
        return data.clearHandler(event, response);
    }).then(function () {
        response.createChangeWatchfaceCommand(data.watchfaceId).setAlert();
    });
}

function handleStatusUpdates(event, response, uberApi, status) {
    var data = getWatchfaceAndHandlersByStatus(status);
    return uberApi.getCurrentTrip().then(function(trip) {
        if (!trip) {
            return handleTripEnded(event, response, uberApi);
        }

        if (trip.status != status) {
            return handleTripStatusChange(event, response, trip);
        }

        return data.updatesHandler(event, response, trip);
    }).then(function() {
        return data.clearHandler(event, response);
    }).then(function() {
        response.send();
    }).catch(UberApi.APIError, function(err) {
        uberInternalServerError(response);
        response.send();
    }).catch(function(err) {
        // todo: log this error
        internalServerError(response);
        response.send();
    });
}

var UpdatesHandlers = {
    searching: function() { },
    arriving: function(event, response, trip) {
        var surge = trip.surge_multiplier;
        var multiplier = [Math.floor(surge), '.', Math.floor((surge * 10) % 10)].join('');

        var showPlate = !!trip.vehicle.license_plate;

        response.createTextElementData(2, [Icons.CLOCK, trip.eta, 'MIN'].join(' ')).setWatchface(Watchfaces.ARRIVING);
        response.createTextElementData(3, [Icons.MULTIPLIER, multiplier, 'x'].join(' ')).setWatchface(Watchfaces.ARRIVING);
        response.createTextElementData(4, [trip.vehicle.make, trip.vehicle.model].join(' ')).setWatchface(Watchfaces.ARRIVING);
        response.createTextElementData(showPlate ? 6 : 5, [Icons.PROFILE, trip.driver.name].join(' ')).setWatchface(Watchfaces.ARRIVING);
        response.createTextElementData(showPlate ? 5 : 6, trip.vehicle.license_place.toUpperCase()).setWatchface(Watchfaces.ARRIVING);
    },
    ready: function(event, response, trip) {
        response.createTextElementData(3, [Icons.PROFILE, trip.driver.name].join(' ')).setWatchface(Watchfaces.READY);
        response.createTextElementData(4, [trip.vehicle.make, trip.vehicle.model].join(' ')).setWatchface(Watchfaces.READY);
        response.createTextElementData(5, trip.vehicle.license_plate.toUpperCase()).setWatchface(Watchfaces.READY);
    },
    trip: function(event, response, trip) {
        var locationPromise, eta = Icons.CLOCK + ' -';
        if (trip.destination) {
            locationPromise = getLocationName(trip.destination);
            eta = [Icons.CLOCK, trip.destination.eta, 'MIN'].join(' ');
        } else {
            locationPromise = Promise.resolve('Unknown destination');
        }

        return locationPromise.then(function (locationName) {
            response.createTextElementData(3, [Icons.PIN, locationName].join(' ')).setWatchface(Watchfaces.TRIP);
            response.createTextElementData(4, [Icons.PROFILE, trip.driver.name].join(' ')).setWatchface(Watchfaces.TRIP);
            response.createTextElementData(5, eta).setWatchface(Watchfaces.TRIP);
        });
    }
};

var ClearHandlers = {
    empty: function() { },
    searching: function(event, response) {
        response.createTextElementData(1, '').setWatchface(Watchfaces.SEARCHING).setTTL(TTL.TripStatus);
    },
    arriving: function(event, response) {
        response.createTextElementData(1, '').setWatchface(Watchfaces.ARRIVING).setTTL(TTL.TripStatus);
    },
    ready: function(event, response) {
        response.createTextElementData(1, '').setWatchface(Watchfaces.READY).setTTL(TTL.TripStatus);
    },
    trip: function(event, response) {
        response.createTextElementData(1, '').setWatchface(Watchfaces.TRIP).setTTL(TTL.TripStatus);
    }
};

function getWatchfaceAndHandlersByStatus(status) {
    var watchfaceId = Watchfaces.SEARCHING,
        clearHandler = ClearHandlers.searching,
        updatesHandler = UpdatesHandlers.searching;

    if (status == 'accepted') {
        watchfaceId = Watchfaces.ARRIVING;
        clearHandler = ClearHandlers.arriving;
        updatesHandler = UpdatesHandlers.arriving;
    } else if (status == 'arriving') {
        watchfaceId = Watchfaces.READY;
        clearHandler = ClearHandlers.ready;
        updatesHandler = UpdatesHandlers.ready;
    } else if (status == 'in_progress') {
        watchfaceId = Watchfaces.TRIP;
        clearHandler = ClearHandlers.trip;
        updatesHandler = UpdatesHandlers.trip;
    }

    return {
        watchfaceId: watchfaceId,
        clearHandler: clearHandler,
        updatesHandler: updatesHandler
    };
}

function getLocationName(location) {
    return googleApi.searchPlace(location, 10, {
        types: 'route'
    }).then(function(places) {
        var place = places && places[0];
        if (!place) {
            return 'Unknown place.';
        }

        return googleApi.getPlaceDetails(place.place_id).then(function(place) {
            return place.name;
        });
    });
}

function updateLastTripIdForUser(userId, lastTripId) {
    return connection.queryAsync('INSERT INTO LastTripId (userId, lastTripId) VALUES (?, ?) ON DUPLICATE KEY UPDATE lastTripId = VALUES(lastTripId)', [userId, lastTripId]);
}

function getLastTripIdForUser(userId) {
    return connection.queryAsync('SELECT lastTripId FROM LastTripId WHERE userId = ?', [userId]).then(function(records) {
        return records && records[0] && records[0].lastTripId;
    });
}

vectorWatch.createServer(3090, function() {
    console.log('Uber App server started.');
});
