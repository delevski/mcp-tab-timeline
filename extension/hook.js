// Runs in the page (MAIN world). Forwards console errors and uncaught errors to content.js.
(() => {
  if (window.__mttHook) return;
  window.__mttHook = true;
  const post = (kind, msg) => {
    try { window.postMessage({ __mtt: true, kind, msg: String(msg).slice(0, 400) }, '*'); } catch { /* ignore */ }
  };
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function (...a) {
      post('console.' + level, a.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? safe(x) : x)).join(' '));
      return orig.apply(this, a);
    };
  }
  const safe = (o) => { try { return JSON.stringify(o); } catch { return '[object]'; } };
  window.addEventListener('error', (e) => post('exception', e.message));
  window.addEventListener('unhandledrejection', (e) => post('rejection', e.reason?.message || e.reason));
})();
