var Promise = require('bluebird');
var request = require('request');
var url = require('url');

var GoogleApi = function GoogleApi(apiKey) {
    this.apiKey = apiKey;
};

GoogleApi.prototype.get = function(endpoint, params) {
    var future = Promise.defer();

    request.get(endpoint, {
        headers: {}
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

GoogleApi.prototype.searchPlace = function(location, radius, params) {
    params = params || {};
    params.key = this.apiKey;
    params.location = [location.latitude, location.longitude].join(',');
    params.radius = radius;

    return this.get(this.getEndpoint('/place/nearbysearch/json', params)).then(function(data) {
        return data.results;
    });
};

GoogleApi.prototype.getEndpoint = function(path, params) {
    var endpoint = 'https://maps.googleapis.com/maps/api/' + path.replace(/^\/+/, '');
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

module.exports = GoogleApi;