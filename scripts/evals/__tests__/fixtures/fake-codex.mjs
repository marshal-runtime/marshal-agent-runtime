#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.144.6-test\n');
} else if (args.includes('app-server')) {
  const pluginSetting = args.find((value) => value.startsWith('plugins."marshal-runtime@test".enabled='));
  const marshalEnabled = pluginSetting?.endsWith('true') === true;
  const model = configValue('model') ?? 'fixture-model';
  const reasoning = configValue('model_reasoning_effort') ?? 'fixture-reasoning';
  const sandbox = configValue('sandbox_mode') ?? 'workspace-write';
  const approvalPolicy = configValue('approval_policy') ?? 'never';
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id === 1) process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'fake-codex' } })}\n`);
    if (request.id === 2) process.stdout.write(`${JSON.stringify({
      id: 2,
      result: {
        config: {
          model,
          model_reasoning_effort: reasoning,
          sandbox_mode: sandbox,
          approval_policy: approvalPolicy,
          web_search: configValue('web_search') ?? 'cached',
          sandbox_workspace_write: {
            network_access: configValue('sandbox_workspace_write.network_access') ?? true,
          },
          features: { apps: configValue('features.apps') ?? true },
          apps: {
            _default: {
              enabled: configValue('apps._default.enabled') ?? true,
              open_world_enabled: configValue('apps._default.open_world_enabled') ?? true,
            },
          },
          mcp_servers: {},
          plugins: {
            'marshal-runtime@test': { enabled: marshalEnabled },
          },
        },
      },
    })}\n`);
    if (request.id === 2) break;
  }
} else if (args.includes('plugin') && args.includes('list')) {
  process.stdout.write(`${JSON.stringify({
    installed: [
      { pluginId: 'marshal-runtime@test', version: '0.1.0-test', installed: true, enabled: true, source: { source: 'local', path: process.env.FAKE_CODEX_PLUGIN_PATH } },
    ],
    available: [],
  })}\n`);
} else if (args.includes('exec')) {
  const prompt = await readStdin();
  const resumeIndex = args.indexOf('resume');
  const resumed = resumeIndex >= 0;
  const threadId = resumed ? args.at(-2) : `fake-thread-${process.env.MARSHAL_EVAL_ATTEMPT_KEY?.replaceAll('/', '-')}`;
  if (process.env.FAKE_CODEX_LOG) {
    await appendFile(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ args, prompt, cwd: process.cwd(), threadId, resumed })}\n`);
  }
  const generated = `generated-${resumed ? 'resume' : 'fresh'}.txt`;
  await writeFile(generated, `from ${basename(process.cwd())}: ${prompt}`, 'utf8');
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  emit({
    type: 'item.completed',
    item: {
      id: 'tool-1',
      type: 'mcp_tool_call',
      server: 'marshal-runtime',
      tool: 'runtime_exec',
      result: { receipts: [{ id: resumed ? 'receipt-resume' : 'receipt-fresh', status: 'success' }] },
    },
  });
  emit({ type: 'item.completed', item: { id: 'file-1', type: 'file_change', changes: [{ path: generated }] } });
  emit({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: `fake result: ${prompt}` } });
  emit({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4, reasoning_output_tokens: 1 },
  });
} else {
  process.stderr.write(`unsupported fake Codex invocation: ${args.join(' ')}\n`);
  process.exitCode = 2;
}

function configValue(name) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-c') continue;
    const value = args[index + 1];
    if (!value.startsWith(`${name}=`)) continue;
    return JSON.parse(value.slice(name.length + 1));
  }
  return undefined;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
