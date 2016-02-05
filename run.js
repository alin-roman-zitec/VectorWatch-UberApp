var vectorWatch = require('stream-dev-tools');
var Promise = require('bluebird');
var mysql = require('mysql');
var UberApi = require('./UberApi.js');
var GoogleApi = require('./GoogleApi.js');

var googleApi = new GoogleApi(process.env.GOOGLE_API_KEY);

var connection = mysql.createPool({
    connectionLimit: 10,
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'UberApp'
});
connection.queryAsync = Promise.promisify(connection.query);

var ChooseLocationOptions = {
    LOCATE: 0,
    HOME: 1,
    WORK: 2
};

var TTL = {
    TripStatus: 15,
    NoExpire: -1,
    Refresh: -2
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
    ERROR: 9
};

var MessageTypes = {
    COMMAND: 'command',
    ELEMENT: 'element_data'
};

var Actions = {
    NONE: 'NONE',
    CHANGE_TO_NEXT_WATCHFACE: 'CHANGE_TO_NEXT_WATCHFACE',
    CHANGE_TO_PREVIOUS_WATCHFACE: 'CHANGE_TO_PREVIOUS_WATCHFACE',
    CHANGE_WATCHFACE: 'CHANGE_WATCHFACE',
    SEND_VALUE_TO_CLOUD: 'SEND_VALUE_TO_CLOUD'
};

var Animations = {
    NONE: 'NONE',
    UP_IN: 'UP_IN',
    UP_OUT: 'UP_OUT',
    DOWN_IN: 'DOWN_IN',
    DOWN_OUT: 'DOWN_OUT',
    LEFT_IN: 'LEFT_IN',
    LEFT_OUT: 'LEFT_OUT',
    RIGHT_IN: 'RIGHT_IN',
    RIGHT_OUT: 'RIGHT_OUT'
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


var vectorStream = vectorWatch.createStreamNode({
    streamUID: process.env.STREAM_UID,
    token: process.env.VECTOR_TOKEN,

    auth: {
        protocol: 'OAuth',
        version: '2.0',

        clientId: process.env.UBER_KEY,
        clientSecret: process.env.UBER_SECRET,

        callbackUrl: 'https://vectorwatch-proxy.azurewebsites.net/uber-app/oauth_callback',
        accessTokenUrl: 'https://login.uber.com/oauth/v2/token',
        grantType: 'authorization_code',

        authorizeUrl: 'https://login.uber.com/oauth/v2/authorize?response_type=code&scope=request history places all_trips request_receipt profile'
    },

    database: {
        connection: connection
    }
});
vectorStream.debugMode = true;

vectorStream.requestConfig = function(resolve, reject, authTokens, location) {
    if (!authTokens) return reject(new Error('Invalid auth tokens.'), 901);
    if (!location) return reject(new Error('Invalid location.'), 400);

    var api = new UberApi(authTokens.access_token);
    api.getProductsForLocation(location).then(function(products) {
        var send = [];
        for (var id in products) {
            var name = products[id];
            send.push({
                name: name,
                value: id
            });
        }
        return send;
    }).then(function(products) {
        resolve({
            renderOptions: {
                Product: {
                    type: 'INPUT_LIST_STRICT',
                    hint: 'Select the Uber product you\'d like to use.',
                    order: 0,
                    dataType: 'STATIC'
                }
            },
            settings: {
                Product: products
            },
            defaults: {
                Product: products[0]
            }
        });
    }).catch(function(err) {
        reject(err);
    });
};

vectorStream.callMethod = function(resolve, reject, methodName, args, authTokens, state, location) {
    if (!authTokens) {
        return reject(new Error('Invalid auth tokens.'), 901);
    }
    callMethod(methodName, args, authTokens, state, location).then(resolve).catch(reject);
};

var callMethod = function(methodName, args, authTokens, state, location) {
    if (!RemoteMethods[methodName]) {
        return Promise.reject(new Error('Invalid method name.'));
    }

    return Promise.resolve().then(function() {
        var uberApi = new UberApi(authTokens.access_token);
        return RemoteMethods[methodName].call(null, uberApi, args, state, location);
    });
};

var RemoteMethods = {
    // Called in Watchfaces.CHOOSE_LOCATION
    loadChooseLocation: function(uberApi) {
        return uberApi.getCurrentTrip().then(function(trip) {
            if (trip) {
                return uberApi.getProfile().then(function(profile) {
                    updateLastTripIdForUser(profile.uuid, trip.request_id).then(function() {
                        // maybe we should save the destination also? in this case, we can't do it here
                    });

                    if (trip.status == 'processing') {
                        return [list([], -2), changeToWatchfaceCommand(Watchfaces.SEARCHING)];
                    } else if (trip.status == 'accepted') {
                        return [list([], -2), changeToWatchfaceCommand(Watchfaces.ARRIVING)];
                    } else if (trip.status == 'arriving') {
                        return [list([], -2), changeToWatchfaceCommand(Watchfaces.READY)];
                    } else {
                        return [list([], -2), changeToWatchfaceCommand(Watchfaces.TRIP)];
                    }
                });
            }

            return uberApi.getAvailablePlaces().then(function(places) {
                var locations = [selectOption(ChooseLocationOptions.LOCATE, 'Locate Me', {
                    onSelect: changeToWatchfaceAction(Watchfaces.RETRIEVE_LOCATION)
                })];

                if (places.home) {
                    locations.push(selectOption(ChooseLocationOptions.HOME, 'Home: ' + places.home.address, {
                        onSelect: changeToWatchfaceAction(Watchfaces.ESTIMATE_PLACE)
                    }));
                }

                if (places.work) {
                    locations.push(selectOption(ChooseLocationOptions.WORK, 'Work: ' + places.work.address, {
                        onSelect: changeToWatchfaceAction(Watchfaces.ESTIMATE_PLACE)
                    }));
                }

                return list(locations, -2);
            });
        });
    },

    estimate: function(uberApi, args, state, location) {
        var estimationPromise, locationPromise, withPlace = true;
        if (ChooseLocationOptions.HOME == args.id) {
            estimationPromise = uberApi.estimateByPlace(state.Product, Places.HOME);
            locationPromise = uberApi.getPlace(Places.HOME);
        } else if (ChooseLocationOptions.WORK == args.id) {
            estimationPromise = uberApi.estimateByPlace(state.Product, Places.WORK);
            locationPromise = uberApi.getPlace(Places.WORK);
        } else {
            if (!location) {
                return displayError('Can\'t locate you');
            }
            withPlace = false;
            estimationPromise = uberApi.estimateByLocation(state.Product, location);
            locationPromise = getLocationName(location).then(function(locationName) { return { address: locationName }; });
        }
        var productPromise = uberApi.getProductDetails(state.Product);

        return Promise.join(estimationPromise, locationPromise, productPromise).spread(function(estimation, location, product) {
            if (estimation.price.surge_multiplier > 1) {
                return displayError('Surge is enabled');
            }

            // we could use this code to format the multiplier nicely, but we can't have any multiplier but 1.0
            //var surge = estimation.price.surge_multiplier;
            //var multiplier = [Math.floor(surge), '.', Math.floor((surge * 10) % 10)].join('');
            var multiplier = '1.0';

            if (withPlace) {
                return [
                    textElement(1, location.address, Watchfaces.ESTIMATE_PLACE, -2),
                    textElement(2, [Icons.CLOCK, estimation.pickup_estimate || '?', 'MIN'].join(' '), Watchfaces.ESTIMATE_PLACE, -2),
                    textElement(3, [Icons.MULTIPLIER, multiplier, 'x'].join(' '), Watchfaces.ESTIMATE_PLACE, -2),
                    textElement(4, 'Request ' + product.display_name, Watchfaces.ESTIMATE_PLACE, -2)
                ];
            }

            var data = updateLabelsAndChangeWatchface(Watchfaces.ESTIMATE_LOCATION, {
                1: location.address,
                2: [Icons.CLOCK, estimation.pickup_estimate || '?', 'MIN'].join(' '),
                3: [Icons.MULTIPLIER, multiplier, 'x'].join(' '),
                4: 'Request ' + product.display_name
            });

            data.push(textElement(0, '', Watchfaces.RETRIEVE_LOCATION, -2));
            return data;
        });
    },

    requestRide: function(uberApi, args, state, location) {
        var promise;
        if (ChooseLocationOptions.HOME == args.id) {
            promise = uberApi.requestRideAtPlace(state.Product, Places.HOME);
        } else if (ChooseLocationOptions.WORK == args.id) {
            promise = uberApi.requestRideAtPlace(state.Product, Places.WORK);
        } else {
            if (!location) {
                return displayError('Can\'t locate you');
            }
            promise = uberApi.requestRideAtLocation(state.Product, location);
        }

        return promise.then(function(trip) {
            uberApi.getProfile().then(function(profile) {
                return updateLastTripIdForUser(profile.uuid, trip.request_id);
            }).then(function() {

            });

            return changeToWatchfaceCommand(Watchfaces.SEARCHING);
        }).catch(UberApi.NoDriversError, function() {
            return displayError('No drivers');
        }).catch(UberApi.SurgeEnabledError, function() {
            return displayError('Surge is enabled');
        });
    },

    cancelRideRequest: function(uberApi) {
        return uberApi.getCurrentTrip().then(function(trip) {
            if (!trip) {
                return;
            }

            if ('in_progress' == trip.status) {
                return changeToWatchfaceCommand(Watchfaces.TRIP, {
                    animation: Animations.NONE
                });
            }

            return uberApi.cancelTrip(trip.request_id).then(function() {
                return displayError('Trip canceled', '');
            });
        });
    },

    getSearchingUpdates: function(uberApi) {
        return handleStatusUpdates(uberApi, 'processing');
    },

    getArrivingUpdates: function(uberApi) {
        return handleStatusUpdates(uberApi, 'accepted');
    },

    getReadyUpdates: function(uberApi) {
        return handleStatusUpdates(uberApi, 'arriving');
    },

    getTripUpdates: function(uberApi) {
        return handleStatusUpdates(uberApi, 'in_progress');
    }
};

function handleTripEnded(uberApi, clearHandler) {
    return uberApi.getProfile().then(function(profile) {
        return getLastTripIdForUser(profile.uuid);
    }).then(function(lastTripId) {
        if (!lastTripId) {
            // how did he even got here?
        }

        return [uberApi.getTripDetails(lastTripId), uberApi.getTripReceipt(lastTripId)];
    }).spread(function(trip, receipt) {
        if (trip.status == 'driver_canceled' || trip.status == 'rider_canceled') {
            return displayError('Trip canceled', '', { alert: true });
        }

        var locationPromise;
        if (trip.destination) {
            locationPromise = getLocationName(trip.destination);
        } else {
            locationPromise = Promise.resolve('No destination set');
        }
        return locationPromise.then(function(locationName) {
            return updateLabelsAndChangeWatchface(Watchfaces.RECEIPT, {
                2: [Icons.PIN, locationName].join(' '),
                3: [Icons.PRICE, receipt.total_charged].join(' ')
            }, { alert: true });
        });
    });
}

function handleTripStatusChange(trip) {
    var data = getWatchfaceAndHandlersByStatus(trip.status);

    return Promise.join(
        data.updatesHandler(trip),
        data.clearHandler(),
        changeToWatchfaceCommand(data.watchfaceId, { alert: true })
    ).spread(combine);
}

function handleStatusUpdates(uberApi, status) {
    var data = getWatchfaceAndHandlersByStatus(status);
    return uberApi.getCurrentTrip().then(function(trip) {
        if (!trip) {
            return handleTripEnded(uberApi);
        }

        if (trip.status != status) {
            return handleTripStatusChange(trip);
        }

        return data.updatesHandler(trip);
    }).then(function(commands) {
        return [commands, data.clearHandler()];
    }).spread(combine);
}

var UpdatesHandlers = {
    searching: function() { return []; },
    arriving: function(trip) {
        return [
            textElement(2, [Icons.CLOCK, trip.eta, 'MIN'].join(' '), Watchfaces.ARRIVING, TTL.NoExpire),
            textElement(3, [Icons.MULTIPLIER, trip.surge_multiplier, 'x'].join(' '), Watchfaces.ARRIVING, TTL.NoExpire),
            textElement(4, [trip.vehicle.make, trip.vehicle.model].join(' '), Watchfaces.ARRIVING, TTL.NoExpire),
            textElement(5, trip.vehicle.license_plate, Watchfaces.ARRIVING, TTL.NoExpire)
        ];
    },
    ready: function(trip) {
        return [
            textElement(3, [Icons.PROFILE, trip.driver.name].join(' '), Watchfaces.READY, TTL.NoExpire),
            textElement(4, [trip.vehicle.make, trip.vehicle.model].join(' '), Watchfaces.READY, TTL.NoExpire),
            textElement(5, trip.vehicle.license_plate, Watchfaces.READY, TTL.NoExpire)
        ];
    },
    trip: function(trip) {
        var locationPromise;
        if (trip.destination) {
            locationPromise = getLocationName(trip.destination);
        } else {
            locationPromise = Promise.resolve('No destination set');
        }

        return locationPromise.then(function (locationName) {
            return [
                textElement(3, [Icons.PIN, locationName].join(' '), Watchfaces.TRIP, TTL.NoExpire),
                textElement(4, [Icons.PROFILE, trip.driver.name].join(' '), Watchfaces.TRIP, TTL.NoExpire),
                textElement(5, [Icons.CLOCK, trip.destination.eta, 'MIN'].join(' '), Watchfaces.TRIP, TTL.NoExpire)
            ];
        });
    }
};

var ClearHandlers = {
    empty: function() { return []; },
    searching: function() {
        return textElement(1, '', Watchfaces.SEARCHING, TTL.TripStatus);
    },
    arriving: function() {
        return textElement(1, '', Watchfaces.ARRIVING, TTL.TripStatus);
    },
    ready: function() {
        return textElement(1, '', Watchfaces.READY, TTL.TripStatus);
    },
    trip: function() {
        return textElement(1, '', Watchfaces.TRIP, TTL.TripStatus);
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

function list(items, ttl) {
    var data = {
        type: 'list',
        items: items
    };
    if (ttl) data.ttl = ttl;
    return data;
}

function selectOption(optionId, label, attribs) {
    var element = {
        type: 'text',
        id: optionId,
        label: label
    };
    attribs = attribs || {};
    for (var attrib in attribs) {
        if (attribs.hasOwnProperty(attrib)) {
            element[attrib] = attribs[attrib];
        }
    }
    return element;
}

function textElement(elementId, label, watchfaceId, ttl) {
    var data = {
        type: 'text_element',
        elementId: elementId,
        value: label || ''
    };

    if (watchfaceId) {
        data.watchfaceId = watchfaceId;
    }

    if (ttl) {
        data.ttl = ttl;
    }

    return data;
}

function combine() {
    return Array.prototype.concat.apply([], arguments);
}

function updateLabelsAndChangeWatchface(watchfaceId, data, options) {
    options = options || {};
    var messages = [];
    for (var elementId in data) {
        elementId = parseInt(elementId);
        var label = data[elementId];
        messages.push(textElement(elementId, label, watchfaceId, options.ttl));
    }

    messages.push(changeToWatchfaceCommand(watchfaceId, options));
    return messages;
}

function displayError(message, title, options) {
    var data = {
        2: message
    };
    if (title != null) {
        data['1'] = title;
    }
    return updateLabelsAndChangeWatchface(Watchfaces.ERROR, data, options);
}

function bitmapElement(elementId, resourceId) {
    return {
        type: 'bitmap_element',
        elementId: elementId,
        resourceId: resourceId
    };
}

function changeToWatchfaceAction(watchfaceId, animation) {
    return {
        action: Actions.CHANGE_WATCHFACE,
        animation: animation || Animations.LEFT_OUT,
        showNotifications: false,
        changeWatchfaceIndex: watchfaceId
    };
}

function getLocationName(location) {
    return googleApi.searchPlace(location, 10, {
        types: 'route'
    }).then(function(places) {
        return places && places[0] && places[0].name || 'Unknown place.';
    });
}

function changeToWatchfaceCommand(watchfaceId, options) {
    options = options || {};

    var data = {
        messageType: MessageTypes.COMMAND,
        command: Actions.CHANGE_WATCHFACE,
        parameters: {
            watchfaceId: watchfaceId
        }
    };

    if (options.animation) {
        data.parameters.animation = options.animation;
    }

    if (options.instant) {
        data.parameters.animation = Animations.NONE;
    }

    if (options.alert) {
        data.parameters.alert = true;
    }

    return data;
}

function updateLastTripIdForUser(userId, lastTripId) {
    return connection.queryAsync('INSERT INTO LastTripId (userId, lastTripId) VALUES (?, ?) ON DUPLICATE KEY UPDATE lastTripId = VALUES(lastTripId)', [userId, lastTripId]);
}

function getLastTripIdForUser(userId) {
    return connection.queryAsync('SELECT lastTripId FROM LastTripId WHERE userId = ?', [userId]).then(function(records) {
        return records && records[0] && records[0].lastTripId;
    });
}


vectorStream.startStreamServer(3090, function() {
    console.log('Uber App server started.');
});
