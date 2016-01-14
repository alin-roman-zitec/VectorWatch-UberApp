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


var ChosenLocation = {
    LOCATE: 1,
    HOME: 2,
    WORK: 3,

    SHOW_TRIP: 11,
    CANCEL_TRIP: 12
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

var callMethod = function(methodName, args, authTokens) {
    if (!RemoteMethods[methodName]) {
        return Promise.reject(new Error('Invalid method name.'));
    }

    return Promise.resolve().then(function() {
        var uberApi = new UberApi(authTokens.access_token);
        return RemoteMethods[methodName].call(null, uberApi, args);
    });
};

var RemoteMethods = {
    getLocationName: function() {
        return 'NOT IMPLEMENTED.';
    },

    estimate: function() {
        return 'NOT IMPLEMENTED.';
    },

    getRideHistory: function() {
        return 'NOT IMPLEMENTED.';
    },

    requestRideHere: function() {

    },

    requestRideFromHistory: function() {

    },

    cancelRide: function() {

    },

    getRideUpdates: function() {

    },

    loadChooseLocation: function(uberApi) {
        return uberApi.getCurrentTrip().then(function(trip) {
            if (trip) {
                var watchFaceIndex = 0;
                if ('processing' == trip.status) {
                    watchFaceIndex = 1;
                } else if ('accepted' == trip.status) {
                    watchFaceIndex = 2;
                } else if ('arriving' == trip.status) {
                    watchFaceIndex = 3;
                } else if ('in_progress' == trip.status) {
                    watchFaceIndex = 4;
                }
                return {
                    type: 'list',
                    items: [
                        {
                            type: 'text', id: ChosenLocation.SHOW_TRIP, label: 'Show current trip',
                            onSelect: {
                                action: 'BUTTON_CALLBACK_CHANGE_WATCHFACE',
                                animation: 'LEFT_OUT',
                                showNotifications: false,
                                changeWatchfaceIndex: watchFaceIndex
                            }
                        },
                        { type: 'text', id: ChosenLocation.CANCEL_TRIP, label: 'Cancel' }
                    ]
                };
            }

            return uberApi.getAvailablePlaces().then(function(places) {
                var locations = [
                    { type: 'text', id: ChosenLocation.LOCATE, label: 'My Current Location' }
                ];

                if (places.home) {
                    locations.push({
                        type: 'text', id: ChosenLocation.HOME, label: 'Home: ' + places.home.address
                    });
                }

                if (places.work) {
                    locations.push({
                        type: 'text', id: ChosenLocation.WORK, label: 'Work: ' + places.work.address
                    });
                }

                return {
                    type: 'list',
                    items: locations
                };
            });
        });
    }
};


vectorStream.startStreamServer(3090, function() {
    console.log('Uber App server started.');
});
