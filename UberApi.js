var Promise = require('bluebird');
var request = require('request');
var url = require('url');

var UberApi = function UberApi(accessToken) {
    this.accessToken = accessToken;
};

UberApi.sandbox = true;

UberApi.prototype.get = function(path, params) {
    var future = Promise.defer();

    request.get(this.getEndpoint(path, params), {
        headers: this.getHeaders()
    }, function(err, res, body) {
        if (err) return future.reject(err);
        if (res.statusCode < 200 || res.statusCode >= 300) {
            try {
                err = JSON.parse(body);
            } catch (e) {
                err = new Error('Cannot GET ' + path);
            }
            return future.reject(err);
        }
        try {
            if (res.statusCode == 204) {
                future.resolve();
            } else {
                future.resolve(JSON.parse(body));
            }
        } catch (err) {
            future.reject(err);
        }
    });

    return future.promise.bind(this);
};

UberApi.prototype.post = function(path, data) {
    var future = Promise.defer();

    request.post(this.getEndpoint(path), {
        headers: this.getHeaders(),
        json: true,
        followAllRedirects: true,
        body: data
    }, function(err, res, body) {
        if (err) return future.reject(err);
        if (res.statusCode < 200 || res.statusCode >= 300) {
            try {
                err = JSON.parse(body);
            } catch (e) {
                err = new Error('Cannot POST ' + path);
            }
            return future.reject(err);
        }
        try {
            if (res.statusCode == 204) {
                future.resolve();
            } else {
                future.resolve(JSON.parse(body));
            }
        } catch (err) {
            future.reject(err);
        }
    });

    return future.promise;
};

UberApi.prototype.put = function(path, data) {
    var future = Promise.defer();

    request.put(this.getEndpoint(path), {
        headers: this.getHeaders(),
        json: true,
        followAllRedirects: true,
        body: data
    }, function(err, res, body) {
        if (err) return future.reject(err);
        if (res.statusCode < 200 || res.statusCode >= 300) {
            try {
                err = JSON.parse(body);
            } catch (e) {
                err = new Error('Cannot PUT ' + path);
            }
            return future.reject(err);
        }
        try {
            if (res.statusCode == 204) {
                future.resolve();
            } else {
                future.resolve(JSON.parse(body));
            }
        } catch (err) {
            future.reject(err);
        }
    });

    return future.promise;
};

UberApi.prototype.delete = function(path, data) {
    var future = Promise.defer();

    request.delete(this.getEndpoint(path), {
        headers: this.getHeaders(),
        json: true,
        followAllRedirects: true,
        body: data
    }, function(err, res, body) {
        if (err) return future.reject(err);
        if (res.statusCode < 200 || res.statusCode >= 300) {
            try {
                err = JSON.parse(body);
            } catch (e) {
                err = new Error('Cannot DELETE ' + path);
            }
            return future.reject(err);
        }
        try {
            if (res.statusCode == 204) {
                future.resolve();
            } else {
                future.resolve(JSON.parse(body));
            }
        } catch (err) {
            future.reject(err);
        }
    });

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
    return this.delete('/v1/requests/rideId', {});
};

module.exports = UberApi;