import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(resolve(root, 'ui/studio.html'), 'utf8');
const engine = readFileSync(resolve(root, 'ui/engine.js'), 'utf8');
const marker = '<!-- PORTRAIT_STUDIO_ENGINE -->';

if (!template.includes(marker))
  throw new Error('Portrait Studio UI template is invalid.');

const html = template.replace(marker, engine);
const server = createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  if (request.method !== 'GET' || path !== '/') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff'
  }).end(html);
});

server.listen(4173, '127.0.0.1', () => {
  process.stderr.write('Portrait Studio preview: http://127.0.0.1:4173\n');
});
