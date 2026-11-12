#!/usr/bin/env node
// Minimal MCP server (stdio) with four browser-style tools. It relays each call to a driver
// listening on ACT_URL. Used by the demo to show mcp-tap in front of a real MCP server.
import readline from 'node:readline';
const ACT = process.env.ACT_URL || 'http://127.0.0.1:7099/act';
const tools = ['browser_navigate', 'browser_click', 'browser_type', 'browser_wait_for'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mini-browser-mcp', version: '0.1.0' } } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    try {
      const r = await (await fetch(ACT, { method: 'POST', body: JSON.stringify({ tool: m.params.name, args: m.params.arguments }) })).json();
      return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.text }], isError: !r.ok } });
    } catch (e) { return out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: String(e.message) } }); }
  }
});
