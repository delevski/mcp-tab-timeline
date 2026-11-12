(() => {
  const I = window.MTTInsights;
  const isExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id && !!chrome.storage;
  const LANES = [['agent', 'Agent', '#60a5fa'], ['page', 'Page', '#34d399'], ['network', 'Network', '#fbbf24'], ['console', 'Console', '#f472b6']];
  const LC = Object.fromEntries(LANES.map((l) => [l[0], l[2]]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = document.getElementById('app');

  const S = {
    sessions: [], sel: null, view: 'timeline', lanes: { agent: true, page: true, network: true, console: true }, zoom: 1,
    ph: 0, playing: false, speed: 1, evId: null, loading: null, error: null, rec: null, tabs: [], tabId: null, busy: {}, toast: null,
    bridge: null, animate: true, sim: null, replay: null, now: Date.now(),
  };

  // ---------- backend (extension or demo) ----------
  const ext = (msg) => new Promise((res, rej) => chrome.runtime.sendMessage(msg, (r) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    if (!r || !r.ok) return rej(new Error((r && r.error) || 'Request failed'));
    res(r);
  }));
  const demoStore = { sessions: window.MTT_DEMO.map((s) => ({ ...s })) };
  const api = {
    async list() { if (isExt) return (await ext({ cmd: 'list' })).sessions; return demoStore.sessions.map((s) => ({ ...s, events: undefined, count: s.events.length, errors: s.events.filter((e) => e.status === 'error').length })); },
    async get(id) { if (isExt) return (await ext({ cmd: 'get', id })).session; const s = demoStore.sessions.find((x) => x.id === id); if (!s) throw new Error('Session not found'); return s; },
    async del(id) { if (isExt) return ext({ cmd: 'delete', id }); demoStore.sessions = demoStore.sessions.filter((s) => s.id !== id); },
    async imp(session) { if (isExt) return (await ext({ cmd: 'import', session })).session; session.id = 'imp-' + Math.random().toString(36).slice(2, 8); session.source = 'imported'; demoStore.sessions.unshift(session); return session; },
  };

  // ---------- helpers ----------
  const fmt = I.fmt;
  const dur = () => Math.max(1000, I.stats(S.sel).duration);
  const rel = (e) => e.t - S.sel.startedAt;
  function toast(msg, opts = {}) { S.toast = { msg, ...opts }; render(); clearTimeout(toast.t); if (!opts.retry) toast.t = setTimeout(() => { S.toast = null; render(); }, 3500); }
  async function guard(key, fn, { retryLabel } = {}) {
    if (S.busy[key]) return;
    S.busy[key] = true; render();
    try { await fn(); S.error = null; }
    catch (e) { toast(`${retryLabel || 'Action'} failed: ${e.message}`, { err: true, retry: () => guard(key, fn, { retryLabel }) }); }
    finally { S.busy[key] = false; render(); }
  }
  const anyBusy = () => Object.values(S.busy).some(Boolean);

  async function refreshList(keep) {
    S.sessions = await api.list();
    if (!keep && !S.sel && S.sessions.length) await open(S.sessions[0].id, true);
  }
  async function open(id, quiet) {
    S.loading = 'Loading session'; if (!quiet) render();
    try { S.sel = await api.get(id); S.ph = 0; S.evId = null; S.animate = true; S.zoom = 1; S.playing = false; }
    finally { S.loading = null; }
  }
  async function init() {
    S.loading = 'Loading'; render();
    try {
      await refreshList();
      if (isExt) { await refreshStatus(); await refreshTabs(); }
    } catch (e) { S.error = e.message; }
    S.loading = null; render();
    if (isExt) setInterval(tick, 1000);
  }
  async function refreshStatus() {
    const r = await ext({ cmd: 'status' }); S.rec = r.recording;
    S.bridge = (await ext({ cmd: 'bridge' })).bridge;
  }
  async function refreshTabs() {
    const me = await chrome.tabs.getCurrent?.().catch(() => null);
    const t = (await ext({ cmd: 'tabs' })).tabs;
    S.tabs = t; if (!S.tabId || !t.find((x) => x.id === S.tabId)) { const a = t.find((x) => x.active && (!me || x.id !== me.id)) || t[0]; S.tabId = a ? a.id : null; }
  }
  async function tick() {
    if (anyBusy() || S.replay) return;
    try {
      await refreshStatus();
      if (S.rec) { S.sel = await api.get(S.rec.id); S.sessions = await api.list(); S.animate = false; render(); }
      else if (S.sel && S.sel.endedAt === null) { await refreshList(true); S.sel = await api.get(S.sel.id); render(); }
    } catch { /* transient, next tick retries */ }
  }

  // ---------- actions ----------
  const actions = {
    open: (el) => guard('open', () => open(el.dataset.id), { retryLabel: 'Open session' }),
    view: (el) => guard('view', async () => { S.loading = 'Switching view'; render(); await sleep(220); S.view = el.dataset.v; S.loading = null; S.animate = true; }),
    lane: (el) => { S.lanes[el.dataset.l] = !S.lanes[el.dataset.l]; S.animate = false; render(); },
    zoom: (el) => { const z = el.dataset.z; S.zoom = z === 'fit' ? 1 : Math.min(12, Math.max(1, S.zoom * (z === 'in' ? 1.6 : 1 / 1.6))); S.animate = false; render(); },
    pick: (el) => select(el.dataset.id, true),
    play: () => { if (S.playing) { S.playing = false; render(); return; } if (S.ph >= dur()) S.ph = 0; S.playing = true; render(); last = performance.now(); requestAnimationFrame(loop); },
    speed: () => { S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1; render(); },
    jump: (el) => { S.view = 'timeline'; S.animate = false; select(el.dataset.id, true); },
    export: () => { const blob = new Blob([JSON.stringify(S.sel, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mcp-tab-timeline-${S.sel.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('Exported JSON'); },
    copyjson: () => copy(JSON.stringify(currentEvent(), null, 2), 'Event JSON copied'),
    repro: () => copy(reproText(), 'Repro steps copied'),
    del: () => { const id = S.sel.id; if (!confirmDelete()) return; return guard('del', async () => { await api.del(id); S.sel = null; await refreshList(); S.view = 'timeline'; toast('Session deleted'); }, { retryLabel: 'Delete' }); },
    import: () => document.getElementById('file').click(),
    demo: () => guard('demo', async () => { const d = window.MTT_DEMO[0]; if (!S.sessions.find((s) => s.id === d.id)) { demoStore.sessions = [{ ...d }, ...demoStore.sessions.filter((s) => s.id !== d.id)]; if (isExt) await api.imp(JSON.parse(JSON.stringify(d))); } await refreshList(true); const id = isExt ? S.sessions[0].id : d.id; await open(id, true); }, { retryLabel: 'Load demo' }),
    record: () => guard('record', async () => {
      if (!isExt) return startSim();
      if (!S.tabId) throw new Error('No recordable tab found. Open a web page first.');
      await ext({ cmd: 'start', tabId: S.tabId }); await refreshStatus(); await refreshList(true); S.sel = await api.get(S.rec.id); S.view = 'timeline'; S.animate = false;
    }, { retryLabel: 'Start recording' }),
    stop: () => guard('stop', async () => {
      if (!isExt) return stopSim();
      const s = await ext({ cmd: 'stop' }); S.rec = null; await refreshList(true); await open(s.session.id, true); toast('Recording saved');
    }, { retryLabel: 'Stop recording' }),
    replaytab: () => guard('replay', replayInTab, { retryLabel: 'Replay' }),
    abort: () => { if (S.replay) S.replay.abort = true; },
    refreshtabs: () => guard('tabs', async () => { await refreshTabs(); }, { retryLabel: 'Refresh tabs' }),
    dismiss: () => { S.toast = null; render(); },
    retry: () => { const r = S.toast && S.toast.retry; S.toast = null; if (r) r(); else init(); },
  };
  const confirmDelete = () => window.confirm('Delete this session? This cannot be undone.');
  function currentEvent() { return S.sel.events.find((e) => e.id === S.evId) || null; }
  async function copy(text, msg) { try { await navigator.clipboard.writeText(text); toast(msg); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(msg); } catch { toast('Copy blocked by the browser', { err: true }); } ta.remove(); } }
  function reproText() {
    return `Repro steps (${S.sel.name})\n` + [...S.sel.events].sort((a, b) => a.t - b.t).filter((e) => e.lane !== 'network').map((e, i) => `${i + 1}. [${fmt(rel(e))}] ${e.lane}: ${e.title}${e.status === 'error' ? ' (ERROR)' : ''}`).join('\n');
  }
  function select(id, moveHead) {
    S.evId = id; const e = currentEvent();
    if (e && moveHead) { S.ph = Math.min(dur(), Math.max(0, rel(e))); S.playing = false; }
    S.animate = false; render();
  }

  // ---------- playback ----------
  let last = 0;
  function loop(now) {
    if (!S.playing) return;
    S.ph = Math.min(dur(), S.ph + (now - last) * S.speed); last = now;
    const cur = [...S.sel.events].filter((e) => rel(e) <= S.ph).sort((a, b) => a.t - b.t).pop();
    if (cur && cur.id !== S.evId) { S.evId = cur.id; renderDetail(); markRows(); }
    paintHead();
    if (S.ph >= dur()) { S.playing = false; render(); return; }
    requestAnimationFrame(loop);
  }
  function geom() { const W = 1000 * S.zoom; return { W, x: (ms) => 12 + (ms / dur()) * (W - 24) }; }
  function paintHead() {
    const g = geom(), ph = document.getElementById('ph'), sc = document.getElementById('scrub'), tm = document.getElementById('phTime');
    if (ph) { ph.setAttribute('transform', `translate(${g.x(S.ph)},0)`); const box = ph.closest('.scroll'); if (box && S.playing) { const x = g.x(S.ph); if (x < box.scrollLeft + 40 || x > box.scrollLeft + box.clientWidth - 40) box.scrollLeft = x - box.clientWidth / 2; } }
    if (sc) sc.value = S.ph; if (tm) tm.textContent = `${fmt(S.ph)} / ${fmt(dur())}`;
  }
  function markRows() { document.querySelectorAll('[data-id]').forEach((r) => { if (r.classList.contains('row')) r.classList.toggle('sel', r.dataset.id === S.evId); if (r.classList.contains('mk')) r.classList.toggle('sel', r.dataset.id === S.evId); }); }

  // ---------- live simulation (demo page) ----------
  function startSim() {
    const src = window.MTT_DEMO[0];
    const live = { id: 'sim-' + Date.now().toString(36), name: 'Simulated live recording (fictional)', startedAt: src.startedAt, endedAt: null, url: src.url, events: [], bridge: true, source: 'demo' };
    demoStore.sessions.unshift(live); S.sel = live; S.rec = { id: live.id, startedAt: Date.now(), count: 0, bridge: true, name: live.name }; S.view = 'timeline'; S.animate = false; S.ph = 0;
    let el = 0;
    S.sim = setInterval(() => {
      el += 400; const upTo = src.startedAt + el;
      live.events = src.events.filter((e) => e.t <= upTo).map((e) => ({ ...e }));
      S.rec.count = live.events.length; S.ph = Math.min(el, dur());
      if (el >= 24000) return stopSim(true);
      S.animate = false; render();
    }, 100);
  }
  function stopSim(auto) {
    clearInterval(S.sim); S.sim = null;
    const live = S.sel; live.endedAt = live.startedAt + 24000; S.rec = null; S.ph = 0;
    api.list().then((l) => { S.sessions = l; if (!auto) toast('Recording saved'); else toast('Simulation finished. Press play to replay it.'); });
    S.busy.record = false; S.busy.stop = false; render();
  }

  // ---------- replay in real tab (extension only) ----------
  async function replayInTab() {
    if (!isExt) throw new Error('Replay in tab needs the extension.');
    if (!S.tabId) throw new Error('Pick a tab to replay into.');
    if (S.rec) throw new Error('Stop recording first.');
    const steps = [...S.sel.events].sort((a, b) => a.t - b.t).filter((e) => ['navigate', 'click', 'input', 'submit', 'scroll'].includes(e.type) && !(e.type === 'input' && e.detail.masked));
    if (!steps.length) throw new Error('This session has no page actions to replay.');
    S.replay = { i: 0, n: steps.length, abort: false };
    let prev = steps[0].t;
    for (const [i, s] of steps.entries()) {
      if (S.replay.abort) break;
      S.replay.i = i + 1; S.ph = rel(s); S.evId = s.id; render();
      await sleep(Math.min(1500, Math.max(150, s.t - prev))); prev = s.t;
      if (s.type === 'navigate' && i === 0) { await ext({ cmd: 'replay-step', tabId: S.tabId, step: s }); continue; }
      const r = await ext({ cmd: 'replay-step', tabId: S.tabId, step: s });
      if (r.ok === false) { S.replay = null; throw new Error(r.error || 'Step failed'); }
    }
    const aborted = S.replay && S.replay.abort; S.replay = null;
    toast(aborted ? 'Replay stopped' : 'Replay finished');
  }

  // ---------- rendering ----------
  function header() {
    const rec = S.rec;
    const secs = rec ? Math.floor((S.now - rec.startedAt) / 1000) : 0;
    return `<header>
      <div class="brand"><span class="logo"><i></i><i></i><i></i></span>MCP Tab Timeline ${isExt ? '' : '<span class="demo-tag">live demo, fictional data</span>'}</div>
      ${isExt ? `<select id="tabsel" aria-label="Tab to record" ${rec || S.busy.tabs ? 'disabled' : ''}>${S.tabs.map((t) => `<option value="${t.id}" ${t.id === S.tabId ? 'selected' : ''}>${esc((t.title || t.url).slice(0, 40))}</option>`).join('') || '<option>No web tabs open</option>'}</select>
      <button data-act="refreshtabs" ${rec || S.busy.tabs ? 'disabled' : ''} title="Refresh tab list">Refresh</button>` : ''}
      ${rec ? `<span class="pill"><span class="dot rec"></span>Recording ${isExt ? fmtSecs(secs) : ''} <b class="mono">${rec.count} events</b></span>` : `<span class="pill"><span class="dot"></span>Idle</span>`}
      <span class="pill" title="Local bridge that captures agent tool calls"><span class="dot ${isExt ? (S.bridge ? 'on' : '') : 'on'}"></span>${isExt ? (S.bridge ? 'Bridge connected' : 'Bridge offline (page events only)') : 'Bridge: simulated'}</span>
      ${rec ? `<button class="danger" data-act="stop" ${S.busy.stop ? 'disabled' : ''}>${S.busy.stop ? 'Stopping...' : 'Stop'}</button>` : `<button class="primary" data-act="record" ${S.busy.record ? 'disabled' : ''}>${S.busy.record ? 'Starting...' : isExt ? 'Record tab' : 'Simulate live recording'}</button>`}
    </header>`;
  }
  const fmtSecs = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  function sidebar() {
    return `<aside><h3>Sessions</h3>
      ${S.sessions.map((s) => `<button class="sess ${S.sel && S.sel.id === s.id ? 'sel' : ''}" data-act="open" data-id="${esc(s.id)}" ${anyBusy() ? 'disabled' : ''}>${esc(s.name)}<small>${new Date(s.startedAt).toLocaleString()}</small><small>${s.count} events${s.errors ? `, <span style="color:var(--err)">${s.errors} errors</span>` : ''}</small></button>`).join('') || '<p class="note">No sessions yet.</p>'}
      <button data-act="import" style="width:100%;margin-top:4px" ${S.busy.import ? 'disabled' : ''}>Import JSON</button>
      <input id="file" type="file" accept="application/json,.json" hidden>
      <button data-act="demo" class="ghost" style="width:100%;margin-top:6px" ${S.busy.demo ? 'disabled' : ''}>${S.busy.demo ? 'Loading...' : 'Load demo session'}</button>
    </aside>`;
  }

  function emptyState() {
    return `<div class="card empty"><div style="font-size:34px">&#9201;</div><h2>${S.sessions.length ? 'Pick a session' : 'No recordings yet'}</h2>
      <p>${isExt ? 'Choose a tab above, press Record, then let your coding agent work in it. You get a timeline of every agent tool call, click, request and console error.' : 'This page shows how a recorded agent session looks. Load the demo session or simulate a live recording.'}</p>
      <p><button class="primary" data-act="demo" ${S.busy.demo ? 'disabled' : ''}>Load demo session</button> ${isExt ? '' : `<button data-act="record" ${S.busy.record ? 'disabled' : ''}>Simulate live recording</button>`}</p></div>`;
  }

  function kpis() {
    const s = I.stats(S.sel);
    const k = (v, l, bad) => `<div class="kpi ${bad ? 'bad' : ''}"><b data-count="${v}">${v}</b><span>${l}</span></div>`;
    return `<div class="kpis">${k(s.events, 'events')}${k((s.duration / 1000).toFixed(1) + 's', 'duration')}${k(s.agentCalls, 'agent tool calls')}${k(s.avgTool + 'ms', 'avg tool latency')}${k(s.errors, 'errors', s.errors > 0)}${k(s.netFailed, 'failed requests', s.netFailed > 0)}</div>`;
  }

  function ticks(d, W) {
    const steps = [500, 1000, 2000, 5000, 10000, 30000, 60000]; const want = W / 90; let st = steps.find((s) => d / s <= want) || 60000;
    const g = geom(); let out = '';
    for (let t = 0; t <= d; t += st) out += `<line x1="${g.x(t)}" x2="${g.x(t)}" y1="22" y2="${26 + LANES.length * 46}" stroke="#1b2a47"/><text x="${g.x(t) + 3}" y="16" fill="#8aa0c8" font-size="10">${fmt(t)}</text>`;
    return out;
  }
  function timeline() {
    const g = geom(), d = dur(), W = g.W, H = 26 + LANES.length * 46;
    const active = LANES.filter((l) => S.lanes[l[0]]);
    let rows = '', idx = 0;
    active.forEach(([key, , col], r) => {
      const y = 26 + LANES.findIndex((l) => l[0] === key) * 46;
      rows += `<line x1="0" x2="${W}" y1="${y + 46}" y2="${y + 46}" stroke="#16223b"/>`;
      for (const e of S.sel.events.filter((x) => x.lane === key)) {
        const c = e.status === 'error' ? '#f87171' : col, x = g.x(rel(e)), cls = `mk ${S.animate ? 'pop' : ''} ${e.id === S.evId ? 'sel' : ''}`, delay = S.animate ? `style="animation-delay:${Math.min(idx++, 60) * 14}ms"` : '';
        const label = `${e.title} at ${fmt(rel(e))}`;
        if (e.dur > 0) { const w = Math.max(8, (e.dur / d) * (W - 24)); rows += `<rect class="${cls}" ${delay} data-act="pick" data-id="${e.id}" tabindex="0" role="button" aria-label="${esc(label)}" x="${x}" y="${y + 12}" width="${w}" height="22" rx="5" fill="${c}" fill-opacity=".85" ${e.status === 'error' ? 'stroke="#fff" stroke-width="1.5"' : ''}><title>${esc(label)}</title></rect>`; }
        else rows += `<path class="${cls}" ${delay} data-act="pick" data-id="${e.id}" tabindex="0" role="button" aria-label="${esc(label)}" d="M${x} ${y + 12} l8 11 l-8 11 l-8 -11z" fill="${c}" ${e.status === 'error' ? 'stroke="#fff" stroke-width="1.5"' : ''}><title>${esc(label)}</title></path>`;
      }
    });
    return `<div class="chips">${LANES.map(([k, n, c]) => `<button class="chip ${S.lanes[k] ? '' : 'off'}" data-act="lane" data-l="${k}" aria-pressed="${S.lanes[k]}"><i style="background:${c}"></i>${n}</button>`).join('')}
      <span style="margin-left:auto"></span><button data-act="zoom" data-z="out" ${S.zoom <= 1 ? 'disabled' : ''} aria-label="Zoom out">&minus;</button><button data-act="zoom" data-z="in" ${S.zoom >= 12 ? 'disabled' : ''} aria-label="Zoom in">+</button><button data-act="zoom" data-z="fit">Fit</button></div>
      <div class="sw"><div class="lanes"><div class="axis-sp"></div>${LANES.map(([k, n]) => `<div style="${S.lanes[k] ? '' : 'opacity:.3'}">${n}</div>`).join('')}</div>
      <div class="scroll"><svg id="sw" width="${W}" height="${H}" role="img" aria-label="Session timeline">${ticks(d, W)}${rows}<g id="ph" transform="translate(${g.x(S.ph)},0)"><line y1="20" y2="${H}" stroke="#fff" stroke-width="1.5"/><path d="M-5 20h10l-5 7z" fill="#fff"/></g></svg></div></div>
      <div class="player"><button class="primary" data-act="play" ${S.rec || S.replay ? 'disabled' : ''}>${S.playing ? 'Pause' : 'Play'}</button><button data-act="speed">${S.speed}x</button>
      <input id="scrub" type="range" min="0" max="${d}" step="10" value="${S.ph}" aria-label="Playhead" ${S.rec ? 'disabled' : ''}><span id="phTime" class="mono">${fmt(S.ph)} / ${fmt(d)}</span>
      ${isExt ? (S.replay ? `<button class="danger" data-act="abort">Stop replay (${S.replay.i}/${S.replay.n})</button>` : `<button data-act="replaytab" ${S.busy.replay || S.rec ? 'disabled' : ''}>${S.busy.replay ? 'Replaying...' : 'Replay in tab'}</button>`) : ''}</div>`;
  }

  function charts() {
    const agent = S.sel.events.filter((e) => e.lane === 'agent');
    const by = {}; agent.forEach((e) => { const b = by[e.title] || (by[e.title] = { n: 0, sum: 0, max: 0, err: 0 }); b.n++; b.sum += e.dur || 0; b.max = Math.max(b.max, e.dur || 0); if (e.status === 'error') b.err++; });
    const rows = Object.entries(by).map(([k, v]) => ({ k, ...v, avg: v.sum / v.n })).sort((a, b) => b.max - a.max);
    const top = Math.max(1, ...rows.map((r) => r.max));
    const counts = LANES.map(([k, n, c]) => ({ k, n, c, v: S.sel.events.filter((e) => e.lane === k).length }));
    const total = Math.max(1, counts.reduce((a, c) => a + c.v, 0)); const R = 52, C = 2 * Math.PI * R; let off = 0;
    const segs = counts.map((c) => { const len = (c.v / total) * C; const s = `<circle class="seg" cx="70" cy="70" r="${R}" fill="none" stroke="${c.c}" stroke-width="18" stroke-dasharray="${S.animate ? 0 : len} ${C}" data-len="${len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`; off += len; return s; }).join('');
    return `<div class="grid2"><div class="card"><b>Slowest agent tool calls</b><p class="note">Max duration per tool. Orange means over 2 seconds.</p><div class="bars">${rows.map((r) => `<div class="b"><span title="${esc(r.k)}">${esc(r.k)}</span><div class="track"><div class="fill ${r.max > 2000 ? 'slow' : ''}" style="width:${S.animate ? 0 : (r.max / top) * 100}%" data-w="${(r.max / top) * 100}"></div></div><span class="mono">${r.max}ms${r.err ? ` <span style="color:var(--err)">!${r.err}</span>` : ''}</span></div>`).join('') || '<p class="note">No agent tool calls in this session. Start the bridge to capture them.</p>'}</div></div>
      <div class="card"><b>Events by lane</b><div class="donut"><svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Events by lane"><circle cx="70" cy="70" r="${R}" fill="none" stroke="#16223b" stroke-width="18"/>${segs}<text x="70" y="76" text-anchor="middle" fill="#e5edff" font-size="20" font-weight="700">${total === 1 && !S.sel.events.length ? 0 : total}</text></svg><div class="legend">${counts.map((c) => `<div><i style="background:${c.c}"></i>${c.n}: <b class="mono">${c.v}</b></div>`).join('')}</div></div></div></div>`;
  }

  function detailHtml() {
    const e = currentEvent();
    if (!e) return `<div class="note">Select an event on the timeline, or press Play to follow the session.</div>`;
    let shotEv = e;
    if (!e.shot) shotEv = [...S.sel.events].filter((x) => x.shot && x.t <= e.t).sort((a, b) => b.t - a.t)[0];
    const d = JSON.stringify(e.detail || {}, null, 2);
    return `<div class="detail"><div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:15px">${esc(e.title)}</b><span class="tag ${e.status}">${e.status}</span><span class="tag" style="color:${LC[e.lane]}">${e.lane}</span></div>
      <p class="note mono">at ${fmt(rel(e))}${e.dur ? `, ${e.dur}ms` : ''}</p><pre>${esc(d)}</pre><button data-act="copyjson">Copy event JSON</button></div>
      <div>${shotEv && shotEv.shot ? `<img class="shot" alt="Screenshot near this event" src="${shotEv.shot}"><p class="note">${shotEv === e ? 'Screenshot at this event' : `Last screenshot, taken at ${fmt(rel(shotEv))}`}</p>` : '<p class="note">No screenshot captured near this event.</p>'}</div></div>`;
  }
  function renderDetail() { const d = document.getElementById('detail'); if (d) d.innerHTML = detailHtml(); }

  function steps() {
    const ev = [...S.sel.events].sort((a, b) => a.t - b.t);
    return `<div class="card" style="overflow:auto"><div style="display:flex;gap:8px;margin-bottom:8px"><button data-act="repro">Copy as repro steps</button></div><table><thead><tr><th>Time</th><th>Lane</th><th>Event</th><th>Duration</th><th>Status</th></tr></thead><tbody>${ev.map((e) => `<tr class="row ${e.id === S.evId ? 'sel' : ''}" data-act="pick" data-id="${e.id}" tabindex="0"><td class="mono">${fmt(rel(e))}</td><td style="color:${LC[e.lane]}">${e.lane}</td><td>${esc(e.title)}</td><td class="mono">${e.dur ? e.dur + 'ms' : ''}</td><td><span class="tag ${e.status}">${e.status}</span></td></tr>`).join('')}</tbody></table></div>`;
  }
  function insights() {
    const list = I.analyze(S.sel);
    if (!list.length) return `<div class="card empty"><h2>No problems detected</h2><p>No failed requests, console errors, slow tool calls or retry loops in this session.</p></div>`;
    return list.map((o, i) => `<div class="ins" style="animation-delay:${i * 60}ms"><span class="sev ${o.sev}"></span><div><b>${esc(o.title)}</b><div class="note">${esc(o.text)}</div><div style="margin-top:4px">${esc(o.fix)}</div></div><button data-act="jump" data-id="${o.id}">Show</button></div>`).join('');
  }

  function main() {
    if (S.error) return `<div class="banner"><span>Could not load: ${esc(S.error)}</span><button data-act="retry">Retry</button></div>`;
    if (!S.sel) return emptyState();
    const nIns = I.analyze(S.sel).length;
    const body = S.view === 'timeline' ? `${timeline()}<div id="detail" class="card" style="margin-top:12px">${detailHtml()}</div>${charts()}` : S.view === 'steps' ? steps() : insights();
    return `<div class="titlebar"><h2>${esc(S.sel.name)}</h2>${S.sel.source === 'demo' ? '<span class="demo-tag">fictional demo data</span>' : ''}
      <button data-act="export">Export JSON</button><button data-act="repro">Copy repro steps</button><button class="danger" data-act="del" ${anyBusy() || S.rec ? 'disabled' : ''}>Delete</button></div>
      ${kpis()}
      <div class="tabs" role="tablist">${[['timeline', 'Timeline'], ['steps', 'Steps'], ['insights', 'Insights']].map(([v, n]) => `<button class="tab ${S.view === v ? 'on' : ''}" role="tab" aria-selected="${S.view === v}" data-act="view" data-v="${v}" ${S.busy.view ? 'disabled' : ''}>${n}${v === 'insights' && nIns ? `<span class="badge">${nIns}</span>` : ''}</button>`).join('')}</div>${body}`;
  }

  function render() {
    S.now = Date.now();
    const sx = document.querySelector('.scroll'); const keep = sx ? sx.scrollLeft : 0;
    root.innerHTML = `${header()}<div class="layout">${sidebar()}<main>${main()}${S.loading ? `<div class="overlay"><div><div class="spin"></div><div class="note">${esc(S.loading)}...</div></div></div>` : ''}</main></div>
      ${S.toast ? `<div class="toast ${S.toast.err ? 'err' : ''}" role="status"><span>${esc(S.toast.msg)}</span>${S.toast.retry ? '<button data-act="retry">Retry</button>' : ''}<button class="ghost" data-act="dismiss" aria-label="Dismiss">&times;</button></div>` : ''}`;
    const nsx = document.querySelector('.scroll'); if (nsx) nsx.scrollLeft = keep;
    if (S.animate && S.sel) requestAnimationFrame(() => { document.querySelectorAll('.bars .fill').forEach((f) => (f.style.width = f.dataset.w + '%')); document.querySelectorAll('circle.seg').forEach((c) => c.setAttribute('stroke-dasharray', `${c.dataset.len} 999`)); S.animate = false; });
    document.querySelectorAll('.kpi b[data-count]').forEach((b) => { const v = b.dataset.count; if (/^\d+$/.test(v) && S.animate) { let n = 0; const to = +v; const step = () => { n = Math.min(to, n + Math.ceil(to / 18)); b.textContent = n; if (n < to) requestAnimationFrame(step); }; step(); } });
  }

  // ---------- events ----------
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
    const fn = actions[t.dataset.act]; if (fn) fn(t);
  });
  root.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.mk,tr.row')) { e.preventDefault(); actions.pick(e.target); } });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'scrub') {
      S.ph = +e.target.value; const cur = [...S.sel.events].filter((x) => rel(x) <= S.ph).sort((a, b) => a.t - b.t).pop();
      if (cur) S.evId = cur.id; paintHead(); renderDetail(); markRows();
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'tabsel') S.tabId = +e.target.value;
    if (e.target.id === 'file') {
      const f = e.target.files[0]; if (!f) return;
      guard('import', async () => {
        if (f.size > 25e6) throw new Error('File is larger than 25 MB.');
        let j; try { j = JSON.parse(await f.text()); } catch { throw new Error('Not a valid JSON file.'); }
        if (!j || !Array.isArray(j.events) || typeof j.startedAt !== 'number') throw new Error('Not a MCP Tab Timeline export (needs startedAt and events).');
        const s = await api.imp(j); await refreshList(true); await open(s.id, true); toast('Imported');
      }, { retryLabel: 'Import' });
    }
  });
  window.__mtt = { S, render, api };
  init();
})();
