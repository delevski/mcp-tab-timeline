// Pure functions: derive debugging insights from a session. Also used by tests.
(function (root) {
  function analyze(session) {
    const ev = [...(session.events || [])].sort((a, b) => a.t - b.t);
    const out = [];
    const t0 = session.startedAt;
    const rel = (e) => e.t - t0;

    for (const e of ev) {
      if (e.lane === 'network' && e.status === 'error') {
        out.push({ sev: 'error', id: e.id, title: `Request failed: ${e.detail.statusCode || e.detail.error || 'network error'}`, text: `${e.title} at ${fmt(rel(e))}`, fix: 'Check the agent assumed the right URL or auth state before calling this endpoint.' });
      }
      if (e.lane === 'console' && e.status === 'error') {
        out.push({ sev: 'error', id: e.id, title: e.title, text: `${e.title.replace(/^[^:]*:?/, '')} ${e.detail.label || ''}`.trim().slice(0, 140), fix: 'The page threw while the agent kept going. Ask the agent to read the console before the next step.' });
      }
      if (e.lane === 'agent' && e.status === 'error') {
        out.push({ sev: 'error', id: e.id, title: `Tool failed: ${e.title}`, text: (e.detail.error || 'tool returned an error').slice(0, 140), fix: 'Look at the page state right before this call. The element or page it expected may not exist yet.' });
      }
      if (e.lane === 'agent' && e.dur > 2000) {
        out.push({ sev: 'warn', id: e.id, title: `Slow tool call: ${e.title}`, text: `${(e.dur / 1000).toFixed(1)}s at ${fmt(rel(e))}`, fix: 'Wait for a specific element instead of a fixed delay, or reduce the snapshot size.' });
      }
    }
    // repeated clicks on the same selector within 6s = retry loop
    const clicks = ev.filter((e) => e.type === 'click');
    for (let i = 0; i < clicks.length; i++) {
      const group = [clicks[i]];
      for (let j = i + 1; j < clicks.length; j++) if (clicks[j].detail.selector === clicks[i].detail.selector && clicks[j].t - clicks[i].t < 6000) group.push(clicks[j]);
      if (group.length >= 3) {
        out.push({ sev: 'warn', id: clicks[i].id, title: `Retry loop: ${group.length} clicks on the same element`, text: `${clicks[i].detail.label || clicks[i].detail.selector} at ${fmt(rel(clicks[i]))}`, fix: 'The click probably had no visible effect. Check for a disabled button, overlay or validation message.' });
        i += group.length - 1;
      }
    }
    // agent action with no page reaction within 3s
    for (const e of ev.filter((x) => x.lane === 'agent' && /click|type|submit|navigate|press/i.test(x.title) && x.status === 'ok')) {
      const end = e.t + (e.dur || 0);
      const reacted = ev.some((x) => x.lane !== 'agent' && x.t >= e.t - 200 && x.t <= end + 3000);
      if (!reacted) out.push({ sev: 'warn', id: e.id, title: `No page reaction after ${e.title}`, text: `Nothing changed in the tab within 3s of ${fmt(rel(e))}`, fix: 'The agent may have acted on a stale element reference. Re-snapshot before acting.' });
    }
    const seen = new Set();
    return out.filter((o) => { const k = o.id + o.title; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  function fmt(ms) {
    const s = Math.max(0, ms) / 1000;
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
  }
  function stats(session) {
    const ev = session.events || [];
    const agent = ev.filter((e) => e.lane === 'agent');
    const net = ev.filter((e) => e.lane === 'network');
    const end = session.endedAt || (ev.length ? Math.max(...ev.map((e) => e.t + (e.dur || 0))) : session.startedAt);
    return {
      events: ev.length,
      duration: Math.max(0, end - session.startedAt),
      errors: ev.filter((e) => e.status === 'error').length,
      agentCalls: agent.length,
      avgTool: agent.length ? Math.round(agent.reduce((a, e) => a + (e.dur || 0), 0) / agent.length) : 0,
      netFailed: net.filter((e) => e.status === 'error').length,
    };
  }
  const api = { analyze, stats, fmt };
  if (typeof module !== 'undefined') module.exports = api; else root.MTTInsights = api;
})(typeof window !== 'undefined' ? window : globalThis);
