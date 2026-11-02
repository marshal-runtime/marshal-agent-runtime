#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const options = parseArguments(process.argv.slice(2));
const deploymentRoot = path.resolve(options.deployment);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'marshal-native-delegation-'));
const workspace = options.workspace ? path.resolve(options.workspace) : path.join(temporaryRoot, 'workspace');
const marker = `MARSHAL_NATIVE_DELEGATION_OK_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
await mkdir(workspace, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(deploymentRoot, 'dist', 'cli.js')],
  cwd: workspace,
  env: stringEnvironment({
    ...process.env,
    MARSHAL_RUNTIME_PERMISSION_PROFILE: 'bounded-agentic',
    MARSHAL_RUNTIME_MEMORY_DB: path.join(temporaryRoot, 'memory.sqlite'),
  }),
  stderr: 'pipe',
});
const client = new Client({ name: 'marshal-native-delegation-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const spawnDescriptor = await client.callTool({
    name: 'runtime_search',
    arguments: { name: 'runtime.delegation.spawn' },
  });
  const descriptor = spawnDescriptor.structuredContent?.matches?.[0]?.capability;
  if (!descriptor?.inputSchema || !descriptor?.outputSchema) {
    throw new Error(`Exact delegation discovery omitted schemas: ${JSON.stringify(spawnDescriptor.structuredContent)}`);
  }

  const source = `
    export default async (input, context) => {
      const spawnLookup = await context.runtime.search({ name: 'runtime.delegation.spawn' });
      const spawnCapability = spawnLookup.matches?.[0]?.capability;
      if (!spawnCapability?.outputSchema) throw new Error('exact spawn schema unavailable');
      const spawned = await context.runtime.invoke('runtime.delegation.spawn', {
        prompt: input.prompt
      });
      if (!spawned?.delegationId) {
        return { ok: false, phase: 'spawn', spawned };
      }
      const waited = await context.runtime.invoke('runtime.delegation.wait', {
        delegationId: spawned.delegationId
      });
      return {
        ok: waited.state === 'done',
        delegationId: spawned.delegationId,
        schemaType: spawnCapability.outputSchema.properties?.delegationId?.type,
        waited
      };
    };
  `;
  const executed = await client.callTool({
    name: 'runtime_exec',
    arguments: {
      targetType: 'inline_module',
      source,
      input: {
        prompt: `Return exactly ${marker} and nothing else. Do not call tools.`,
      },
      timeoutMs: 150_000,
      context: { sessionId: `native-smoke-${randomUUID()}`, agentId: 'native-smoke-parent' },
    },
  });
  if (executed.isError === true) {
    throw new Error(`Brokered delegation execution failed: ${JSON.stringify(executed.structuredContent)}`);
  }
  const value = executed.structuredContent?.result?.output?.value;
  if (value?.ok !== true || value?.schemaType !== 'string') {
    throw new Error(`Native delegation did not complete: ${JSON.stringify(value)}`);
  }
  if (!JSON.stringify(value).includes(marker)) {
    throw new Error(`Completed native-agent evidence omitted marker ${marker}: ${JSON.stringify(value)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    deploymentRoot,
    workspace,
    permissionProfile: 'bounded-agentic',
    trustedNodeAuthority: false,
    exactSchemaVerified: true,
    delegationId: value.delegationId,
    marker,
    waitStatus: value.waited?.state,
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  if (!options.retain && !options.workspace) {
    await rm(temporaryRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Retained native-delegation smoke state at ${temporaryRoot}\n`);
  }
}

function parseArguments(args) {
  const parsed = { deployment: undefined, workspace: undefined, retain: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--deployment') parsed.deployment = args[++index];
    else if (args[index] === '--workspace') parsed.workspace = args[++index];
    else if (args[index] === '--retain') parsed.retain = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!parsed.deployment) throw new Error('--deployment is required.');
  return parsed;
}

function stringEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter((entry) => typeof entry[1] === 'string'),
  );
}
