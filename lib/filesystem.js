/*
 * Copyright (c) 2012-2015 Digital Bazaar, Inc. All rights reserved.
 */
var async = require('async');
var bedrock = require('bedrock');
var fs = require('fs');
var mime = require('mime');
var mkdirp = require('mkdirp');
var path = require('path');
var BedrockError = bedrock.tools.BedrockError;

// load config defaults
require('./config');

// module API
var api = {};
module.exports = api;

// add routes
bedrock.events.on('bedrock-express.configure.routes', addRoutes);

function addRoutes(app) {
  app.get('/files', function(req, res, next) {
    // check to see if a path was specified
    if(!req.query.path) {
      return next(new BedrockError(
        'You must specify an \'path\' parameter when POSTing.',
        'PathNotSpecified', {
          httpStatusCode: 400,
          'public': true
        }));
    }

    if(req.query.action === 'read') {
      return _readFile(req, res, next);
    }

    // assume action is 'list'
    _readDirectory(req, res, next);
  });

  app.post('/files', function(req, res, next) {

    // check to see if an action was specified
    if(!req.query.action) {
      return next(new BedrockError(
        'You must specify an \'action\' parameter when POSTing. ' +
        'Valid values include \'mkdir\' and \'write\'.',
        'ActionNotSpecified', {
          httpStatusCode: 400,
          'public': true,
          queryParameters: req.query
        }));
    }

    // check to see if a path was specified
    if(!req.query.path) {
      return next(new BedrockError(
        'You must specify an \'path\' parameter when POSTing.',
        'PathNotSpecified', {
          httpStatusCode: 400,
          'public': true
        }));
    }

    // perform the action if it is known, otherwise return an error
    if(req.query.action === 'mkdir') {
      return _createDirectory(req, res, next);
    } else if(req.query.action === 'write') {
      return _writeFile(req, res, next);
    } else {
      return next(new BedrockError(
        'An unknown \'action\' parameter was specified.',
        'UnknownAction', {
          httpStatusCode: 400,
          'public': true,
          action: req.query.action
        }));
    }
  });
}

/**
 * Reads the contents of a file and send it in the response.
 *
 * @param req the HTTP request object.
 * @param res the HTTP response object.
 * @param next(err) the next HTTP handler in the chain.
 */
function _readFile(req, res, next) {
  async.waterfall([
    function(callback) {
      // check to see if the given file exists
      var filePath = req.query.path ? req.query.path : '';
      fs.exists(filePath, function(exists) {
        if(exists) {
          return callback(null, filePath);
        }
        callback(new BedrockError(
          'The file at the given path could not be found.',
          'NotFound', {
            httpStatusCode: 404,
            'public': true
          }));
      });
    },
    function(filePath, callback) {
      fs.lstat(filePath, function(err, stat) {
        if(err) {
          return callback(new BedrockError(
            'The file at the given path could not be examined.',
            'FileStatFailed', {
              httpStatusCode: 400,
              'public': true
            }, err));
        }

        // Check to make sure the path represents a file
        if(!stat.isFile()) {
          return callback(new BedrockError(
            'The resource at the given path is not a file.',
            'ResourceIsNotFile', {
              httpStatusCode: 400,
              'public': true
            }, err));
        }
        callback(null, filePath);
      });
    }
  ], function(err, filePath) {
    if(err) {
      return next(err);
    }

    res.setHeader("content-type", mime.lookup(filePath));
    fs.createReadStream(filePath).pipe(res);
  });
}

/**
 * Writes the body of an HTTP request to a file
 *
 * @param req the HTTP request object.
 * @param res the HTTP response object.
 * @param next(err) the next HTTP handler in the chain.
 */
function _writeFile(req, res, next) {
  var dirName = path.dirname(req.query.path);

  async.auto({
    statDirectory: function(callback) {
      fs.lstat(dirName, callback);
    },
    directoryExists: ['statDirectory', function(callback, results) {
      if(results.statDirectory.isDirectory()) {
        var wStream = fs.createWriteStream(req.query.path);
        req.on('end', function() {
          wStream.end();
          callback();
        });
        req.pipe(wStream);
      } else {
        callback(new BedrockError(
          'The file could not be written because the given path ' +
          'isn\'t a valid directory.',
          'InvalidPath', {
            httpStatusCode: 404,
            'public': true,
            path: dirName
        }));
      }
    }]}, function(err, results) {
      if(err) {
        console.log("ERR", err);
        return next(err);
      }
      res.status(201).end();
  });
}

/**
 * Finds a valid directory given a path fragment by crawling the path structure
 * upwards.
 *
 * @param queryPath the path to query and see if it is a valid directory.
 * @param callback(err, path) called when a valid directory is found.
 */
function _findValidDirectory(queryPath, callback) {
  fs.exists(queryPath, function(exists) {
    if(exists) {
      fs.lstat(queryPath, function(err, stat) {
        if(err) {
          return _findValidDirectory(path.dirname(queryPath), callback);
        }
        if(stat.isDirectory()) {
          callback(null, queryPath);
        }
      });
    } else {
      _findValidDirectory(path.dirname(queryPath), callback);
    }
  });
}

/**
 * Creates a directory and send the new metadata in the response.
 *
 * @param req the HTTP request object.
 * @param res the HTTP response object.
 * @param next(err) the next HTTP handler in the chain.
 */
function _createDirectory(req, res, next) {
  var data = {
    separator: path.sep,
    directories: [],
    files: []
  };
  var dirPath = req.query.path;

  async.auto({
    createDirectory: function(callback) {
      mkdirp.mkdirp(dirPath, callback);
    }}, function(err, result) {
    if(err) {
      return next(new BedrockError('Failed to create the directory.',
        'FailedToCreateDirectory', {
          httpStatusCode: 409,
          'public': true
        }, err));
    }

    data.path = dirPath;
    res.status(201).json(data);
  });
}

/**
 * Reads the contents of a directory and send it in the response.
 *
 * @param req the HTTP request object.
 * @param res the HTTP response object.
 * @param next(err) the next HTTP handler in the chain.
 */
function _readDirectory(req, res, next) {
  var data = {
    separator: path.sep,
    directories: [],
    files: []
  };

  async.waterfall([
    function(callback) {
      // check to see if the given directory exists
      var queryPath = req.query.path ? req.query.path : process.cwd();
      _findValidDirectory(queryPath, callback);
    },
    function(path, callback) {
      data.path = path;
      fs.readdir(path, callback);
    },
    function(files, callback) {
      // retrieve all of the file information
      async.each(files, function(filename, callback) {
        var fullpath = path.join(data.path, filename);
        fs.lstat(fullpath, function(err, stat) {
          if(err) {
            return callback(null);
          }
          var fdata = stat;
          fdata.filename = filename;

          // separate files and directories for easier client-side processing
          if(stat.isFile()) {
            data.files.push(fdata);
          } else if(stat.isDirectory()) {
            data.directories.push(fdata);
          }
          callback(null);
        });
      }, function(err, result) {
        // FIXME: sort the files and directories
        callback(null);
      });
    },
    function(callback) {
      callback(null, data);
    }
  ], function(err, result) {
    res.json(result);
  });
}
