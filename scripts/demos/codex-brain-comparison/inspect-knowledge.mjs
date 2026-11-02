#!/usr/bin/env node

import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspace = 'Q:\\src\\.marshal-worktrees\\quillstone-demo-runtime-03aafbe';
const cli = 'Q:\\src\\.marshal-worktrees\\memory-final-integration-20260827\\packages\\agent-runtime-codex\\dist\\cli.js';
const memoryOnly = process.argv[2] === '--memory';
const impact = process.argv[2] === '--impact';
const context = process.argv[2] === '--context';
const brain = process.argv[2] === '--brain';
const remember = process.argv[2] === '--remember';
const genericOperation = process.argv[2] === '--operation';
const operationName = genericOperation ? process.argv[3] : undefined;
const operationInput = genericOperation ? JSON.parse(process.argv[4] ?? '{}') : undefined;
const query = genericOperation
  ? ''
  : process.argv.slice(memoryOnly || impact || context || brain || remember ? 3 : 2).join(' ').trim();
if (!genericOperation && !query) throw new Error('Pass a knowledge-search query.');
if (genericOperation && !operationName) throw new Error('Pass an operation name and JSON input.');

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
    MARSHAL_MEMORY_BRAIN_MODEL: 'gpt-5.6-luna',
    MARSHAL_MEMORY_BRAIN_REASONING_EFFORT: 'none',
    MARSHAL_MEMORY_BRAIN_SERVICE_TIER: 'priority',
    MARSHAL_MEMORY_BRAIN_DYNAMIC_TOOLS: process.env.MARSHAL_MEMORY_BRAIN_DYNAMIC_TOOLS ?? 'false',
  },
});
const client = new Client({ name: 'marshal-demo-knowledge-inspector', version: '1.0.0' });

try {
  await client.connect(transport);
  const response = await client.callTool({
    name: 'runtime_exec',
    arguments: {
      targetType: 'operation',
      target: genericOperation
        ? operationName
        : brain || remember
        ? `memory.brain.${remember ? 'remember' : 'recall'}`
        : impact ? 'knowledge.impact' : context ? 'knowledge.context' : 'knowledge.search',
      input: genericOperation
        ? operationInput
        : brain || remember
        ? { content: query }
        : impact
        ? { target: { kind: 'memory', id: query }, direction: 'both', maxDepth: 2, limit: 20 }
        : context
          ? { target: { kind: 'memory', id: query }, maxDepth: 1, limit: 5 }
        : {
            query,
            kinds: memoryOnly
              ? ['memory']
              : ['memory', 'code_file', 'symbol', 'execution_flow', 'evidence'],
            limit: 20,
          },
    },
  });
  if (response.isError === true) {
    throw new Error(JSON.stringify(response.structuredContent ?? response.content));
  }
  process.stdout.write(`${JSON.stringify({ content: response.content, structuredContent: response.structuredContent }, null, 2)}\n`);
} finally {
  await transport.close();
}
