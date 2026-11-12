// Service worker: owns recording state, storage, network capture, bridge polling, replay driver.
const BRIDGE = 'http://127.0.0.1:7077';
const MAX_EVENTS = 1500;
const MAX_SHOTS = 60;

chrome.runtime.onInstalled.addListener(() => chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}));
chrome.runtime.onStartup.addListener(() => chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}));

let rec = null; // { session, tabId, bridgeSeq, reqStart: {}, shots }
let flushTimer = null;
let pollTimer = null;
let shotTimer = null;
let lastShotAt = 0;
let loaded = false;

const uid = () => Math.random().toString(36).slice(2, 10);

async function load() {
  if (loaded) return;
  loaded = true;
  const { recording } = await chrome.storage.local.get('recording');
  if (recording) { rec = { ...recording, reqStart: {} }; startPolling(); }
}
function flush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    if (!rec) return;
    await chrome.storage.local.set({ ['session:' + rec.session.id]: rec.session, recording: { session: rec.session, tabId: rec.tabId, bridgeSeq: rec.bridgeSeq, shots: rec.shots } });
  }, 400);
}
async function index() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith('session:')).map((k) => all[k]).sort((a, b) => b.startedAt - a.startedAt);
}
function add(ev) {
  if (!rec || rec.session.events.length >= MAX_EVENTS) return null;
  const e = { id: uid(), status: 'ok', ...ev };
  rec.session.events.push(e);
  flush();
  return e;
}
async function shotFor(e) {
  if (!rec || !e || rec.shots >= MAX_SHOTS) return;
  clearTimeout(shotTimer);
  const wait = Math.max(600, 700 - (Date.now() - lastShotAt));
  shotTimer = setTimeout(async () => {
    try {
      const tab = await chrome.tabs.get(rec.tabId);
      if (!tab.active) return;
      lastShotAt = Date.now();
      e.shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 35 });
      rec.shots++;
      flush();
    } catch { /* tab hidden or not capturable */ }
  }, wait);
}

async function pollBridge() {
  if (!rec) return;
  try {
    const r = await fetch(`${BRIDGE}/events?since=${rec.bridgeSeq || 0}`, { signal: AbortSignal.timeout(1200) });
    const j = await r.json();
    rec.bridgeSeq = j.seq;
    for (const b of j.events) {
      if (b.t + (b.dur || 0) < rec.session.startedAt - 500) continue;
      add({ t: b.t, lane: 'agent', type: 'tool_call', title: b.tool, dur: b.dur, status: b.ok ? 'ok' : 'error', detail: { args: b.args, result: b.result, error: b.error, server: b.server } });
    }
    rec.session.bridge = true;
  } catch { if (rec) rec.session.bridge = false; }
}
function startPolling() { clearInterval(pollTimer); pollTimer = setInterval(pollBridge, 1000); }

async function start(tabId) {
  if (rec) throw new Error('Already recording. Stop the current recording first.');
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:|^file:/.test(tab.url || '')) throw new Error('This tab cannot be recorded (only http, https and file pages).');
  const session = { id: uid(), name: new URL(tab.url).host || 'Recording', startedAt: Date.now(), endedAt: null, url: tab.url, events: [], bridge: false, source: 'recording' };
  rec = { session, tabId, bridgeSeq: 0, reqStart: {}, shots: 0 };
  let seq = 0;
  try { seq = (await (await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(800) })).json()).seq || 0; session.bridge = true; } catch { /* bridge optional */ }
  rec.bridgeSeq = seq;
  const e = add({ t: Date.now(), lane: 'page', type: 'navigate', title: 'Recording started', detail: { url: tab.url } });
  shotFor(e);
  startPolling();
  await chrome.storage.local.set({ recording: { session, tabId, bridgeSeq: seq, shots: 0 }, ['session:' + session.id]: session });
  return session;
}
async function stop() {
  if (!rec) throw new Error('Not recording.');
  await pollBridge();
  clearInterval(pollTimer);
  rec.session.endedAt = Date.now();
  rec.session.events.sort((a, b) => a.t - b.t);
  const s = rec.session;
  await chrome.storage.local.set({ ['session:' + s.id]: s });
  await chrome.storage.local.remove('recording');
  rec = null;
  return s;
}

// ---- page, tab, network capture ----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await load();
    switch (msg.cmd) {
      case 'page-event': {
        if (!rec || sender.tab?.id !== rec.tabId) return reply({ ok: false });
        const ev = msg.event;
        const title = { click: 'Click', input: 'Type', submit: 'Submit form', scroll: 'Scroll', 'console.error': 'Console error', 'console.warn': 'Console warning', exception: 'Uncaught exception', rejection: 'Unhandled rejection' }[ev.type] || ev.type;
        const isErr = ['console.error', 'exception', 'rejection'].includes(ev.type);
        const lane = ['console.error', 'console.warn', 'exception', 'rejection'].includes(ev.type) ? 'console' : 'page';
        const e = add({ t: ev.t, lane, type: ev.type, title: `${title}${ev.label && lane === 'page' ? ': ' + ev.label : ''}`, status: isErr ? 'error' : 'ok', detail: { selector: ev.selector, label: ev.label, value: ev.value, masked: ev.masked, x: ev.x, y: ev.y, url: ev.url } });
        if (e && (ev.type === 'click' || ev.type === 'submit')) shotFor(e);
        return reply({ ok: true });
      }
      case 'status': return reply({ ok: true, recording: rec ? { id: rec.session.id, tabId: rec.tabId, startedAt: rec.session.startedAt, count: rec.session.events.length, bridge: !!rec.session.bridge, name: rec.session.name } : null });
      case 'start': return reply({ ok: true, session: await start(msg.tabId) });
      case 'stop': return reply({ ok: true, session: await stop() });
      case 'list': return reply({ ok: true, sessions: (await index()).map(({ events, ...s }) => ({ ...s, count: events.length, errors: events.filter((e) => e.status === 'error').length })) });
      case 'get': {
        if (rec && rec.session.id === msg.id) return reply({ ok: true, session: rec.session });
        const o = await chrome.storage.local.get('session:' + msg.id);
        const s = o['session:' + msg.id];
        return s ? reply({ ok: true, session: s }) : reply({ ok: false, error: 'Session not found' });
      }
      case 'delete': if (rec && rec.session.id === msg.id) throw new Error('Stop recording before deleting.'); await chrome.storage.local.remove('session:' + msg.id); return reply({ ok: true });
      case 'import': { const s = msg.session; s.id = uid(); s.source = 'imported'; await chrome.storage.local.set({ ['session:' + s.id]: s }); return reply({ ok: true, session: s }); }
      case 'tabs': { const tabs = await chrome.tabs.query({}); return reply({ ok: true, tabs: tabs.filter((t) => /^https?:|^file:/.test(t.url || '')).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) }); }
      case 'bridge': try { const j = await (await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(1000) })).json(); return reply({ ok: true, bridge: j }); } catch { return reply({ ok: true, bridge: null }); }
      case 'replay-step': {
        const { tabId, step } = msg;
        if (step.type === 'navigate') { await chrome.tabs.update(tabId, { url: step.detail.url }); await new Promise((r) => setTimeout(r, 1200)); return reply({ ok: true }); }
        const r = await chrome.tabs.sendMessage(tabId, { cmd: 'replay-step', step: { type: step.type, ...step.detail } });
        return reply(r || { ok: false, error: 'No response from page. Reload the tab once.' });
      }
      default: return reply({ ok: false, error: 'Unknown command' });
    }
  })().catch((e) => reply({ ok: false, error: String(e.message || e) }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!rec || tabId !== rec.tabId || !info.url) return;
  const last = [...rec.session.events].reverse().find((e) => e.type === 'navigate');
  if (last && last.detail.url === info.url) return;
  const e = add({ t: Date.now(), lane: 'page', type: 'navigate', title: 'Navigate: ' + safeHost(info.url), detail: { url: info.url } });
  shotFor(e);
});
const safeHost = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } };

const NET_TYPES = ['xmlhttprequest', 'main_frame', 'sub_frame', 'other'];
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (rec && d.tabId === rec.tabId && NET_TYPES.includes(d.type)) rec.reqStart[d.requestId] = Date.now();
}, { urls: ['<all_urls>'] });
function netDone(d, failed) {
  if (!rec || d.tabId !== rec.tabId || !(d.requestId in rec.reqStart)) return;
  if (d.url.startsWith(BRIDGE)) return;
  const t0 = rec.reqStart[d.requestId];
  delete rec.reqStart[d.requestId];
  const bad = failed || d.statusCode >= 400;
  add({ t: t0, dur: Date.now() - t0, lane: 'network', type: 'request', title: `${d.method} ${safeHost(d.url)}`, status: bad ? 'error' : 'ok', detail: { url: d.url, method: d.method, statusCode: d.statusCode || null, error: failed ? d.error : null, resourceType: d.type } });
}
chrome.webRequest.onCompleted.addListener((d) => netDone(d, false), { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener((d) => netDone(d, true), { urls: ['<all_urls>'] });

load();
