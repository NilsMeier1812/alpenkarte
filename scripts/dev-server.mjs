// Lokaler Entwicklungsserver: liefert die statischen Dateien aus und bedient
// /api/tiles mit derselben Funktion, die später bei Vercel läuft.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/tiles.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/tiles') {
    try {
      await handler(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  const pfad = url.pathname === '/' ? '/index.html' : url.pathname;
  const datei = join(ROOT, normalize(pfad).replace(/^(\.\.[/\\])+/, ''));
  try {
    const inhalt = await readFile(datei);
    res.writeHead(200, { 'Content-Type': TYPES[extname(datei)] || 'application/octet-stream' });
    res.end(inhalt);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nicht gefunden');
  }
}).listen(PORT, () => console.log(`Alpenkarte läuft auf http://localhost:${PORT}`));
