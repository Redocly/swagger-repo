#!/usr/bin/env node
'use strict';

const fs = require('fs-extra');
const path = require('path');
const program = require('commander');
const express = require('express');
const cors = require('cors');
const chalk = require('chalk');
const ghpages = require('gh-pages');

const api = require('../');
const liveReload = require('../lib/livereload');
const { notifyBranchPreviewFromTravis } = require('../lib/travis');

function writeAndLog(filename, contents) {
  fs.writeFileSync(filename, contents);
  console.log(`Created ${chalk.blue(filename)}`);
}

program
  .command('bundle')
  .description('Bundles a multi-file OpenAPI definition')
  .option('-b, --basedir <relpath>', 'The base dir')
  .option('-o, --outfile <filename>', 'The output file')
  .option('-y, --yaml', 'Output YAML(Default is JSON)')
  .action(function(options) {
    const spec = api.bundle({ ...options, verbose: true });
    const str = api.stringify(spec, options);

    if (options.outfile) {
      fs.writeFileSync(options.outfile, str);
      console.log('Created "%s" openapi file.', options.outfile);
    } else {
      // Write the bundled spec to stdout
      console.log(str);
    }
  });

program
  .command('build')
  .description('Builds the static assets and puts it ')
  .option('-b, --basedir <relpath>', 'The output file')
  .option('-o, --outdir <dirname>', 'The output directory, web_deploy by default')
  .action(function(options) {
    const config = api.readConfig();

    const spec = api.bundle({ ...options, verbose: true });
    const json = api.stringify(spec);
    const yaml = api.stringify(spec, { yaml: true });
    const html = api.compileIndexPage();

    const outDir = options.outdir || 'web_deploy';
    fs.removeSync(outDir);
    fs.mkdirpSync(outDir);
    fs.copySync('web/', outDir, {
      filter: filename => !filename.endsWith('redoc-config.yaml')
    });
    console.log(`Copied ${chalk.blue('/web')} to ${chalk.blue(outDir)}`);
    if (config.swaggerUI) {
      fs.copySync(
        path.dirname(require.resolve('swagger-ui-dist')),
        path.join(outDir, 'swagger-ui')
      );
      fs.writeFileSync(
        path.join(outDir, 'swagger-ui', 'index.html'),
        api.getPatchedSwaggerUIIndex()
      );
      console.log(`Copied Swagger UI to ${chalk.blue(path.join(outDir, 'swagger-ui'))}`);
    }
    writeAndLog(path.join(outDir, 'openapi.json'), json);
    writeAndLog(path.join(outDir, 'openapi.yaml'), yaml);
    writeAndLog(path.join(outDir, 'index.html'), html);
  });

program
  .command('gh-pages')
  .description('Deploys to the gh-pages branch')
  .option('-c, --clean', 'Do not preserve existing files (will remove previews)')
  .option('-p, --preview <name>', 'Deploy as preview')
  .action(function(options) {
    console.log('Deploying... It may take a few minutes');
    fs.removeSync(path.join(require.resolve('gh-pages'), '../../.cache'));

    let publishOpts = {
      add: !options.clean
      // push: false
    };

    if (options.preview) {
      publishOpts.dest = 'preview/' + options.preview;
    }

    if (process.env.TRAVIS) {
      if (!process.env.GH_TOKEN) {
        console.log('You have to set GH_TOKEN environment variable when deploying from Travis CI');
        process.exit(1);
      }

      publishOpts = {
        ...publishOpts,
        silent: true,
        message: 'Deployed to Github Pages',
        user: 'Travis-CI',
        email: 'travis@travis',
        repo:
          'https://' + process.env.GH_TOKEN + '@github.com/' + process.env.TRAVIS_REPO_SLUG + '.git'
      };
    }

    ghpages.publish('web_deploy', publishOpts, async function(err) {
      if (err) {
        console.log(chalk.red('Deploy failed: ') + err);
        process.exit(1);
      }
      console.log(chalk.green('🎉  Deployed successfully!'));
      if (options.preview && process.env.TRAVIS_BRANCH) {
        await notifyBranchPreviewFromTravis(process.env.TRAVIS_BRANCH, process.env.TRAVIS_COMMIT);
        console.log('Set Preview status on GitHub');
      }
    });
  });

program
  .command('sync-with-spec')
  .description('Sync single-file OpenAPI definition with bundle')
  .option('-b, --basedir <relpath>', 'The output file')
  .arguments('<spec>')
  .action(function(spec, options) {
    api.syncWithSpec(fs.readFileSync(spec, 'utf-8'), options);
  });

program
  .command('validate [file]')
  .description('Validate OpenAPI file')
  .option('-b, --basedir <relpath>', 'The output file')
  .action(function(file, options) {
    const spec = api.bundle({...options, mainFile: file});
    console.log('Validating definition...');
    api.validate(spec, {...options, mainFile: file}, function(error) {
      if (error) {
        process.exit(255);
        return;
      }
      console.log('OK');
    });
  });

program
  .command('serve')
  .description('Serves a OpenAPI and some tools via the built-in HTTP server')
  .option('-p, --port <port>', 'The server port number')
  .option('-b, --basedir <relpath>', 'The output file')
  .option('--validate', 'Validate definition on each change')
  .action(function(options) {
    const config = api.readConfig();

    const app = express();
    app.use(cors());

    app.get('/', api.indexMiddleware);
    app.use('/', api.specMiddleware(options));

    if (config.swaggerUI) {
      app.use('/swagger-ui', api.swaggerUiMiddleware(options));
    }

    app.use('/swagger-editor', api.swaggerEditorMiddleware(options));

    // Error handler
    app.use(function(err, req, res, next) {
      console.error(err.stack);
      res.status(500).json({ error: err.message });
      next(err);
    });

    // Run server
    const port = options.port || 8080;
    app.listen(port);

    liveReload.startLiveReload(options, () => {
      if (options.validate) {
        api.validate(api.bundle(options), options, err => {
          if (err) console.log();
        });
      }
    });

    const baseUrl = 'http://localhost:' + port;

    console.log('\nDevelopment server started 🎉 :\n');
    console.log(
      `  ${chalk.green('✔')} Documentation (ReDoc):\t${chalk.blue(chalk.underline(baseUrl))}`
    );
    if (config.swaggerUI) {
      console.log(
        `  ${chalk.green('✔')} Documentation (SwaggerUI):\t${chalk.blue(
          chalk.underline(baseUrl + '/swagger-ui/')
        )}`
      );
    }
    console.log(
      `  ${chalk.green('✔')} Swagger Editor: \t\t${chalk.blue(
        chalk.underline(baseUrl + '/swagger-editor/')
      )}`
    );
    console.log();
    console.log('Watching changes...');
  });

program.version(require('../package').version).parse(process.argv);

// Show help if no options were given
if (program.rawArgs.length < 3) {
  program.help();
}
