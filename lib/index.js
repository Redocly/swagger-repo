'use strict';

const fs = require('fs');
const Path = require('path');

const _ = require('lodash');
const YAML = require('js-yaml');
const glob = require('glob').sync;
const sway = require('sway');
const chalk = require('chalk');
const mkdirp = require('mkdirp').sync;
const requireDir = require('require-dir');

const jpath = require('jsonpath');
const jsonpointer = require('json-pointer');

const express = require('express');
const bodyParser = require('body-parser');

const livereload = require('./livereload');
const betterErrors = require('./better-errors');
const { pathToFilename, anyYaml, dirExist } = require('./utils');

function calcPaths(basedir = 'spec/') {
  return {
    mainFile: Path.join(basedir, 'openapi.yaml'),
    pathsDir: Path.join(basedir, 'paths/'),
    definitionsDir: Path.join(basedir, 'definitions/'),
    codeSamplesDir: Path.join(basedir, 'code_samples/'),
    componentsDir: Path.join(basedir, 'components/'),
    pluginsDir: Path.join(basedir, 'plugins/')
  };
}

const REDOCLY_CONFIG = 'redocly.yaml';

const OPENAPI3_COMPONENTS = [
  'schemas',
  'responses',
  'parameters',
  'examples',
  'headers',
  'requestBodies',
  'links',
  'callbacks',
  'securitySchemes'
];

exports.readConfig = function() {
  return readYamlOrDefault(
    REDOCLY_CONFIG,
    {},
    `Redocly config not found at ${chalk.yellow(REDOCLY_CONFIG)}. Using empty...`
  );
};

exports.compileIndexPage = function(options = {}) {
  const defaultWebIndex = Path.join(__dirname, 'index.html');
  const fileContents = readFileOrDefaultFile(
    'web/index.html',
    defaultWebIndex,
    `Redoc Index template not found in ${chalk.yellow('web/index.html')}. Skipping...`
  );

  const redocConfig = readYamlOrDefault(
    'web/redoc-config.yaml',
    {},
    `ReDoc config not found in ${chalk.yellow('web/redoc-config.yaml')}. Skipping...`
  );

  const redocURL =
    redocConfig.redocURL || 'https://cdn.jsdelivr.net/npm/redoc/bundles/redoc.standalone.js';
  const redocExport = redocConfig.redocExport || 'Redoc';
  return fileContents
    .replace('{{redocHead}}', options.livereload ? livereload.LIVERELOAD_SCRIPT : '')
    .replace(
      '{{redocBody}}',
      `<div id="redoc_container"></div>
    <script src="${redocURL}"></script>
    <script>
      ${redocExport}.init(
        './openapi.json',
        ${JSON.stringify(redocConfig)},
        document.getElementById("redoc_container")
      );
    </script>`
    );
};

exports.indexMiddleware = function(req, res) {
  try {
    const page = exports.compileIndexPage({ livereload: true });
    res.end(page);
  } catch (e) {
    console.log(chalk.red(e.message));
    res.writeHead(500, {
      'Content-Type': 'text/html; charset=utf-8'
    });
    res.end(`<div style="color: red"><h3> Error </h3><pre>${e.message}</pre></div>`);
  }
};

exports.swaggerEditorMiddleware = function(options = {}) {
  const router = express.Router();

  const { mainFile } = calcPaths(options.basedir);

  // router.use('/config/defaults.json', express.static(require.resolve('./editor_config.json')))
  router.get('/', (req, res) => {
    const bundled = exports.bundle({
      skipCodeSamples: true,
      skipHeadersInlining: true,
      skipPlugins: true,
      basedir: options.basedir
    });

    let spec;
    if (_.isEqual(bundled, readYaml(mainFile))) {
      spec = fs.readFileSync(mainFile, 'utf-8');
    } else {
      spec =
        '' +
        '# Note: This API definition is split into multiple files.\n' +
        '# All comments and formatting were lost during the bundle process.\n' +
        '# File formatting may be lost on save.\n' +
        exports.stringify(bundled, { yaml: true });
    }

    const fileContents = fs.readFileSync(Path.join(__dirname, 'editor.html'), 'utf-8');
    res.send(fileContents.replace('<%SPEC_CONTENTS%>', JSON.stringify(spec)));
    res.end();
  });

  router.use('/', express.static(Path.dirname(require.resolve('swagger-editor-dist/index.html'))));

  router.use(
    bodyParser.text({
      type: 'application/yaml',
      limit: '10mb' // default limit was '100kb' which is too small for many definitions
    })
  );

  router.put('/backend_openapi.yaml', function(req, res) {
    try {
      exports.syncWithSpec(req.body, options);
    } catch (e) {
      console.log(
        chalk.red('Error while synchronizing definition from Swagger Editor: ' + e.message)
      );
    }
    res.end('ok');
    // TODO: error handling
  });

  return router;
};

exports.getPatchedSwaggerUIIndex = function() {
  const orig = fs.readFileSync(require.resolve('swagger-ui-dist/index.html'), 'utf-8');
  return orig.replace('https://petstore.swagger.io/v2/swagger.json', '../openapi.json');
};

exports.swaggerUiMiddleware = function() {
  const router = express.Router();
  router.get('/', function(req, res) {
    res.end(exports.getPatchedSwaggerUIIndex());
  });
  router.use('/', express.static(Path.dirname(require.resolve('swagger-ui-dist'))));
  return router;
};

exports.specMiddleware = function(options = {}) {
  const router = express.Router();

  router.get('/openapi.json', function(req, res) {
    res.setHeader('Content-Type', 'application/json');
    try {
      res.end(exports.stringify(exports.bundle(options), { json: true }));
    } catch (e) {
      console.log(chalk.red('Error while bundling the API definition: ' + e.message));
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.get('/openapi.yaml', function(req, res) {
    res.setHeader('Content-Type', 'application/yaml');
    res.end(exports.stringify(exports.bundle(options), { yaml: true }));
  });

  router.use(express.static('web'));
  return router;
};

exports.syncWithSpec = function(spec, options = {}) {
  const { pathsDir, definitionsDir, componentsDir, mainFile } = calcPaths(options.basedir);

  if (_.isString(spec)) {
    if (!dirExist(pathsDir) && (!dirExist(definitionsDir) || !dirExist(componentsDir))) {
      // no need to split, just flat file structure
      mkdirp(Path.dirname(mainFile));
      return fs.writeFileSync(mainFile, spec);
    }
    spec = exports.parse(spec);
  }

  if (spec.paths && dirExist(pathsDir)) {
    const paths = _.mapKeys(spec.paths, function(_value, key) {
      return pathToFilename(key);
    });
    updateGlobObject(pathsDir, paths);
    spec = _.omit(spec, 'paths');
  }

  if (spec.openapi) {
    if (spec.components && dirExist(componentsDir)) {
      for (const componentType of OPENAPI3_COMPONENTS) {
        const compDir = Path.join(componentsDir, componentType);
        if (spec.components[componentType]) {
          mkdirp(compDir);
          updateGlobObject(compDir, spec.components[componentType]);
          spec.components = _.omit(spec.components, componentType);
        }
      }
      if (!Object.keys(spec.components).length) {
        spec = _.omit(spec, 'components');
      }
    }
  } else {
    if (spec.definitions && dirExist(definitionsDir)) {
      updateGlobObject(definitionsDir, spec.definitions);
      spec = _.omit(spec, 'definitions');
    }
  }

  updateYaml(mainFile, spec);
};

exports.bundle = function(options = {}) {
  const {
    pathsDir,
    definitionsDir,
    componentsDir,
    mainFile,
    codeSamplesDir,
    pluginsDir
  } = calcPaths(options.basedir);
  const spec = readYaml(options.mainFile || mainFile);

  if (dirExist(pathsDir)) {
    if (options.verbose) {
      console.log('[spec] Adding paths');
    }
    if (spec.paths) {
      throw Error('All paths should be defined inside ' + pathsDir);
    }
    spec.paths = globYamlObject(pathsDir, _.flow([baseName, filenameToPath]));
  }

  if (spec.openapi) {
    if (dirExist(componentsDir)) {
      if (spec.components) {
        throw Error(`All components should be defined inside ${componentsDir}`);
      }
      spec.components = {};

      for (const componentType of OPENAPI3_COMPONENTS) {
        const compDir = Path.join(componentsDir, componentType);
        if (!dirExist(compDir)) {
          continue;
        }
        if (options.verbose) {
          console.log(`[spec] Adding components/${componentType} to spec`);
        }
        spec.components[componentType] = globYamlObject(compDir, baseName);
      }
    }
  } else {
    if (dirExist(definitionsDir)) {
      if (options.verbose) {
        console.log('[spec] Adding definitions');
      }
      if (spec.definitions) {
        throw Error('All definitions should be defined inside ' + definitionsDir);
      }
      spec.definitions = globYamlObject(definitionsDir, baseName);
    }
  }

  if (!options.skipCodeSamples && dirExist(codeSamplesDir)) {
    if (options.verbose) {
      console.log('[spec] Adding code samples');
    }
    bundleCodeSample(spec, codeSamplesDir);
  }

  if (!options.skipHeadersInlining && spec.headers) {
    if (options.verbose) {
      console.log('[spec] Inlining headers referencess');
    }
    inlineHeaders(spec);
  }

  if (!options.skipPlugins) {
    runPlugins(spec, options, pluginsDir);
  }

  return spec;
};

function runPlugins(spec, options, pluginsDir) {
  const relativePluginsDir = process.env.SWAGERREPO_PLUGINS_DIR || pluginsDir;
  pluginsDir = Path.resolve(relativePluginsDir);
  let plugins;

  if (!fs.existsSync(pluginsDir)) {
    return;
  }

  console.log('[spec] Running plugins');
  plugins = requireDir(pluginsDir);

  plugins = _.values(plugins);

  _.each(plugins, function(plugin) {
    plugin.init && plugin.init(spec, options);
    _.each(jpath.nodes(spec, plugin.pathExpression), function(node) {
      const name = _.last(node.path);
      const parent = jpath.value(spec, jpath.stringify(_.dropRight(node.path)));
      plugin.process(parent, name, node.path, spec);
    });
    plugin.finish && plugin.finish(spec);
  });
}

function bundleCodeSample(spec, codeSamplesDir) {
  const codeSamples = globObject(codeSamplesDir, '*/*/*', function(filename) {
    // path === '<language>/<path>/<verb>'
    const dirs = Path.dirname(filename);
    const lang = Path.dirname(dirs);
    const path = Path.basename(dirs);
    // [<path>, <verb>, <language>]
    return [filenameToPath(path), baseName(filename), lang];
  });

  _.each(codeSamples, function(pathSamples, path) {
    _.each(pathSamples, function(opSamples, verb) {
      const operation = _.get(spec.paths, [path, verb]);
      if (_.isUndefined(operation)) {
        throw Error('Code sample for non-existing operation: "' + path + '",' + verb);
      }

      if (_.has(operation, 'x-code-samples')) {
        throw Error('All code samples should be defined inside ' + codeSamplesDir);
      }

      operation['x-code-samples'] = _.map(opSamples, function(path, lang) {
        return { lang: lang, source: fs.readFileSync(path, 'utf-8') };
      });
    });
  });
}

exports.stringify = function(spec, options = {}) {
  if (options.yaml) {
    return YAML.safeDump(spec, { indent: 2, lineWidth: -1, noRefs: true });
  }

  return JSON.stringify(spec, null, 2) + '\n';
};

exports.parse = function(string) {
  try {
    return YAML.safeLoad(string, { json: true });
  } catch (e) {
    throw new Error('Cannot parse OpenAPI file ' + e.message);
  }
};

exports.validate = function(spec, options = {}, cb) {
  if (spec.openapi) {
    const validator = require('oas-validator');
    const validateOptions = { prettify: false, lint: false, validateSchema: 'first' };
    let valid = false;
    const paths = options.mainFile ? { mainFile: options.mainFile } : calcPaths(options.basedir);
    try {
      valid = validator.validateSync(spec, validateOptions);
    } catch (e) {
      if (e instanceof validator.JSONSchemaError) {
        console.error(chalk.red('Failed OpenAPI3 schema validation:\n'));
        const errors = JSON.parse(e.message.replace(/^.*\[/, '['));
        betterErrors(errors, paths);
      } else {
        console.error(chalk.red(`Lint error:\n`));
        e.keyword = '__lint';
        e.dataPath = validateOptions.context.pop() || '';
        if (e.dataPath.startsWith('#')) {
          e.dataPath = e.dataPath.substring(1);
        }
        console.log(e.dataPath);
        betterErrors([e], paths);
      }
      return cb(true, {});
    }
    cb(!valid);
    return;
  }

  sway.create({ definition: spec }).then(
    function(specObj) {
      const result = specObj.validate();

      const isErrors = !_.isEmpty(result.errors);
      const isWarnings = !_.isEmpty(result.warnings);

      if (isErrors) {
        console.error('Validation errors:\n' + JSON.stringify(result.errors, null, 2));
      }

      if (isWarnings) {
        // FIXME: 'discrimanator' doesn't handle properly by sway so ignore warnings
        console.error('Validation warnings:\n' + JSON.stringify(result.warnings, null, 2));
      }

      cb(isErrors);
    },
    function(error) {
      console.error('Validation error:\n' + JSON.stringify(error.message, null, 2));
      cb(true);
    }
  );
};

function inlineHeaders(spec) {
  jpath.apply(spec, '$..[?(@.$ref)]', function(value) {
    if (!value.$ref.startsWith('#/headers')) {
      return value;
    }

    // TODO: throw if (!_.omit(value, '$ref').isEmpty())
    return jsonpointer.get(spec, value.$ref.substring(1));
  });
  delete spec.headers;
}

function baseName(path) {
  return Path.parse(path).name;
}

function filenameToPath(filename) {
  return '/' + filename.replace(/@/g, '/');
}

function globObject(dir, pattern, objectPathCb, supportPathWithDot = false) {
  return _.reduce(
    glob(Path.join(dir, pattern)),
    function(result, path) {
      const objPath = objectPathCb(path.substring(dir.length));
      if (_.has(result, objPath)) {
        throw new Error(objPath + ' definition already exists');
      }
      _.set(result, supportPathWithDot ? [`${objPath}`] : objPath, path);

      return result;
    },
    {}
  );
}

function globYamlObject(dir, objectPathCb) {
  return _.mapValues(globObject(dir, anyYaml, objectPathCb, true), readYaml);
}

function updateGlobObject(dir, object) {
  const knownKeys = globObject(dir, anyYaml, baseName, true);

  _.each(object, function(value, key) {
    let filename = Path.join(dir, key + '.yaml');
    if (key in knownKeys) {
      filename = knownKeys[key];
      delete knownKeys[key];
    }
    updateYaml(filename, value);
  });

  _(knownKeys)
    .values()
    .each(fs.unlinkSync);
}

function updateYaml(file, newData) {
  let currentData;
  try {
    currentData = readYaml(file, true);
  } catch (e) {
    // nope
  }

  if (!_.isEqual(newData, currentData)) {
    saveYaml(file, newData);
  }
}

function readYaml(file, silent) {
  try {
    return YAML.safeLoad(fs.readFileSync(file, 'utf-8'), { filename: file });
  } catch (e) {
    if (!silent) {
      console.log(chalk.red(e.message));
    }
  }
}

function readYamlOrDefault(fileName, defaultVal, defaultMessage) {
  try {
    return YAML.safeLoad(fs.readFileSync(fileName, 'utf-8'), { filename: fileName });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(defaultMessage);
      return defaultVal;
    } else {
      throw e;
    }
  }
}

function readFileOrDefaultFile(fileName, defaultFileName, defaultMessage) {
  try {
    return fs.readFileSync(fileName, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(defaultMessage);
      return fs.readFileSync(defaultFileName, 'utf-8');
    } else {
      throw e;
    }
  }
}

function saveYaml(file, object) {
  mkdirp(Path.dirname(file));
  return fs.writeFileSync(file, YAML.safeDump(object, { noRefs: true }));
}
