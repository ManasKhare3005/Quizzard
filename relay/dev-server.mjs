// Local relay for testing and demos: the real handler on an in-memory store, plus public/.
// Run: node dev-server.mjs [--demo]   (PORT defaults to 8787). Data is lost when it stops.
// --demo preloads a demo group with a month of finished rounds and prints its scorecard link.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './api/index.js';
import { createMemoryStore } from './lib/db.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const store = createMemoryStore();
const api = createHandler(async () => store);
const port = Number(process.env.PORT || 8787);
if (process.argv.includes('--demo')) {
  const { seedDemo } = await import('./demo-seed.mjs');
  const d = await seedDemo(store);
  console.log(`demo scorecard: http://localhost:${port}/scorecard.html#c=${d.code}&v=${d.viewKey}&m=${d.month}`);
}

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (p === '/api' || p.startsWith('/api/')) return api(req, res);
  const file = path.join(PUBLIC, path.normalize(p === '/' ? '/index.html' : p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`quizzard dev relay on http://localhost:${port}`));
