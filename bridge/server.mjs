#!/usr/bin/env node
// Local bridge: collects agent tool-call events and serves them to the extension.
// Zero dependencies. Listens on 127.0.0.1 only.
import http from 'node:http';

export function createBridge({ port = 7077, host = '127.0.0.1', max = 5000 } = {}) {
  let seq = 0;
  let events = [];
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (url.pathname === '/health') return send(res, 200, { ok: true, count: events.length, seq });
    if (url.pathname === '/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, { seq, events: events.filter((e) => e.seq > since) });
    }
    if (url.pathname === '/events' && req.method === 'DELETE') {
      events = [];
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/event' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const e = JSON.parse(body);
          if (!e || typeof e.tool !== 'string') return send(res, 400, { error: 'tool (string) is required' });
          const item = {
            seq: ++seq,
            t: Number(e.t) || Date.now(),
            tool: e.tool.slice(0, 120),
            args: e.args ?? null,
            dur: e.dur == null ? null : Number(e.dur),
            ok: e.ok !== false,
            error: e.error ? String(e.error).slice(0, 500) : null,
            result: typeof e.result === 'string' ? e.result.slice(0, 600) : e.result ?? null,
            server: e.server ? String(e.server).slice(0, 80) : null,
          };
          events.push(item);
          if (events.length > max) events = events.slice(-max);
          send(res, 201, { seq: item.seq });
        } catch {
          send(res, 400, { error: 'invalid JSON' });
        }
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  });
  return {
    server,
    listen: () => new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok(server.address())); }),
    close: () => new Promise((ok) => server.close(ok)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 7077);
  createBridge({ port }).listen().then(
    () => console.log(`MCP Tab Timeline bridge on http://127.0.0.1:${port}`),
    (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT=...` : e.message); process.exit(1); },
  );
}
