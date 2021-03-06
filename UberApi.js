var Promise = require('bluebird');
var request = require('request');
var url = require('url');

var UberApi = function UberApi(accessToken) {
    this.accessToken = accessToken;
};

/** ERRORS **/
UberApi.RateLimitError = function(message) {
    this.message = message;
    this.name = 'RateLimitError';
    Error.captureStackTrace(this, UberApi.RateLimitError);
};
UberApi.RateLimitError.prototype = Object.create(Error.prototype);
UberApi.RateLimitError.prototype.constructor = UberApi.RateLimitError;

UberApi.NoDriversError = function(message) {
    this.message = message;
    this.name = 'NoDriversError';
    Error.captureStackTrace(this, UberApi.NoDriversError);
};
UberApi.NoDriversError.prototype = Object.create(Error.prototype);
UberApi.NoDriversError.prototype.constructor = UberApi.NoDriversError;

UberApi.SurgeEnabledError = function(message) {
    this.message = message;
    this.name = 'SurgeEnabledError';
    Error.captureStackTrace(this, UberApi.SurgeEnabledError);
};
UberApi.SurgeEnabledError.prototype = Object.create(Error.prototype);
UberApi.SurgeEnabledError.prototype.constructor = UberApi.SurgeEnabledError;

UberApi.InvalidProductError = function(message) {
    this.message = message;
    this.name = 'InvalidProductError';
    Error.captureStackTrace(this, UberApi.InvalidProductError);
};
UberApi.InvalidProductError.prototype = Object.create(Error.prototype);
UberApi.InvalidProductError.prototype.constructor = UberApi.InvalidProductError;


UberApi.sandbox = true;

var handleResponse = function(future) {
    return function(err, res, body) {
        if (err) return future.reject(err);

        if (res.statusCode == 429) {
            return future.reject(new UberApi.RateLimitError('Rate limit reached.'));
        }

        if (res.statusCode == 409) {
            if (res.statusMessage == 'surge') {
                return future.reject(new UberApi.SurgeEnabledError('Surge is enabled.'));
            }
            return future.reject(new UberApi.NoDriversError('No drivers available.'));
        }

        if (res.statusCode == 404) {
            if (body.code == 'not_found') {
                return future.reject(new UberApi.InvalidProductError('Invalid product selected.'));
            }
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
            return future.reject(body);
        }

        if (res.statusCode == 204) {
            future.resolve();
        } else {
            future.resolve(body);
        }
    };
};

UberApi.prototype.get = function(path, params) {
    var future = Promise.defer();

    request.get(this.getEndpoint(path, params), {
        headers: this.getHeaders(),
        json: true
    }, handleResponse(future));

    return future.promise.bind(this);
};

UberApi.prototype.post = function(path, data) {
    var future = Promise.defer();

    request.post(this.getEndpoint(path), {
        headers: this.getHeaders(),
        json: true,
        followAllRedirects: true,
        body: data
    }, handleResponse(future));

    return future.promise;
};

UberApi.prototype.put = function(path, data) {
    var future = Promise.defer();

    request.put(this.getEndpoint(path), {
        headers: this.getHeaders(),
        json: true,
        followAllRedirects: true,
        body: data
    }, handleResponse(future));

    return future.promise;
};

UberApi.prototype.delete = function(path, data) {
    var future = Promise.defer();

    request.del(this.getEndpoint(path), {
        headers: this.getHeaders(),
        json: true,
        followAllRedirects: true,
        body: data
    }, handleResponse(future));

    return future.promise;
};

UberApi.prototype.getEndpoint = function(path, params) {
    var endpoint = (UberApi.sandbox ? 'https://sandbox-api.uber.com/' : 'https://api.uber.com/') + path.replace(/^\/+/, '');
    if (!params) {
        return endpoint;
    }

    var parsed = url.parse(endpoint, true);
    for (var param in params) {
        if (params.hasOwnProperty(param)) {
            parsed.query[param] = params[param];
        }
    }
    return url.format(parsed);
};

UberApi.prototype.getHeaders = function() {
    return {
        Authorization: 'Bearer ' + this.accessToken,
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };
};

UberApi.prototype.getProductsForLocation = function(location) {
    return this.get('/v1/products', location).then(function(products) {
        var assoc = {};
        products.products.forEach(function(product) {
            assoc[product.product_id] = product.display_name;
        });
        return assoc;
    });
};

UberApi.prototype.getCurrentTrip = function() {
    var future = Promise.defer();

    this.get('/v1/requests/current').then(function(trip) {
        future.resolve(trip);
    }).catch(function(err) {
        return this.isAPIError(err, 404, 'no_current_trip');
    }, function() {
        future.resolve();
    }).catch(function(err) {
        future.reject(err);
    });

    return future.promise.bind(this);
};

UberApi.prototype.getPlace = function(placeId) {
    var future = Promise.defer();

    this.get('/v1/places/' + placeId).then(function(place) {
        future.resolve(place);
    }).catch(function(err) {
        return this.isAPIError(err, 404, 'unknown_place_id');
    }, function() {
        future.resolve();
    }).catch(function(err) {
        future.reject(err);
    });

    return future.promise.bind(this);
};

UberApi.prototype.getAvailablePlaces = function() {
    return Promise.join(this.getPlace('work'), this.getPlace('home')).bind(this).spread(function(workPlace, homePlace) {
        var places = {};
        if (workPlace) {
            places.work = workPlace;
        }
        if (homePlace) {
            places.home = homePlace;
        }
        return places;
    });
};

UberApi.prototype.isAPIError = function(err, shouldHaveStatus, shouldHaveCode) {
    var errors = err && err.errors || [];
    for (var i = 0; i < errors.length; ++i) {
        var errObj = errors[i] || {};
        if (errObj.status == shouldHaveStatus && errObj.code == shouldHaveCode) {
            return true;
        }
    }
    return false;
};

UberApi.prototype.estimateByLocation = function(productId, location) {
    return this.post('/v1/requests/estimate', {
        product_id: productId,
        start_latitude: location.latitude,
        start_longitude: location.longitude
    });
};

UberApi.prototype.estimateByPlace = function(productId, placeId) {
    return this.post('/v1/requests/estimate', {
        product_id: productId,
        start_place_id: placeId
    });
};

UberApi.prototype.requestRideAtPlace = function(productId, placeId) {
    return this.post('/v1/requests', {
        product_id: productId,
        start_place_id: placeId
    });
};

UberApi.prototype.requestRideAtLocation = function(productId, location) {
    return this.post('/v1/requests', {
        product_id: productId,
        start_latitude: location.latitude,
        start_longitude: location.longitude
    });
};

UberApi.prototype.cancelTrip = function(rideId) {
    return this.delete('/v1/requests/' + rideId, {});
};

UberApi.prototype.getProfile = function() {
    return this.get('/v1/me');
};

UberApi.prototype.getTripReceipt = function(tripId) {
    return this.get('/v1/requests/' + tripId + '/receipt');
};

UberApi.prototype.getTripDetails = function(tripId) {
    return this.get('/v1/requests/' + tripId);
};

UberApi.prototype.getProductDetails = function(productId) {
    return this.get('/v1/products/' + productId);
};

module.exports = UberApi;