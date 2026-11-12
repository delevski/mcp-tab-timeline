import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
globalThis.window = globalThis;
await import('../extension/app/insights.js');
const { analyze, stats } = globalThis.MTTInsights;
new Function(fs.readFileSync(new URL('../extension/app/demo.js', import.meta.url), 'utf8'))();
const demo = globalThis.MTT_DEMO[0];

test('demo session yields expected insights', () => {
  const titles = analyze(demo).map((i) => i.title);
  assert.ok(titles.some((t) => t.startsWith('Request failed: 502')));
  assert.ok(titles.some((t) => t.startsWith('Retry loop')));
  assert.ok(titles.some((t) => t.startsWith('Slow tool call: browser_click')));
});
test('stats are consistent', () => {
  const s = stats(demo);
  assert.equal(s.events, demo.events.length);
  assert.equal(s.netFailed, 2);
  assert.equal(s.errors, 3);
});
test('empty session does not throw', () => {
  assert.deepEqual(analyze({ startedAt: 0, events: [] }), []);
  assert.equal(stats({ startedAt: 0, events: [] }).events, 0);
});
