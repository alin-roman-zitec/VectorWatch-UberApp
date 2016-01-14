var vectorWatch = require('stream-dev-tools');
var Promise = require('bluebird');
var mysql = require('mysql');
var UberApi = require('./UberApi.js');

var connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'UberApp'
});
connection.connect();

var optionIndex = 0;
var ChooseLocationOptions = {
    LOCATE: optionIndex++,
    HOME: optionIndex++,
    WORK: optionIndex++,

    SHOW_TRIP: optionIndex++,
    CANCEL_TRIP: optionIndex++
};

var RetrievingLocationOptions = {
    RETRY: optionIndex++,
    CONTINUE: optionIndex++
};

var Watchfaces = {
    COVER: 0,
    CHOOSE_LOCATION: 1,
    RETRIEVE_LOCATION: 2,
    ESTIMATE: 3,
    TRIP: 4
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
    CLOCK: '\ue123',
    MULTIPLIER: '\ue321',
    PROFILE: '\ue432'
};

var tripElementIndex = 0;
var TripElements = {
    Cancel: tripElementIndex++,
    Searching: {
        Icon: tripElementIndex++,
        Label: tripElementIndex++
    },
    Arriving: {
        Time: tripElementIndex++,
        Multiplier: tripElementIndex++,
        Car: tripElementIndex++,
        Plate: tripElementIndex++
    },
    Ready: {
        Title: tripElementIndex++,
        Name: tripElementIndex++,
        Car: tripElementIndex++,
        Plate: tripElementIndex++
    },
    Trip: {
        Title: tripElementIndex++,
        Address: tripElementIndex++,
        Name: tripElementIndex++,
        Time: tripElementIndex++
    },
    Receipt: {
        Icon: 1,
        Date: tripElementIndex++,
        Address: tripElementIndex++,
        Price: tripElementIndex++
    }
};

var Resources = {
    Empty: 0,
    Car: 1,
    Uber: 2
};

var getMapping = function(labels) {
    var future = Promise.defer();

    connection.query('INSERT IGNORE INTO Mapping (string) VALUES ?', [labels.map(function(string) { return [string]; })], function(err) {
        if (err) return future.reject(err);

        connection.query('SELECT id, string FROM Mapping WHERE string IN (?)', [labels], function(err, records) {
            if (err) return future.reject(err);

            var mapping = {};
            (records || []).forEach(function(record) {
                mapping[record.string] = record.id;
            });

            future.resolve(mapping);
        });
    });

    return future.promise;
};

var getLabelById = function(id) {
    var future = Promise.defer();

    connection.query('SELECT string FROM Mapping WHERE id = ?', [id], function(err, records) {
        if (err) return future.reject(err);

        return future.resolve(((records || [])[0] || {}).string);
    });

    return future.promise;
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
        accessTokenUrl: 'https://login.uber.com/oauth/v2/token?grant_type=authorization_code',

        authorizeUrl: 'https://login.uber.com/oauth/v2/authorize?response_type=code&scope=request history places all_trips request_receipt'
    },

    database: {
        connection: connection
    }
});
vectorStream.debugMode = true;

vectorStream.requestConfig = function(resolve, reject, authTokens) {
    if (!authTokens) return reject(new Error('Invalid auth tokens.'), 901);

    var api = new UberApi(authTokens.access_token);
    api.getProductsForLocation({
        latitude: 44.452287299999995,
        longitude: 26.096447600000033
    }).then(function(products) {
        var productStringIds = Object.keys(products);
        if (!productStringIds.length) {
            return [];
        }

        return getMapping(productStringIds).then(function(mapping) {
            var send = [];
            for (var stringId in mapping) {
                send.push({
                    name: products[stringId],
                    value: mapping[stringId]
                });
            }
            return send;
        });
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

vectorStream.callMethod = function(resolve, reject, methodName, args, authTokens) {
    if (!authTokens) {
        return reject(new Error('Invalid auth tokens.'), 901);
    }
    callMethod(methodName, args, authTokens).then(resolve).catch(reject);
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
                return list([
                    selectOption(ChooseLocationOptions.SHOW_TRIP, 'Show current trip', {
                        onSelect: changeToWatchface(Watchfaces.TRIP)
                    })
                ]);
            }

            return uberApi.getAvailablePlaces().then(function(places) {
                var locations = [selectOption(ChooseLocationOptions.LOCATE, 'My Location')];

                if (places.home) {
                    locations.push(selectOption(ChooseLocationOptions.HOME, 'Home: ' + places.home.address));
                }

                if (places.work) {
                    locations.push(selectOption(ChooseLocationOptions.WORK, 'Work: ' + places.work.address));
                }

                return list(locations);
            });
        });
    },

    // Called in Watchfaces.RETIREVE_LOCATION
    getLocationName: function(uberApi, args, state, location) {
        if (!location) {
            return [
                list([
                    selectOption(RetrievingLocationOptions.RETRY, 'Retry', {
                        onSelect: changeToWatchface(Watchfaces.RETRIEVE_LOCATION)
                    })
                ]),
                textElement(1, 'Error')
            ];
        }

        // return locationApi.getLocationName(location).then(function(locationName) {
        var locationName = location.latitude + ',' + location.longitude;
        return [
            list([
                selectOption(RetrievingLocationOptions.CONTINUE, 'Continue', {
                    onSelect: changeToWatchface(Watchfaces.ESTIMATE)
                })
            ]),
            textElement(1, locationName)
        ];
        // });
    },

    // Called in Watchfaces.ESTIMATE
    estimate: function(uberApi, args, state, location) {
        var promise;
        if (ChooseLocationOptions.HOME == args.id) {
            promise = uberApi.estimateByPlace(state.Product, Places.HOME);
        } else if (ChooseLocationOptions.WORK == args.id) {
            promise = uberApi.estimateByPlace(state.Product, Places.WORK);
        } else {
            promise = uberApi.estimateByLocation(state.Product, location);
        }

        // locationApi.getMyAddress().then(...
        var locationName = 'My current address';
        return promise.then(function(estimation) {
            return [
                textElement(0, locationName),
                textElement(1, [Icons.CLOCK, estimation.pickup_estimate, 'MIN'].join(' ')),
                textElement(2, [Icons.MULTIPLIER, estimation.price.surge_multiplier, 'x'].join(' '))
            ];
        });
    },

    requestRide: function(uberApi, args, state, location) {
        var promise;
        if (ChooseLocationOptions.HOME == args.id) {
            promise = uberApi.requestRideAtPlace(state.Product, Places.HOME);
        } else if (ChooseLocationOptions.WORK == args.id) {
            promise = uberApi.requestRideAtPlace(state.Product, Places.WORK);
        } else {
            promise = uberApi.requestRideAtLocation(state.Product, location);
        }

        return promise.then(function(trip) {
            return null;
        });
    },

    cancelRideRequest: function(uberApi) {
        uberApi.getCurrentTrip().then(function(trip) {
            if (!trip) {
                return;
            }

            if ('in_progress' == trip.status) {
                return;
            }

            return uberApi.cancelRideRequest(trip.request_id);
        }).then(function() {
            return null;
        });
    },

    getTripUpdates: function(uberApi) {
        return uberApi.getCurrentTrip().then(function(trip) {
            if (!trip) {
                // get lastTripId from database
                // then get trip receipt
                // and show the last state of TRIP watchface
                return;
            }

            if ('processing' == trip.status) {
                return null;
            } else if ('accepted' == trip.status) {
                return [
                    iconElement(TripElements.Searching.Icon, Resources.Empty),
                    textElement(TripElements.Searching.Label, ''),

                    textElement(TripElements.Arriving.Car, [trip.vehicle.make, trip.vehicle.model].join(' ')),
                    textElement(TripElements.Arriving.Multiplier, [Icons.MULTIPLIER, trip.surge_multiplier, 'x'].join(' ')),
                    textElement(TripElements.Arriving.Plate, trip.vehicle.license_plate),
                    textElement(TripElements.Arriving.Time, [Icons.CLOCK, trip.eta, 'MIN'].join(' '))
                ];
            } else if ('arriving' == trip.status) {
                return [
                    textElement(TripElements.Arriving.Car, ''),
                    textElement(TripElements.Arriving.Multiplier, ''),
                    textElement(TripElements.Arriving.Plate, ''),
                    textElement(TripElements.Arriving.Time, ''),

                    textElement(TripElements.Ready.Title, 'YOUR RIDE IS HERE'),
                    textElement(TripElements.Ready.Name, [Icons.PROFILE, trip.driver.name].join(' ')),
                    textElement(TripElements.Ready.Car, [trip.vehicle.make, trip.vehicle.model].join(' ')),
                    textElement(TripElements.Ready.Plate, trip.vehicle.license_plate)
                ];
            } else if ('in_progress' == trip.status) {
                var locationName = ''; // ce-i cu asta?
                return [
                    textElement(TripElements.Ready.Title, 'YOUR RIDE IS HERE'),
                    textElement(TripElements.Ready.Name, [Icons.PROFILE, trip.driver.name].join(' ')),
                    textElement(TripElements.Ready.Car, [trip.vehicle.make, trip.vehicle.model].join(' ')),
                    textElement(TripElements.Ready.Plate, trip.vehicle.license_plate),
                    textElement(TripElements.Cancel, ''),

                    textElement(TripElements.Trip.Title, 'ON TRIP'),
                    textElement(TripElements.Trip.Address, [Icons.PIN, locationName].join(' ')),
                    textElement(TripElements.Trip.Name, [Icons.PROFILE, trip.driver.name].join(' ')),
                    textElement(TripElements.Trip.Time, [Icons.CLOCK, trip.destination.eta, 'MIN'].join(' '))
                ];
            }
        });
    }
};

function list(items) {
    return {
        type: 'list',
        items: items
    };
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

function textElement(elementId, label) {
    return {
        type: 'text_element',
        elementId: elementId,
        label: label || ''
    };
}

function changeToWatchface(watchfaceId, animation) {
    return {
        action: Actions.CHANGE_WATCHFACE,
        animation: animation || Animations.LEFT_OUT,
        showNotifications: false,
        changeWatchfaceIndex: watchfaceId
    };
}

vectorStream.startStreamServer(3090, function() {
    console.log('Uber App server started.');
});
