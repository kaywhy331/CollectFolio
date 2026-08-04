import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..', 'app');
const port = Number(process.env.PORT || 4173);
const types = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.webmanifest', 'application/manifest+json'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg']
]);

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let target = resolve(root, `.${pathname}`);
    if (!target.startsWith(`${root}${sep}`) && target !== root) throw new Error('Invalid path');
    try {
      if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      await access(target);
    } catch {
      target = resolve(root, 'index.html');
    }
    response.writeHead(200, { 'Content-Type': types.get(extname(target)) || 'application/octet-stream' });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(400).end('Bad request');
  }
}).listen(port, () => console.log(`CollectFolio dev server: http://localhost:${port}`));
