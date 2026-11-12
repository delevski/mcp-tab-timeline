// Records user-visible page actions and relays them to the background worker.
// Also executes replay steps (highlight, click, type, scroll).
(() => {
  if (window.__mttContent) return;
  window.__mttContent = true;
  const SENSITIVE = /pass|pwd|card|cvv|cvc|ssn|secret|token/i;

  const send = (event) => {
    try { chrome.runtime.sendMessage({ cmd: 'page-event', event: { ...event, url: location.href } }).catch(() => {}); } catch { /* extension reloaded */ }
  };

  function selectorOf(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const tid = el.getAttribute('data-testid');
    if (tid) return `[data-testid="${tid}"]`;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 4 && n !== document.body) {
      let s = n.tagName.toLowerCase();
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(s);
      n = p;
    }
    return parts.join(' > ');
  }
  const labelOf = (el) => {
    const t = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.name || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 48) || el.tagName.toLowerCase();
  };

  document.addEventListener('click', (e) => {
    if (!e.isTrusted && !window.__mttRecordSynthetic) { /* still record: agents often use synthetic clicks */ }
    const el = e.target.closest('a,button,input,select,textarea,[role=button],[onclick]') || e.target;
    send({ type: 'click', selector: selectorOf(el), label: labelOf(el), x: Math.round(e.clientX), y: Math.round(e.clientY), t: Date.now() });
  }, true);

  const timers = new WeakMap();
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => {
      const masked = el.type === 'password' || SENSITIVE.test(el.name + ' ' + el.id + ' ' + (el.autocomplete || ''));
      send({ type: 'input', selector: selectorOf(el), label: labelOf(el), value: masked ? '\u2022\u2022\u2022\u2022' : String(el.value).slice(0, 120), masked, t: Date.now() });
    }, 600));
  }, true);

  document.addEventListener('submit', (e) => send({ type: 'submit', selector: selectorOf(e.target), label: labelOf(e.target), t: Date.now() }), true);

  let st;
  window.addEventListener('scroll', () => {
    clearTimeout(st);
    st = setTimeout(() => send({ type: 'scroll', y: Math.round(scrollY), label: `scroll to ${Math.round(scrollY)}px`, t: Date.now() }), 450);
  }, { passive: true });

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__mtt) return;
    send({ type: e.data.kind, label: e.data.msg, t: Date.now(), error: e.data.kind !== 'console.warn' });
  });

  // ---- replay ----
  function highlight(el) {
    const r = el.getBoundingClientRect();
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:2px solid #60a5fa;border-radius:6px;box-shadow:0 0 0 4px rgba(96,165,250,.25);transition:opacity .4s`;
    document.documentElement.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 450); }, 700);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.cmd !== 'replay-step') return;
    (async () => {
      const s = msg.step;
      if (s.type === 'scroll') { window.scrollTo({ top: s.y, behavior: 'smooth' }); return reply({ ok: true }); }
      const el = s.selector && document.querySelector(s.selector);
      if (!el) return reply({ ok: false, error: `Element not found: ${s.selector}` });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await wait(250);
      highlight(el);
      await wait(350);
      if (s.type === 'click') el.click();
      else if (s.type === 'input' && !s.masked) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, s.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (s.type === 'submit') el.requestSubmit ? el.requestSubmit() : el.submit();
      reply({ ok: true });
    })().catch((e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  });
})();
