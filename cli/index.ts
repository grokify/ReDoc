#!/usr/bin/env node
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { ServerStyleSheet } from 'styled-components';
import { createServer, ServerResponse, ServerRequest } from 'http';
import * as zlib from 'zlib';
import { join, dirname } from 'path';
import { compile } from 'handlebars';

// @ts-ignore
import { Redoc, loadAndBundleSpec, createStore } from 'redoc';

import { createReadStream, writeFileSync, ReadStream, readFileSync, watch, existsSync } from 'fs';

import * as yargs from 'yargs';

type Options = {
  ssr?: boolean;
  watch?: boolean;
  cdn?: boolean;
  output?: string;
  title?: string;
  templateFileName?: string;
  redocOptions?: any;
};

const BUNDLES_DIR = dirname(require.resolve('redoc'));

yargs
  .command(
    'serve [spec]',
    'start the server',
    yargs => {
      yargs.positional('spec', {
        describe: 'path or URL to your spec',
      });

      yargs.option('s', {
        alias: 'ssr',
        describe: 'Enable server-side rendering',
        type: 'boolean',
      });

      yargs.option('p', {
        alias: 'port',
        type: 'number',
        default: 8080,
      });

      yargs.option('w', {
        alias: 'watch',
        type: 'boolean',
      });

      yargs.demandOption('spec');
      return yargs;
    },
    async argv => {
      try {
        await serve(argv.port, argv.spec, {
          ssr: argv.ssr,
          watch: argv.watch,
          templateFileName: argv.template,
          redocOptions: argv.options || {},
        });
      } catch (e) {
        console.log(e.stack);
      }
    },
)
  .command(
    'bundle [spec]',
    'bundle spec into zero-dependency HTML-file',
    yargs => {
      yargs.positional('spec', {
        describe: 'path or URL to your spec',
      });

      yargs.option('o', {
        describe: 'Output file',
        alias: 'output',
        type: 'string',
        default: 'redoc-static.html',
      });

      yargs.options('title', {
        describe: 'Page Title',
        type: 'string',
        default: 'ReDoc documentation',
      });

      yargs.option('cdn', {
        describe: 'Do not include ReDoc source code into html page, use link to CDN instead',
        type: 'boolean',
        default: false,
      });

      yargs.demandOption('spec');
      return yargs;
    },
    async argv => {
      try {
        await bundle(argv.spec, {
          ssr: true,
          output: argv.o,
          cdn: argv.cdn,
          title: argv.title,
          templateFileName: argv.template,
          redocOptions: argv.options || {},
        });
      } catch (e) {
        console.log(e.message);
      }
    },
)
  .demandCommand()
  .options('t', {
    alias: 'template',
    describe: 'Path to handlebars page template, see https://git.io/vxZ3V for the example ',
    type: 'string',
  })
  .options('options', {
    describe: 'ReDoc options, use dot notation, e.g. options.nativeScrollbars',
  }).argv;

async function serve(port: number, pathToSpec: string, options: Options = {}) {
  let spec = await loadAndBundleSpec(pathToSpec);
  let pageHTML = await getPageHTML(spec, pathToSpec, options);

  const server = createServer((request, response) => {
    console.time('GET ' + request.url);
    if (request.url === '/redoc.standalone.js') {
      respondWithGzip(
        createReadStream(join(BUNDLES_DIR, 'redoc.standalone.js'), 'utf8'),
        request,
        response,
        {
          'Content-Type': 'application/javascript',
        },
      );
    } else if (request.url === '/') {
      respondWithGzip(pageHTML, request, response);
    } else if (request.url === '/spec.json') {
      const specStr = JSON.stringify(spec, null, 2);
      respondWithGzip(specStr, request, response, {
        'Content-Type': 'application/json',
      });
    } else {
      response.writeHead(404);
      response.write('Not found');
      response.end();
    }

    console.timeEnd('GET ' + request.url);
  });

  console.log();

  server.listen(port, () => console.log(`Server started: http://127.0.0.1:${port}`));

  if (options.watch && existsSync(pathToSpec)) {
    watch(
      pathToSpec,
      debounce(async (event, filename) => {
        if (event === 'change' || (event === 'rename' && existsSync(filename))) {
          console.log(`${pathToSpec} changed, updating docs`);
          try {
            spec = await loadAndBundleSpec(pathToSpec);
            pageHTML = await getPageHTML(spec, pathToSpec, options);
            console.log('Updated successfully');
          } catch (e) {
            console.error('Error while updating: ', e.message);
          }
        }
      }, 2200),
    );
    console.log(`👀  Watching ${pathToSpec} for changes...`);
  }
}

async function bundle(pathToSpec, options: Options = {}) {
  const start = Date.now();
  const spec = await loadAndBundleSpec(pathToSpec);
  const pageHTML = await getPageHTML(spec, pathToSpec, { ...options, ssr: true });

  writeFileSync(options.output!, pageHTML);
  const sizeInKiB = Math.ceil(Buffer.byteLength(pageHTML) / 1024);
  const time = Date.now() - start;
  console.log(
    `\n🎉 bundled successfully in: ${options.output!} (${sizeInKiB} KiB) [⏱ ${time / 1000}s]`,
  );
}

async function getPageHTML(
  spec: any,
  pathToSpec: string,
  { ssr, cdn, title, templateFileName, redocOptions = {} }: Options,
) {
  let html, css, state;
  let redocStandaloneSrc;
  if (ssr) {
    console.log('Prerendering docs');

    const specUrl = redocOptions.specUrl || (isURL(pathToSpec) ? pathToSpec : undefined);
    const store = await createStore(spec, specUrl, redocOptions);
    const sheet = new ServerStyleSheet();
    html = renderToString(sheet.collectStyles(React.createElement(Redoc, { store })));
    css = sheet.getStyleTags();
    state = await store.toJS();

    if (!cdn) {
      redocStandaloneSrc = readFileSync(join(BUNDLES_DIR, 'redoc.standalone.js'));
    }
  }

  templateFileName = templateFileName ? templateFileName : join(__dirname, './template.hbs');
  const template = compile(readFileSync(templateFileName).toString());
  return template({
    redocHTML: `
    <div id="redoc">${(ssr && html) || ''}</div>
    <script>
    ${(ssr && `const __redoc_state = ${JSON.stringify(state)};`) || ''}
    
    var container = document.getElementById('redoc');
    Redoc.${
      ssr
        ? 'hydrate(__redoc_state, container);'
        : `init("spec.json", ${JSON.stringify(redocOptions)}, container)`
      };

    </script>`,
    redocHead: ssr
      ? (cdn
        ? '<script src="https://unpkg.com/redoc@next/bundles/redoc.standalone.js"></script>'
        : `<script>${redocStandaloneSrc}</script>`) + css
      : '<script src="redoc.standalone.js"></script>',
    title: title,
  });
}

// credits: https://stackoverflow.com/a/9238214/1749888
function respondWithGzip(
  contents: string | ReadStream,
  request: ServerRequest,
  response: ServerResponse,
  headers = {},
) {
  let compressedStream;
  const acceptEncoding = (request.headers['accept-encoding'] as string) || '';
  if (acceptEncoding.match(/\bdeflate\b/)) {
    response.writeHead(200, { ...headers, 'content-encoding': 'deflate' });
    compressedStream = zlib.createDeflate();
  } else if (acceptEncoding.match(/\bgzip\b/)) {
    response.writeHead(200, { ...headers, 'content-encoding': 'gzip' });
    compressedStream = zlib.createGzip();
  } else {
    response.writeHead(200, headers);
    if (typeof contents === 'string') {
      response.write(contents);
      response.end();
    } else {
      contents.pipe(response);
    }
    return;
  }

  if (typeof contents === 'string') {
    compressedStream.write(contents);
    compressedStream.pipe(response);
    compressedStream.end();
    return;
  } else {
    contents.pipe(compressedStream).pipe(response);
  }
}

function debounce(callback: Function, time: number) {
  let interval;
  return (...args) => {
    clearTimeout(interval);
    interval = setTimeout(() => {
      interval = null;
      callback(...args);
    }, time);
  };
}

function isURL(str: string): boolean {
  return /^(https?:)\/\//m.test(str);
}
