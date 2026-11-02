#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

if (process.env.MARSHAL_RUN_LIVE_LUNA_DYNAMIC_TOOL_PROBE !== '1') {
  process.stdout.write(`${JSON.stringify({
    status: 'skipped',
    evidenceClass: 'unavailable',
    reason: 'Set MARSHAL_RUN_LIVE_LUNA_DYNAMIC_TOOL_PROBE=1 to run the saved-auth app-server probe.',
  }, null, 2)}\n`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const cliScript = join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
const samples = integer(process.env.MARSHAL_LUNA_DYNAMIC_TOOL_SAMPLES, 1, 1, 5);
const effort = ['none', 'low', 'medium'].includes(process.env.MARSHAL_LUNA_DYNAMIC_TOOL_EFFORT ?? '')
  ? process.env.MARSHAL_LUNA_DYNAMIC_TOOL_EFFORT
  : 'low';
const model = process.env.MARSHAL_LUNA_DYNAMIC_TOOL_MODEL?.trim() || 'gpt-5.6-luna';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'marshal-luna-dynamic-tool-'));
  const client = new Client(directory);
  const startedAt = performance.now();
  try {
    const readyStartedAt = performance.now();
    await client.initialize();
    const readyMs = performance.now() - readyStartedAt;
    const attempts = [];
    for (let index = 0; index < samples; index += 1) {
      attempts.push(await runAttempt(client, directory, index + 1));
    }
    process.stdout.write(`${JSON.stringify({
      status: attempts.every((attempt) => attempt.passed) ? 'passed' : 'failed',
      evidenceClass: 'live-transport-probe',
      qualityClaimAllowed: false,
      model,
      effort,
      sampleCount: samples,
      transport: 'codex-app-server-dynamicTools',
      policy: 'One saved-auth app-server; one isolated ephemeral thread per attempt; one client-executed deterministic read-only tool; no memory-quality claim.',
      latencyMs: {
        authenticatedStartup: round(readyMs),
        total: round(performance.now() - startedAt),
        attempts: summarize(attempts.map((attempt) => attempt.totalMs)),
        preTool: summarize(attempts.map((attempt) => attempt.preToolMs)),
        callback: summarize(attempts.map((attempt) => attempt.callbackMs)),
        postTool: summarize(attempts.map((attempt) => attempt.postToolMs)),
      },
      attempts,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      evidenceClass: 'live-transport-probe',
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await client.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function runAttempt(clientInstance, directory, sample) {
  const thread = record(await clientInstance.request('thread/start', {
    model,
    allowProviderModelFallback: false,
    cwd: directory,
    runtimeWorkspaceRoots: [directory],
    approvalPolicy: 'never',
    sandbox: 'read-only',
    serviceName: 'marshal_memory_brain_dynamic_probe',
    baseInstructions: 'You are a bounded specialized memory transport probe. Use only the declared tool.',
    developerInstructions: 'Call lookup_probe exactly once. After its result, return only the requested JSON object. Never inspect files, browse, run commands, delegate, or use other tools.',
    ephemeral: true,
    threadSource: 'marshalMemoryBrainDynamicProbe',
    environments: [],
    dynamicTools: [{
      type: 'function',
      name: 'lookup_probe',
      description: 'Return the exact deterministic probe value for the canary key.',
      inputSchema: {
        type: 'object',
        required: ['key'],
        additionalProperties: false,
        properties: { key: { type: 'string', const: 'canary' } },
      },
    }],
  }, 20_000));
  const threadId = required(record(thread.thread).id, 'thread id');
  const startedAt = performance.now();
  const started = record(await clientInstance.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Use lookup_probe with key canary, then return the observed value.', text_elements: [] }],
    model,
    effort,
    summary: 'none',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    outputSchema: {
      type: 'object',
      required: ['value'],
      additionalProperties: false,
      properties: { value: { type: 'string', const: 'CANARY_OK' } },
    },
  }, 20_000));
  const turnId = required(record(started.turn).id, 'turn id');
  const completed = await clientInstance.waitForTurn(threadId, turnId, 20_000);
  const totalMs = performance.now() - startedAt;
  await clientInstance.request('thread/unsubscribe', { threadId }, 2_000).catch(() => undefined);
  const output = completed.messages.at(-1) ?? '';
  const parsed = parseJson(output);
  const tool = completed.tools[0];
  return {
    sample,
    passed: completed.status === 'completed' && completed.tools.length === 1 && parsed.value === 'CANARY_OK',
    totalMs: round(totalMs),
    preToolMs: round((tool?.requestedAt ?? startedAt) - startedAt),
    callbackMs: round((tool?.respondedAt ?? startedAt) - (tool?.requestedAt ?? startedAt)),
    postToolMs: round(totalMs - ((tool?.respondedAt ?? startedAt) - startedAt)),
    usage: completed.usage ?? null,
    tool: tool ? { name: tool.name, arguments: tool.arguments } : null,
  };
}

class Client {
  constructor(cwd) {
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.child = spawn(process.execPath, [
      cliScript,
      'app-server',
      '--stdio',
      '--disable', 'apps',
      '--disable', 'browser_use',
      '--disable', 'computer_use',
      '--disable', 'hooks',
      '--disable', 'image_generation',
      '--disable', 'in_app_browser',
      '--disable', 'multi_agent',
      '--disable', 'plugins',
      '--disable', 'shell_tool',
      '--disable', 'unified_exec',
      '-c', 'mcp_servers={}',
      '-c', 'tools.web_search=false',
    ], {
      cwd,
      env: safeEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-16_000); });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code, signal) => this.fail(new Error(`app-server exited (${code ?? signal}): ${this.stderr}`)));
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line));
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'marshal-luna-dynamic-probe', title: 'Marshal Luna Dynamic Probe', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta'],
      },
    }, 20_000);
    this.write({ method: 'initialized', params: {} });
    const account = record(await this.request('account/read', { refreshToken: false }, 10_000));
    if (account.requiresOpenaiAuth === true && account.account === null) throw new Error('Codex account is not authenticated.');
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  waitForTurn(threadId, turnId, timeoutMs) {
    const key = `${threadId}:${turnId}`;
    const turn = this.turns.get(key) ?? { messages: [], tools: [] };
    this.turns.set(key, turn);
    if (turn.completed) return Promise.resolve(turn.completed);
    return new Promise((resolve, reject) => {
      turn.waiter = { resolve, reject, timer: setTimeout(() => reject(new Error('Timed out waiting for turn completion.')), timeoutMs) };
    });
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    this.handleNotification(message);
  }

  handleServerRequest(message) {
    if (message.method !== 'item/tool/call') {
      this.write({ id: message.id, error: { code: -32601, message: `Unsupported request ${message.method}` } });
      return;
    }
    const params = record(message.params);
    const turn = this.turn(required(params.threadId, 'tool thread id'), required(params.turnId, 'tool turn id'));
    const requestedAt = performance.now();
    const argumentsValue = record(params.arguments);
    const valid = params.tool === 'lookup_probe' && argumentsValue.key === 'canary';
    const respondedAt = performance.now();
    turn.tools.push({ name: params.tool, arguments: argumentsValue, requestedAt, respondedAt });
    this.write({
      id: message.id,
      result: {
        contentItems: [{ type: 'inputText', text: JSON.stringify(valid ? { value: 'CANARY_OK' } : { error: 'invalid_probe_call' }) }],
        success: valid,
      },
    });
  }

  handleNotification(message) {
    const params = record(message.params);
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const turnId = typeof params.turnId === 'string' ? params.turnId : typeof record(params.turn).id === 'string' ? record(params.turn).id : undefined;
    if (!threadId || !turnId) return;
    const turn = this.turn(threadId, turnId);
    if (message.method === 'item/completed') {
      const item = record(params.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') turn.messages.push(item.text);
    } else if (message.method === 'thread/tokenUsage/updated') {
      turn.usage = record(record(params.tokenUsage).last);
    } else if (message.method === 'turn/completed') {
      const status = String(record(params.turn).status ?? 'failed');
      turn.completed = { status, messages: turn.messages, tools: turn.tools, usage: turn.usage };
      if (turn.waiter) {
        clearTimeout(turn.waiter.timer);
        turn.waiter.resolve(turn.completed);
      }
    }
  }

  turn(threadId, turnId) {
    const key = `${threadId}:${turnId}`;
    const existing = this.turns.get(key);
    if (existing) return existing;
    const created = { messages: [], tools: [] };
    this.turns.set(key, created);
    return created;
  }

  write(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      if (turn.waiter) {
        clearTimeout(turn.waiter.timer);
        turn.waiter.reject(error);
      }
    }
  }

  async dispose() {
    if (!this.child.killed) {
      this.child.stdin.end();
      this.child.kill();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function safeEnvironment(source) {
  const keys = ['APPDATA', 'CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'USERPROFILE', 'WINDIR'];
  return {
    ...Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])),
    NO_COLOR: '1',
    RUST_LOG: 'error',
  };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function required(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${label}.`);
  return value;
}

function parseJson(value) {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  return record(JSON.parse(start >= 0 && end > start ? value.slice(start, end + 1) : value));
}

function integer(value, fallback, min, max) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected integer ${min}-${max}.`);
  return parsed;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { min: sorted[0], median: sorted[Math.ceil(sorted.length / 2) - 1], max: sorted.at(-1) };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

await main();
