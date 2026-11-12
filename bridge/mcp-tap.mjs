#!/usr/bin/env node
// MCP stdio proxy. Put it in front of any MCP server; it forwards JSON-RPC unchanged
// and reports every tools/call (name, args, duration, ok/error) to the bridge.
//   mcp-tap -- npx @playwright/mcp@latest
// Env: BRIDGE_URL (default http://127.0.0.1:7077)
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const i = process.argv.indexOf('--');
const cmd = i >= 0 ? process.argv.slice(i + 1) : process.argv.slice(2);
if (!cmd.length) {
  console.error('usage: mcp-tap -- <mcp server command> [args...]');
  process.exit(2);
}
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:7077';
const pending = new Map();
const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });

async function report(e) {
  try {
    await fetch(`${BRIDGE}/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e), signal: AbortSignal.timeout(1500) });
  } catch { /* bridge offline: never break the agent */ }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const m = JSON.parse(line);
    if (m.method === 'tools/call' && m.id != null) pending.set(m.id, { t: Date.now(), tool: m.params?.name || 'unknown', args: m.params?.arguments ?? null });
  } catch { /* not JSON, pass through */ }
  child.stdin.write(line + '\n');
});
process.stdin.on('end', () => child.stdin.end());

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const m = JSON.parse(line);
    const p = m.id != null ? pending.get(m.id) : null;
    if (p) {
      pending.delete(m.id);
      const isErr = !!m.error || m.result?.isError === true;
      const text = m.result?.content?.map?.((c) => c.text).filter(Boolean).join(' ');
      report({ t: p.t, dur: Date.now() - p.t, tool: p.tool, args: p.args, ok: !isErr, error: isErr ? (m.error?.message || text || 'tool error') : null, result: isErr ? null : text, server: cmd[cmd.length > 1 ? 1 : 0] });
    }
  } catch { /* pass through */ }
  process.stdout.write(line + '\n');
});
child.on('exit', (code) => process.exit(code ?? 0));
