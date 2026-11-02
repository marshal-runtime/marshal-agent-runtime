#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';

function parseArgs(argv) {
  const parsed = { mode: 'read' };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--mode') parsed.mode = requireValue(argv, ++index, name);
    else if (name === '--codex') parsed.codex = absoluteValue(argv, ++index, name);
    else if (name === '--marketplace') parsed.marketplace = requireValue(argv, ++index, name);
    else if (name === '--file-path') parsed.filePath = absoluteValue(argv, ++index, name);
    else if (name === '--cwd') parsed.cwd = absoluteValue(argv, ++index, name);
    else if (name === '--codex-home') parsed.codexHome = absoluteValue(argv, ++index, name);
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (!['read', 'enable-plugin'].includes(parsed.mode)) throw new Error('--mode must be read or enable-plugin.');
  if (!parsed.codex) throw new Error('--codex requires an absolute executable path.');
  if (!parsed.marketplace || !/^[A-Za-z0-9_-]+$/.test(parsed.marketplace)) {
    throw new Error('--marketplace requires a validated marketplace name.');
  }
  return parsed;
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function absoluteValue(argv, index, name) {
  const value = requireValue(argv, index, name);
  if (!isAbsolute(value)) throw new Error(`${name} requires an absolute path.`);
  return resolve(value);
}

function readPluginEnabled(result, marketplace) {
  const pluginId = `marshal-runtime@${marketplace}`;
  const config = result && typeof result === 'object' ? result.config : undefined;
  const plugins = config && typeof config === 'object' ? config.plugins : undefined;
  const plugin = plugins && typeof plugins === 'object' ? plugins[pluginId] : undefined;
  return plugin && typeof plugin === 'object' && typeof plugin.enabled === 'boolean'
    ? plugin.enabled
    : null;
}

function redact(text) {
  return text
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1<redacted>@')
    .replace(/([?&](?:access_token|auth|password|token)=)[^&\s]+/gi, '$1<redacted>');
}

class AppServerClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #stderr = '';

  constructor(codex, codexHome) {
    this.#child = spawn(codex, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      },
    });
    createInterface({ input: this.#child.stdout }).on('line', (line) => this.#handleLine(line));
    this.#child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-8192);
    });
    this.#child.on('error', (error) => this.#failAll(error));
    this.#child.on('exit', (code, signal) => {
      this.#failAll(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}): ${this.#stderr.trim()}`));
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: {
        name: 'marshal-plugin-config',
        title: 'Marshal Plugin Config',
        version: '1.0.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.#write({ method: 'initialized', params: {} });
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for Codex app-server method ${method}.`));
      }, 15000);
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.#write({ id, method, params });
    });
  }

  async dispose() {
    if (!this.#child.killed) {
      this.#child.stdin.end();
      this.#child.kill();
    }
  }

  #write(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#write({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      });
      return;
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(`Codex app-server ${pending.method} failed: ${message.error.message ?? 'Unknown error.'}`));
    else pending.resolve(message.result);
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new AppServerClient(args.codex, args.codexHome);
  try {
    await client.initialize();
    if (args.mode === 'read') {
      const result = await client.request('config/read', {
        cwd: args.cwd ?? null,
        includeLayers: false,
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        method: 'config/read',
        pluginEnabled: readPluginEnabled(result, args.marketplace),
      })}\n`);
    } else {
      const keyPath = `plugins."marshal-runtime@${args.marketplace}".enabled`;
      await client.request('config/value/write', {
        keyPath,
        value: true,
        mergeStrategy: 'upsert',
        ...(args.filePath ? { filePath: args.filePath } : {}),
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        method: 'config/value/write',
        keyPath,
        filePath: args.filePath ?? null,
      })}\n`);
    }
  } finally {
    await client.dispose();
  }
}

main().catch((error) => {
  process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});
