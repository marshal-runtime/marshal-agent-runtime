#!/usr/bin/env node

import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspace = 'Q:\\src\\.marshal-worktrees\\quillstone-demo-runtime-03aafbe';
const cli = 'Q:\\src\\.marshal-worktrees\\memory-final-integration-20260827\\packages\\agent-runtime-codex\\dist\\cli.js';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, '--workspace', workspace],
  cwd: workspace,
  stderr: 'pipe',
  env: {
    ...process.env,
    MARSHAL_RUNTIME_LIFECYCLE_TOOLS: 'hidden',
    MARSHAL_RUNTIME_EMBEDDINGS_ENABLED: 'false',
    MARSHAL_RUNTIME_KNOWLEDGE_DATA_ROOT: 'Q:\\.q',
    MARSHAL_RUNTIME_MEMORY_DB: 'Q:\\.q\\memory\\memory.sqlite',
    MARSHAL_RUNTIME_MEMORY_PROJECTION_ROOT: 'Q:\\.q\\memory\\projections',
    MARSHAL_RUNTIME_PERMISSION_PROFILE: 'trusted-local',
    MARSHAL_RUNTIME_ALLOWED_PACKAGES: '*',
    MARSHAL_RUNTIME_ALLOWED_BUILTINS: '*',
  },
});
const client = new Client({ name: 'marshal-demo-index-preparer', version: '1.0.0' });

try {
  await client.connect(transport);
  const before = await invoke('knowledge.workspace.status', {});
  const beforeIndex = findRecord(before, (value) => typeof value.state === 'string' && 'generation' in value);
  console.log(`before: ${beforeIndex?.state ?? 'unknown'} generation ${beforeIndex?.generation ?? 'unknown'}`);
  if (beforeIndex?.state === 'ready') process.exitCode = 0;
  else {
    const ensured = await invoke('knowledge.workspace.ensure', { mode: 'create-if-missing' });
    const jobId = findString(ensured, 'jobId');
    const reused = findRecord(ensured, (value) => value.created === false);
    if (!jobId && !reused) {
      throw new Error(`Index initialization returned neither a job nor a reusable index: ${JSON.stringify(ensured)}`);
    }
    if (jobId) {
      console.log(`initialization: ${jobId}`);
      for (;;) {
        const status = await invoke('runtime.jobs.status', { jobId });
        const state = findString(status, 'state') ?? 'unknown';
        const progress = findRecord(status, (value) => 'message' in value && ('completed' in value || 'total' in value));
        console.log(`${new Date().toISOString()} ${state}${progress?.message ? ` - ${progress.message}` : ''}`);
        if (state === 'succeeded') break;
        if (state === 'failed' || state === 'cancelled') {
          throw new Error(`Index initialization ${state}: ${JSON.stringify(status)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    const after = await invoke('knowledge.workspace.status', {});
    const afterIndex = findRecord(after, (value) => typeof value.state === 'string' && 'generation' in value);
    console.log(`after: ${afterIndex?.state ?? 'unknown'} generation ${afterIndex?.generation ?? 'unknown'}`);
    if (afterIndex?.state !== 'ready') throw new Error(`Published index is not ready: ${JSON.stringify(after)}`);
  }
} finally {
  await transport.close();
}

async function invoke(target, input) {
  const response = await client.callTool({
    name: 'runtime_exec',
    arguments: { targetType: 'operation', target, input },
  });
  if (response.isError === true) throw new Error(JSON.stringify(response.structuredContent ?? response.content));
  return response.structuredContent ?? response.content;
}

function findString(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  if (!Array.isArray(value) && typeof value[key] === 'string') return value[key];
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const match = findString(nested, key);
    if (match) return match;
  }
  return undefined;
}

function findRecord(value, predicate) {
  if (!value || typeof value !== 'object') return undefined;
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const match = findRecord(nested, predicate);
    if (match) return match;
  }
  return undefined;
}
