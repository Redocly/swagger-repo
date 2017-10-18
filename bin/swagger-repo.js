#!/usr/bin/env node
'use strict';

var fs = require('fs');

var _ = require('lodash');
var program = require('commander');
var express = require('express');
var cors = require('cors');

var api = require('../');

program.command('bundle')
  .description('Bundles a multi-file Swagger spec')
  .option('-o, --outfile <filename>', 'The output file')
  .option('-b, --basedir <relpath>', 'Base project directory')
  .option('-y, --yaml', 'Output YAML(Default is JSON)')
  .action(function(options) {
    var swagger = api.bundle(options);
    var str = api.stringify(swagger, options);

    if (options.outfile) {
      fs.writeFileSync(options.outfile, str);
      console.log('Created "%s" swagger file.', options.outfile);
    }
    else {
      // Write the bundled spec to stdout
      console.log(str);
    }
  });

program.command('sync-with-swagger')
  .description('Sync single-file Swagger spec with bundle')
  .arguments('<swagger>')
  .action(function(swagger) {
    api.syncWithSwagger(fs.readFileSync(swagger, 'utf-8'));
  });

program.command('validate')
  .description('Validate Swagger file')
  .action(function(filename, options) {
    var swagger = api.bundle();
    api.validate(swagger, function (error, result) {
      var isErrors = !_.isEmpty(result.errors);
      var isWarnings = !_.isEmpty(result.warnings);

      if (isErrors) {
        console.error('Validation errors:\n' +
            JSON.stringify(result.errors, null, 2));
        process.exitCode = 255;
      }

      if (isWarnings) {
        //FIXME: 'discrimanator' doesn't handle properly by sway so ignore warnings
        console.error('Validation warnings:\n' +
            JSON.stringify(result.warnings, null, 2));
      }

    });
  });

program.command('serve')
  .description('Serves a Swagger and some tools via the built-in HTTP server')
  .option('-p, --port <port>', 'The server port number')
  .action(function(filename, options) {
    var app = express();
    app.use(cors());

    app.use('/', api.swaggerFileMiddleware());
    app.use('/swagger-ui', api.swaggerUiMiddleware());
    app.use('/swagger-editor', api.swaggerEditorMiddleware());

    // Error handler
    app.use(function(err, req, res, next) {
        console.error(err.stack);
        res.status(500).json({'error' : err.message});
        next(err);
    });

    // Run server
    app.listen(3000);
  });

program
  .version(require('../package').version)
  .parse(process.argv);

// Show help if no options were given
if (program.rawArgs.length < 3) {
  program.help();
}
