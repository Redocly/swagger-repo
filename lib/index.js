'use strict'

var fs = require('fs')
var Path = require('path')

var _ = require('lodash')
var YAML = require('js-yaml')
var glob = require('glob').sync
var sway = require('sway')
var mkdirp = require('mkdirp').sync
var requireDir = require('require-dir')

var jpath = require('jsonpath')
var jsonpointer = require('json-pointer')

var express = require('express')
var bodyParser = require('body-parser')

var anyYaml = '**/*.yaml'

function calcPaths (basedir = 'spec/') {
  return {
    mainFile: basedir + 'swagger.yaml',
    pathsDir: basedir + 'paths/',
    definitionsDir: basedir + 'definitions/',
    codeSamplesDir: basedir + 'code_samples/'
  }
}

exports.swaggerEditorMiddleware = function (options = {}) {
  var router = express.Router()

  const { mainFile } = calcPaths(options.basedir)

  router.use('/config/defaults.json', express.static(require.resolve('./editor_config.json')))
  router.use('/', express.static(Path.dirname(require.resolve('swagger-editor-dist/index.html'))))

  router.get('/backend_swagger.yaml', function (req, res) {
    res.setHeader('Content-Type', 'application/yaml')
    var swagger = exports.bundle({
      skipCodeSamples: true,
      skipHeadersInlining: true,
      skipPlugins: true,
      basedir: options.basedir
    })

    if (_.isEqual(swagger, readYaml(mainFile))) {
      res.end(fs.readFileSync(mainFile, 'utf-8'))
      return
    }

    var note = '' +
      '# Note: This spec is defined in multiple files.\n' +
      '# All comments and formating were lost during the bundle process.\n' +
      '# Existing files formatting may be not preserved on save.\n'
    res.end(note + exports.stringify(swagger, {yaml: true}))
  })

  router.use(bodyParser.text({
    type: 'application/yaml',
    limit: '10mb'// default limit was '100kb' which is too small for many specs
  }))

  router.put('/backend_swagger.yaml', function (req, res) {
    exports.syncWithSwagger(req.body)
    res.end('ok')
    // TODO: error handling
  })

  return router
}

exports.swaggerUiMiddleware = function () {
  return express.static(Path.dirname(require.resolve('swagger-ui-dist/index.html')))
}

exports.swaggerFileMiddleware = function (options = {}) {
  var router = express.Router()

  router.get('/swagger.json', function (req, res) {
    res.setHeader('Content-Type', 'application/json')
    res.end(exports.stringify(exports.bundle(options), {json: true}))
  })

  router.get('/swagger.yaml', function (req, res) {
    res.setHeader('Content-Type', 'application/yaml')
    res.end(exports.stringify(exports.bundle(options), {yaml: true}))
  })

  return router
}

exports.syncWithSwagger = function (swagger, options = {}) {
  var { pathsDir, definitionsDir, mainFile } = calcPaths(options.basedir)

  if (_.isString(swagger)) {
    if (!dirExist(pathsDir) && !dirExist(definitionsDir)) {
      mkdirp(Path.dirname(mainFile))
      return fs.writeFileSync(mainFile, swagger)
    }
    swagger = exports.parse(swagger)
  }
  // FIXME: support x-code-samples
  // FIXME: support for headers

  if (swagger.paths && dirExist(pathsDir)) {
    var paths = _.mapKeys(swagger.paths, function (value, key) {
      return key.substring(1).replace(/\//g, '@')
    })
    updateGlobObject(pathsDir, paths)
    swagger = _.omit(swagger, 'paths')
  }

  if (swagger.definitions && dirExist(definitionsDir)) {
    updateGlobObject(definitionsDir, swagger.definitions)
    swagger = _.omit(swagger, 'definitions')
  }

  updateYaml(mainFile, swagger)
}

exports.bundle = function (options = {}) {
  var { pathsDir, definitionsDir, mainFile, codeSamplesDir } = calcPaths(options.basedir)
  var swagger = readYaml(mainFile)

  if (dirExist(pathsDir)) {
    console.log('Adding paths to spec')
    if (swagger.paths) { throw Error('All paths should be defined inside ' + pathsDir) }
    swagger.paths = globYamlObject(pathsDir, _.flow([baseName, filenameToPath]))
  }

  if (dirExist(definitionsDir)) {
    console.log('Adding definitions to spec')
    if (swagger.definitions) { throw Error('All definitions should be defined inside ' + definitionsDir) }
    swagger.definitions = globYamlObject(definitionsDir, baseName)
  }

  if (!options.skipCodeSamples && dirExist(codeSamplesDir)) {
    console.log('Adding code samples to spec')
    bundleCodeSample(swagger, codeSamplesDir)
  }

  if (!options.skipHeadersInlining && swagger.headers) {
    console.log('Inlining headers referencess')
    inlineHeaders(swagger)
  }

  if (!options.skipPlugins) {
    console.log('Running plugins')
    runPlugins(swagger, options)
  }

  return swagger
}

function dirExist (path) {
  try {
    return fs.statSync(path).isDirectory()
  } catch (err) {
    if (err && err.code === 'ENOENT') { return false }
    throw err
  }
}

function runPlugins (swagger, options = {}) {
  var relativePluginsDir = process.env.SWAGERREPO_PLUGINS_DIR || 'scripts/plugins'
  var pluginsDir = Path.join(process.cwd(), relativePluginsDir)
  var plugins

  try {
    plugins = requireDir(pluginsDir)
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('Plugins folder not found. Skip.')
    } else {
      throw e
    }
  }

  plugins = _.values(plugins)

  _.each(plugins, function (plugin) {
    plugin.init && plugin.init(swagger)
    _.each(jpath.nodes(swagger, plugin.pathExpression), function (node) {
      var name = _.last(node.path)
      var parent = jpath.value(swagger, jpath.stringify(_.dropRight(node.path)))
      plugin.process(parent, name, node.path, swagger)
    })
    plugin.finish && plugin.finish(swagger)
  })
}

function bundleCodeSample (swagger, codeSamplesDir) {
  var codeSamples = globObject(codeSamplesDir, '*/*/*', function (filename) {
    // path === '<language>/<path>/<verb>'
    var dirs = Path.dirname(filename)
    var lang = Path.dirname(dirs)
    var path = Path.basename(dirs)
    // [<path>, <verb>, <language>]
    return [filenameToPath(path), baseName(filename), lang]
  })

  _.each(codeSamples, function (pathSamples, path) {
    _.each(pathSamples, function (opSamples, verb) {
      var swaggerOperation = _.get(swagger.paths, [path, verb])
      if (_.isUndefined(swaggerOperation)) { throw Error('Code sample for non-existing operation: "' + path + '",' + verb) }

      if (_.has(swaggerOperation, 'x-code-samples')) { throw Error('All code samples should be defined inside ' + codeSamplesDir) }

      swaggerOperation['x-code-samples'] = _.map(opSamples, function (path, lang) {
        return {lang: lang, source: fs.readFileSync(path, 'utf-8')}
      })
    })
  })
}

exports.stringify = function (swagger, options = {}) {
  if (options.yaml) { return YAML.safeDump(swagger, {indent: 2, lineWidth: -1, noRefs: true}) }

  return JSON.stringify(swagger, null, 2) + '\n'
}

exports.parse = function (string) {
  try {
    return JSON.parse(string)
  } catch (jsonError) {
    try {
      return YAML.safeLoad(string, {json: true})
    } catch (yamlError) {
      // TODO: better error message
      throw new Error('Can not parse Swagger both in YAML and JSON')
    }
  }
}

exports.validate = function (swagger, cb) {
  sway.create({definition: swagger})
    .then(function (swaggerObj) {
      return cb(null, swaggerObj.validate())
    }, function (error) {
      cb(error)
    })
}

function inlineHeaders (swagger) {
  jpath.apply(swagger, '$..[?(@.$ref)]', function (value) {
    if (!value.$ref.startsWith('#/headers')) { return value }

    // TODO: throw if (!_.omit(value, '$ref').isEmpty())
    return jsonpointer.get(swagger, value.$ref.substring(1))
  })
  delete swagger.headers
}

function baseName (path) {
  return Path.parse(path).name
}

function filenameToPath (filename) {
  return '/' + filename.replace(/@/g, '/')
}

function globObject (dir, pattern, objectPathCb) {
  return _.reduce(glob(dir + pattern), function (result, path) {
    var objPath = objectPathCb(path.substring(dir.length))
    if (_.has(result, objPath)) { throw new Error(objPath + ' definition already exists') }
    _.set(result, objPath, path)

    return result
  }, {})
}

function globYamlObject (dir, objectPathCb) {
  return _.mapValues(globObject(dir, anyYaml, objectPathCb), readYaml)
}

function updateGlobObject (dir, object) {
  var knownKeys = globObject(dir, anyYaml, baseName)

  _.each(object, function (value, key) {
    var filename = Path.join(dir, key + '.yaml')
    if (key in knownKeys) {
      filename = knownKeys[key]
      delete knownKeys[key]
    }
    updateYaml(filename, value)
  })

  _(knownKeys).values().each(fs.unlinkSync)
}

function updateYaml (file, newData) {
  var currentData
  try {
    currentData = readYaml(file)
  } catch (e) { }

  if (!_.isEqual(newData, currentData)) { saveYaml(file, newData) }
}

function readYaml (file) {
  return YAML.safeLoad(fs.readFileSync(file, 'utf-8'))
}

function saveYaml (file, object) {
  mkdirp(Path.dirname(file))
  return fs.writeFileSync(file, YAML.safeDump(object, {noRefs: true}))
}
