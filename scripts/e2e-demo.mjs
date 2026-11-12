// End-to-end check and demo recorder: real extension, real bridge, real mcp-tap, fictional shop.
// VIDEO=/path/out.webm records the extension UI while an "agent" works in the shop tab.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createBridge } from '../bridge/server.mjs';
import { createShop } from '../examples/demo-shop/server.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VIDEO = process.env.VIDEO;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bridge = createBridge({ port: 7077 }); await bridge.listen();
const shop = createShop(7100); await shop.listen();

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: true, pipe: true, enableExtensions: [`${root}/extension`],
  args: ['--no-sandbox', '--window-size=1280,860'],
  defaultViewport: { width: 1280, height: 800 },
});
const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
const extId = new URL(sw.url()).host;
const cdp = await browser.target().createCDPSession();
const mk = async (url) => { const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: true, width: 1280, height: 800 }); const t = await browser.waitForTarget((x) => x._targetId === targetId); return t.page(); };
const shopPage = await mk('http://127.0.0.1:7100/');
await shopPage.setViewport({ width: 1000, height: 700 });
const app = await mk(`chrome-extension://${extId}/app/index.html`);
await app.setViewport({ width: 1280, height: 800 });
await sleep(800);

let rec;
const frames = []; let recording = !!VIDEO;
if (VIDEO) (async () => { while (recording) { try { const t = Date.now(); frames.push({ t, buf: await app.screenshot({ type: 'jpeg', quality: 80 }) }); } catch { /* page busy */ } await sleep(60); } })();
const caption = (t) => app.evaluate((t) => { let d = document.getElementById('cap'); if (!d) { d = document.createElement('div'); d.id = 'cap'; d.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#000c;color:#fff;padding:10px 18px;border-radius:10px;font:600 16px system-ui;z-index:99;border:1px solid #6366f1;max-width:80%;text-align:center'; document.body.appendChild(d); } d.textContent = t; d.style.display = t ? 'block' : 'none'; }, t);
const step = async (t, ms) => { console.log("STEP", t.slice(0,40)); await caption(t); await sleep(ms); };

await step('MCP Tab Timeline: record what a coding agent does in a browser tab', 2500);
await app.click('[data-act=refreshtabs]'); await sleep(700);
const shopTabId = await app.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.startsWith('http://127.0.0.1:7100')).id);
await app.select('#tabsel', String(shopTabId));
await step('1. Pick the tab the agent is working in. Press Record.', 1800);
await app.click('[data-act=record]'); await sleep(900);
if (!(await app.$('[data-act=stop]'))) throw new Error('recording did not start');

// agent side: JSON-RPC through mcp-tap in front of the mini browser MCP
const acts = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c; const { tool, args } = JSON.parse(b);
  let ok = true, text = 'done';
  try {
    if (tool === 'browser_navigate') await shopPage.goto(args.url);
    else if (tool === 'browser_click') { const sel = { 'Add to cart': '#add', 'Pay now': '#pay' }[args.element]; if (!sel) throw new Error(`Element not found: ${args.element}`); await shopPage.click(sel); await sleep(250); }
    else if (tool === 'browser_type') { await shopPage.type(args.element === 'Email' ? '#email' : '#card', args.text, { delay: 25 }); }
    else if (tool === 'browser_wait_for') await sleep(args.time * 1000);
  } catch (e) { ok = false; text = e.message; }
  res.writeHead(200); res.end(JSON.stringify({ ok, text }));
}).listen(7099, '127.0.0.1');
const proxy = spawn('node', [`${root}/bridge/mcp-tap.mjs`, '--', 'node', `${root}/examples/mini-browser-mcp.mjs`], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiters = new Map(); let id = 0;
proxy.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => { const m = JSON.parse(l); waiters.get(m.id)?.(m); }));
const rpc = (method, params) => new Promise((r) => { const i = ++id; waiters.set(i, r); proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return r; };
await rpc('initialize', {});

await caption('2. The agent works. Every tool call, click, request and console error lands on the timeline.');
await call('browser_navigate', { url: 'http://127.0.0.1:7100/' }); await sleep(800);
await call('browser_click', { element: 'Add to cart' }); await sleep(900);
await call('browser_type', { element: 'Email', text: 'demo.user@example.test' }); await sleep(900);
await call('browser_type', { element: 'Card number', text: '4111111111111111' }); await sleep(900);
await call('browser_click', { element: 'Place order' }); await sleep(900);   // tool error: wrong element name
await call('browser_click', { element: 'Pay now' }); await sleep(1200);     // 502
await call('browser_wait_for', { time: 2 }); await sleep(500);
await call('browser_click', { element: 'Pay now' }); await sleep(1200);     // 502 again
await call('browser_click', { element: 'Pay now' }); await sleep(1500);     // works
await sleep(1500);
await step('3. Press Stop. The session is saved.', 1500);
await app.click('[data-act=stop]'); await sleep(1800);
const stats = await app.evaluate(() => { const s = window.__mtt.S.sel; const c = {}; s.events.forEach((e) => (c[e.lane] = (c[e.lane] || 0) + 1)); return { lanes: c, errors: s.events.filter((e) => e.status === 'error').length, shots: s.events.filter((e) => e.shot).length, bridge: s.bridge }; });
console.log('RECORDED', JSON.stringify(stats));
await step('4. The timeline shows agent calls, page actions, network and console on one clock.', 4500);
await app.click('[data-act=view][data-v=insights]'); await sleep(600);
await step('5. Insights flag the failed charge, the console error, the retry loop and the slow calls.', 5500);
await app.click('[data-act=view][data-v=timeline]'); await sleep(900);
await app.click('[data-act=play]');
await step('6. Replay the session. The playhead follows the agent, with screenshots.', 6500);
await app.click('[data-act=play]'); await sleep(400);
await shopPage.bringToFront?.().catch(() => {}); await app.bringToFront();
await fetch('http://127.0.0.1:7100/api/reset');
await app.click('[data-act=replaytab]');
await step('7. Or replay the actions in the real tab, step by step.', 9000);
for (let i = 0; i < 30 && (await app.$('[data-act=abort]')); i++) await sleep(1000);
await sleep(1500);
const finalUrl = shopPage.url();
console.log('REPLAY final url', finalUrl);
await step('Open source, free, local only. github.com/delevski/mcp-tab-timeline', 3500);
recording = false; await sleep(300);
if (VIDEO) { const fs = await import('node:fs'); const dir = VIDEO + '.frames'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  let list = ''; frames.forEach((f, i) => { const n = `${dir}/f${String(i).padStart(5, '0')}.jpg`; fs.writeFileSync(n, f.buf); const d = i < frames.length - 1 ? (frames[i + 1].t - f.t) / 1000 : 0.5; list += `file '${n}'\nduration ${d.toFixed(3)}\n`; });
  list += `file '${dir}/f${String(frames.length - 1).padStart(5, '0')}.jpg'\n`; fs.writeFileSync(VIDEO + '.txt', list); console.log('frames', frames.length); }
const toast = await app.evaluate(() => document.querySelector('.toast')?.innerText || '');
console.log('toast:', toast);
proxy.kill(); acts.close(); await browser.close(); await bridge.close(); await shop.close();
