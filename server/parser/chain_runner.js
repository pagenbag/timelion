
var _ = require('lodash');
var glob = require('glob');
var Promise = require('bluebird');

var fs = require('fs');
var grammar = fs.readFileSync('server/parser/chain.peg', 'utf8');
var PEG = require("pegjs");
var Parser = PEG.buildParser(grammar);

var fetchData = require('./fetch_data.js');

var unzipPairs = require('../utils/unzipPairs.js');

var queryCache = {};

// Load function plugins
var functions  = _.chain(glob.sync('server/functions/*.js')).map(function (file) {
  var fnName = file.substring(file.lastIndexOf('/')+1, file.lastIndexOf('.'));
  return [fnName, require('../functions/' + fnName + '.js')];
}).zipObject().value();

// Contains the parsed sheet;
var sheet;

function getQueryCacheKey (query) {
  return JSON.stringify(_.omit(query, 'label'));
}

var invokeChain;
// Invokes a modifier function, resolving arguments into series as needed
function invoke (fnName, args) {

  args = _.map(args, function (item) {

    if (_.isNumber(item) || _.isString(item)) {
      return item;
    }
    else if (_.isObject(item) && item.type === 'query') {
      var cacheKey = getQueryCacheKey(item);

      if (queryCache[cacheKey]) {
        return Promise.resolve(_.clone(queryCache[cacheKey]));
      } else {
        throw new Error ('Missing query cache! ' + cacheKey);
      }

    }
    else if (_.isObject(item) && item.type === 'function') {
      return invoke(item.function, item.arguments);
    }
    else if (_.isObject(item) && item.type === 'reference') {
      var reference = sheet[item.plot - 1][item.series - 1];
      return invokeChain(reference);
    }
    else if (_.isObject(item) && item.type === 'chain') {
      return invokeChain(item);
    }
    return item;
  });


  return Promise.all(args).then(function (series) {
    if (!functions[fnName]){
      throw new Error('Function not found');
    }
    var output = functions[fnName](series);
    return output;
  });
}

function invokeChain (chainObj, result) {
  if (chainObj.chain.length === 0) {
    return result[0];
  }

  var chain = _.clone(chainObj.chain);
  var link = chain.shift();

  var promise;
  if (link.type === 'chain') {
    promise = invokeChain(link);
  } else if (!result) {
    if (link.label) {
      promise = invoke('label', [link, link.label, true]);
    } else {
      promise = invoke('first', [link]);
    }
  } else {
    promise = invoke(link.function, result.concat(link.arguments));
  }

  return promise.then(function (result) {
    return invokeChain({type:'chain', chain: chain}, [result]);
  });

}

function resolveChainList (chainList) {
  var seriesList = _.map(chainList, function (chain) {
    var values = invokeChain(chain);

    return values.then(function (args) {
      args.data = unzipPairs(args.data);
      return args;
    });
  });
  return Promise.all(seriesList).then(function (args) {
    return args;
  }).catch(function () {
    return {};
  });

}

function preProcessSheet (sheet) {
  var queries = {};

  function findQueries(chain) {
    _.each(chain, function (operator) {
      if (!_.isObject(operator)) {
        return;
      }
      if (operator.type === 'chain') {
        findQueries(operator.chain);
      } else if (operator.type === 'function') {
        findQueries(operator.arguments);
      } else if (operator.type === 'query') {
        var cacheKey = getQueryCacheKey(operator);
        queries[cacheKey] = operator;
      }
    });
  }

  _.each(sheet, function (chainList) {
    findQueries(chainList);
  });

  var promises = _.map(queries, function (item, cacheKey) {
    return fetchData(item, cacheKey);
  });

  return Promise.all(promises).then(function (results) {
    _.each(results, function (result) {
      queryCache[result.cacheKey] = result;
    });
    return queryCache;
  });
}

function resolveSheet (sheet) {
  return _.map(sheet, function (plot) {
    return Parser.parse(plot);
  });
}

function processRequest (request) {
  queryCache = {};
  // This is setting the "global" sheet
  sheet = resolveSheet(request);

  return preProcessSheet(sheet).then(function () {
    return _.map(sheet, function (chainList) {
      return resolveChainList(chainList).then(function (plots) {
        return plots;
      });
    });
  });
}

module.exports = processRequest;

function debugSheet (sheet) {
  sheet = processRequest(sheet);
  Promise.all(sheet).then(function (sheet) {
    //console.log(JSON.stringify(sheet));
    return sheet;
  });
}

debugSheet(
  ['(`*`)']
  //['(`US`).divide((`*`).sum(1000))']
  //['(`*`).divide(100)']
);
