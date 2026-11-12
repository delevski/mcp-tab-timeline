// Tiny fictional shop used by the demo and the end-to-end check. The charge API fails twice, then works.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
export function createShop(port = 7100) {
  let charges = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/charge')) {
      charges++;
      const ok = charges > 2;
      return setTimeout(() => { res.writeHead(ok ? 200 : 502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok })); }, ok ? 300 : 1400);
    }
    if (req.url.startsWith('/api/cart')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url.startsWith('/api/reset')) { charges = 0; res.writeHead(200); return res.end('ok'); }
    const f = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
    const p = path.join(dir, f);
    if (!p.startsWith(dir) || !fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(p));
  });
  return { listen: () => new Promise((r) => server.listen(port, '127.0.0.1', r)), close: () => new Promise((r) => server.close(r)) };
}
if (import.meta.url === `file://${process.argv[1]}`) createShop().listen().then(() => console.log('Demo shop on http://127.0.0.1:7100'));
