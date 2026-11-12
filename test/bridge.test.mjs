import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/server.mjs';

test('bridge stores and serves events', async () => {
  const b = createBridge({ port: 0 });
  const addr = await b.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  let r = await fetch(`${base}/event`, { method: 'POST', body: JSON.stringify({ tool: 'browser_click', args: { ref: 'e5' }, dur: 120 }) });
  assert.equal(r.status, 201);
  r = await fetch(`${base}/event`, { method: 'POST', body: '{"nope":1}' });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/event`, { method: 'POST', body: 'not json' });
  assert.equal(r.status, 400);
  const j = await (await fetch(`${base}/events?since=0`)).json();
  assert.equal(j.events.length, 1);
  assert.equal(j.events[0].tool, 'browser_click');
  const none = await (await fetch(`${base}/events?since=1`)).json();
  assert.equal(none.events.length, 0);
  await fetch(`${base}/events`, { method: 'DELETE' });
  assert.equal((await (await fetch(`${base}/health`)).json()).count, 0);
  await b.close();
});
