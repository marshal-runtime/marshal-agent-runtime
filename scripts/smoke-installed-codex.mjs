#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const arguments_ = process.argv.slice(2);
if (arguments_[0] === '--') arguments_.shift();
const workspacePath = path.resolve(arguments_[0] ?? process.cwd());
await mkdir(workspacePath, { recursive: true });
const installedEntrypoint = process.env.MARSHAL_CODEX_ENTRYPOINT?.trim();
const transport = new StdioClientTransport({
  command: installedEntrypoint ? process.execPath : (process.env.MARSHAL_CODEX_COMMAND ?? 'agent-runtime-codex'),
  args: [...(installedEntrypoint ? [path.resolve(installedEntrypoint)] : []), '--workspace', workspacePath],
  cwd: workspacePath,
  stderr: 'pipe',
});
const client = new Client({ name: 'marshal-installed-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const required of ['runtime_search', 'runtime_exec', 'runtime_render_component']) {
    if (!names.includes(required)) throw new Error(`Installed MCP server omitted ${required}`);
  }
  const discovered = await client.callTool({
    name: 'runtime_search',
    arguments: { query: 'memory' },
  });
  const candidates = discovered.structuredContent?.matches ?? discovered.structuredContent?.result;
  const count = Array.isArray(candidates) ? candidates.length : 0;
  if (count < 1) {
    throw new Error(`Installed MCP server returned no capabilities: ${JSON.stringify(discovered.structuredContent)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, workspacePath, requiredTools: names, discovered: count }, null, 2)}\n`);
} finally {
  await client.close();
}
