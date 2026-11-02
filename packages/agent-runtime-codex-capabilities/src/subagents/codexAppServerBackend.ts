import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveContainedExistingDirectory } from '../pathSafety.js';
import type {
  SpawnSubagentRequest,
  SubagentBackend,
  SubagentListRequest,
  SubagentRunResult,
  SubagentSnapshot,
  SubagentStatus,
  SubagentWaitSignal,
} from './types.js';
import type { JsonObject } from '../coreTypes.js';

const require = createRequire(import.meta.url);
const REQUEST_TIMEOUT_MS = 120_000;
const CANCEL_POLL_INTERVAL_MS = 50;
const SAFE_AMBIENT_ENV_KEYS = [
  'APPDATA',
  'CODEX_HOME',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'USERPROFILE',
  'WINDIR',
] as const;

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerBackendOptions {
  workspaceRoot: string;
  additionalWorkspaceRoots?: readonly string[];
  codexCliScript?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

/** Real Codex CLI app-server backend; injectable backends remain preferred for host ownership. */
export class CodexAppServerBackend implements SubagentBackend {
  private readonly workspaceRoot: string;
  private readonly allowedWorkspaceRoots: readonly string[];
  private process: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private requestId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly ephemeralThreadIds = new Set<string>();
  private readonly pendingRunThreadIds = new Set<string>();
  private readonly activeTurnIds = new Map<string, string>();

  constructor(private readonly options: CodexAppServerBackendOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.allowedWorkspaceRoots = [
      this.workspaceRoot,
      ...(options.additionalWorkspaceRoots ?? []).map((root) => resolve(root)),
    ];
  }

  async spawn(request: SpawnSubagentRequest): Promise<SubagentSnapshot> {
    const workspacePath = await this.resolveAllowedWorkspace(request.workspacePath);
    const response = asRecord(
      await this.request('thread/start', {
        model: request.model,
        cwd: workspacePath,
        runtimeWorkspaceRoots: [workspacePath],
        approvalPolicy: request.approvalPolicy ?? 'never',
        sandbox: request.sandbox ?? 'workspace-write',
        developerInstructions: buildDeveloperInstructions(request),
        ephemeral: request.ephemeral ?? false,
        parentThreadId: request.parentThreadId,
        threadSource: 'subAgent',
      }),
    );
    const thread = normalizeThread(asRecord(response.thread));
    await this.assertThread(thread);
    if (request.ephemeral === true) this.ephemeralThreadIds.add(thread.id);
    return thread;
  }

  async run(
    threadId: string,
    prompt: string,
    options: { reasoningEffort?: string } = {},
  ): Promise<SubagentRunResult> {
    this.pendingRunThreadIds.add(threadId);
    const streamedItems: Array<{ turnId: string; item: JsonObject }> = [];
    const itemListener = (message: JsonRpcMessage) => {
      if (message.method !== 'item/completed' || message.params?.threadId !== threadId) return;
      streamedItems.push({
        turnId: String(message.params.turnId ?? ''),
        item: asRecord(message.params.item),
      });
    };
    this.listeners.add(itemListener);
    try {
      await this.start();
      const started = asRecord(
        await this.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          effort: options.reasoningEffort,
        }),
      );
      const turnId = String(asRecord(started.turn).id ?? '');
      this.activeTurnIds.set(threadId, turnId);
      const completed = await this.waitForNotification(
        'turn/completed',
        (params) => params.threadId === threadId && asRecord(params.turn).id === turnId,
      );
      const rawTurn = asRecord(completed.turn);
      const completedItems = streamedItems
        .filter((entry) => entry.turnId === turnId)
        .map((entry) => entry.item);
      const turnWithItems = array(rawTurn.items).length
        ? rawTurn
        : { ...rawTurn, items: completedItems };
      const inspected = await this.inspect(threadId);
      const response = extractResponse(turnWithItems);
      return {
        thread: { ...inspected, lastResponse: response || inspected.lastResponse },
        response,
        turnId,
        status:
          rawTurn.status === 'failed'
            ? 'failed'
            : rawTurn.status === 'interrupted'
              ? 'interrupted'
              : 'completed',
        ...(rawTurn.error === undefined ? {} : { error: rawTurn.error }),
        items: normalizeItems(turnWithItems.items),
      };
    } finally {
      this.activeTurnIds.delete(threadId);
      this.pendingRunThreadIds.delete(threadId);
      this.listeners.delete(itemListener);
    }
  }

  async list(request: SubagentListRequest): Promise<readonly SubagentSnapshot[]> {
    const workspacePath = await this.resolveAllowedWorkspace(
      request.workspacePath ?? this.workspaceRoot,
    );
    const response = asRecord(
      await this.request('thread/list', {
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        cwd: workspacePath,
        parentThreadId: request.parentThreadId,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      }),
    );
    const contained: SubagentSnapshot[] = [];
    for (const thread of array(response.data).map((value) => normalizeThread(asRecord(value)))) {
      try {
        await this.assertThread(thread);
        contained.push(thread);
      } catch {
        // Ignore app-server entries outside the explicitly configured roots.
      }
    }
    return contained;
  }

  async steer(threadId: string, message: string): Promise<SubagentSnapshot> {
    const inspected = await this.inspect(threadId);
    if (!inspected.activeTurnId)
      throw new Error('Cannot steer an idle subagent; use follow_up instead');
    await this.request('turn/steer', {
      threadId,
      expectedTurnId: inspected.activeTurnId,
      input: [{ type: 'text', text: message, text_elements: [] }],
    });
    return { ...inspected, status: 'running' };
  }

  followUp(
    threadId: string,
    message: string,
    options?: { reasoningEffort?: string },
  ): Promise<SubagentRunResult> {
    return this.run(threadId, message, options);
  }

  async wait(
    threadId: string,
    options?: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: SubagentWaitSignal;
    },
  ): Promise<SubagentSnapshot> {
    const deadline =
      options?.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    const pollIntervalMs = options?.pollIntervalMs ?? 500;
    while (true) {
      throwIfAborted(options?.signal);
      const thread = await this.inspect(threadId);
      if (thread.status !== 'running' && thread.status !== 'starting') return thread;
      if (deadline !== undefined && Date.now() >= deadline) return thread;
      await delay(
        deadline === undefined
          ? pollIntervalMs
          : Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
        options?.signal,
      );
    }
  }

  async cancel(threadId: string): Promise<SubagentSnapshot> {
    const inspectForCancellation = async (): Promise<SubagentSnapshot & { transcript?: readonly JsonObject[] }> => {
      while (true) {
        try {
          return await this.inspect(threadId);
        } catch (error) {
          if (
            !this.pendingRunThreadIds.has(threadId) ||
            !isPendingThreadMetadataError(error)
          ) {
            throw error;
          }
          await delay(CANCEL_POLL_INTERVAL_MS);
        }
      }
    };
    let inspected = await inspectForCancellation();
    let turnId = inspected.activeTurnId ?? this.activeTurnIds.get(threadId);
    while (!turnId && this.pendingRunThreadIds.has(threadId)) {
      await delay(CANCEL_POLL_INTERVAL_MS);
      inspected = await inspectForCancellation();
      turnId = inspected.activeTurnId ?? this.activeTurnIds.get(threadId);
    }
    if (!turnId) return inspected;
    await this.request('turn/interrupt', {
      threadId,
      turnId,
    });
    do {
      inspected = await inspectForCancellation();
      if (
        !this.pendingRunThreadIds.has(threadId) &&
        inspected.status !== 'running' &&
        inspected.status !== 'starting' &&
        !inspected.activeTurnId
      ) {
        return inspected;
      }
      await delay(CANCEL_POLL_INTERVAL_MS);
    } while (true);
  }

  async inspect(
    threadId: string,
  ): Promise<SubagentSnapshot & { transcript?: readonly JsonObject[] }> {
    const readOptions = this.ephemeralThreadIds.has(threadId)
      ? { threadId }
      : { threadId, includeTurns: true };
    const response = asRecord(await this.request('thread/read', readOptions));
    const raw = asRecord(response.thread);
    const thread = normalizeThread(raw);
    await this.assertThread(thread);
    const turns = array(raw.turns).map((turn) => normalizeTurn(asRecord(turn)));
    const active = [...turns].reverse().find((turn) => turn.status === 'inProgress');
    const lastResponse = [...turns]
      .reverse()
      .map((turn) => extractResponse(turn))
      .find(Boolean);
    return {
      ...thread,
      activeTurnId: typeof active?.id === 'string' ? active.id : undefined,
      lastResponse: lastResponse || thread.lastResponse,
      transcript: turns,
    };
  }

  async dispose(): Promise<void> {
    const child = this.process;
    if (this.process || this.startPromise) {
      this.failProcess(new Error('Codex app-server backend disposed'));
    }
    if (child && !child.killed) {
      child.stdin.end();
      child.kill();
    }
  }

  private async start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.startInternal();
    await this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const cliScript = this.options.codexCliScript ?? resolveCodexCliScript();
    const child = spawn(process.execPath, [cliScript, 'app-server', '--stdio'], {
      // An explicitly supplied environment is a host-owned trust decision. The default
      // carries only OS/runtime discovery variables, never arbitrary ambient credentials.
      env: this.options.env ? { ...this.options.env } : safeAmbientEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    child.once('error', (error) => this.failProcess(error));
    child.once('exit', (code, signal) =>
      this.failProcess(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`)),
    );
    await this.rawRequest('initialize', {
      clientInfo: {
        name: 'agent-runtime-codex-capabilities',
        title: 'Portable Agent Runtime',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }

  private async request(method: string, params: JsonObject): Promise<unknown> {
    await this.start();
    return this.rawRequest(method, params);
  }

  private rawRequest(method: string, params: JsonObject): Promise<unknown> {
    const child = this.process;
    if (!child?.stdin.writable) return Promise.reject(new Error('Codex app-server is not running'));
    const id = this.requestId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server method ${method}`));
      }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.process?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error(message.error.message ?? 'Codex app-server error'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const response = message.method.includes('requestApproval')
        ? { jsonrpc: '2.0', id: message.id, result: { decision: 'decline' } }
        : {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: `Portable Codex backend does not implement ${message.method}`,
            },
          };
      this.process?.stdin.write(`${JSON.stringify(response)}\n`);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private waitForNotification(
    method: string,
    predicate: (params: JsonObject) => boolean,
  ): Promise<JsonObject> {
    return new Promise((resolvePromise, reject) => {
      const listener = (message: JsonRpcMessage) => {
        if (message.method !== method || !predicate(message.params ?? {})) return;
        cleanup();
        resolvePromise(message.params ?? {});
      };
      const cleanup = () => {
        this.listeners.delete(listener);
        this.failureListeners.delete(failureListener);
      };
      const failureListener = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.listeners.add(listener);
      this.failureListeners.add(failureListener);
    });
  }

  private failProcess(error: Error): void {
    if (!this.process && !this.startPromise) return;
    this.process = undefined;
    this.startPromise = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failureListeners) listener(error);
    this.failureListeners.clear();
    this.ephemeralThreadIds.clear();
  }

  private async assertThread(thread: SubagentSnapshot): Promise<void> {
    await this.resolveAllowedWorkspace(thread.workspacePath);
  }

  private async resolveAllowedWorkspace(candidate: string): Promise<string> {
    for (const root of this.allowedWorkspaceRoots) {
      try {
        return await resolveContainedExistingDirectory(root, candidate, 'workspacePath');
      } catch {
        // Try the next explicit root.
      }
    }
    throw new Error('workspacePath is outside configured workspace/worktree roots');
  }
}

/** @internal Exposed for deterministic verification of the default credential boundary. */
export function safeAmbientEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SAFE_AMBIENT_ENV_KEYS.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
}

function resolveCodexCliScript(): string {
  const packageJson = require.resolve('@openai/codex/package.json');
  return join(dirname(packageJson), 'bin', 'codex.js');
}

function buildDeveloperInstructions(request: SpawnSubagentRequest): string | undefined {
  const sections = [
    request.role ? `You are the ${request.role} delegated agent.` : undefined,
    request.name ? `Delegation name: ${request.name}.` : undefined,
    request.worktree
      ? `Work only in the isolated worktree ${request.worktree.path} on branch ${request.worktree.branch}.`
      : undefined,
    request.developerInstructions,
  ].filter(Boolean);
  return sections.length ? sections.join('\n\n') : undefined;
}

function normalizeThread(raw: JsonObject): SubagentSnapshot {
  const cwd = raw.cwd;
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('Codex thread cwd must be a non-empty path');
  }
  const statusRecord = asRecord(raw.status);
  const statusType = String(statusRecord.type ?? raw.status ?? 'unknown');
  const turns = array(raw.turns).map((turn) => asRecord(turn));
  const active = [...turns].reverse().find((turn) => turn.status === 'inProgress');
  return {
    id: String(raw.id ?? ''),
    status: mapStatus(statusType),
    workspacePath: resolve(cwd),
    name: nullableString(raw.name) ?? nullableString(raw.agentNickname),
    parentId: nullableString(raw.parentThreadId),
    createdAt: timestamp(raw.createdAt),
    updatedAt: timestamp(raw.updatedAt),
    activeTurnId: typeof active?.id === 'string' ? active.id : undefined,
    metadata: {
      sessionId: raw.sessionId,
      forkedFromId: raw.forkedFromId,
      role: raw.agentRole,
      source: raw.source,
      worktree: raw.gitInfo,
    },
  };
}

function normalizeTurn(raw: JsonObject): JsonObject {
  return {
    id: raw.id,
    status: raw.status,
    error: raw.error,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    items: normalizeItems(raw.items),
  };
}

function normalizeItems(value: unknown): JsonObject[] {
  return array(value)
    .map((entry) => {
      const item = asRecord(entry);
      return {
        id: item.id,
        type: item.type,
        status: item.status,
        text: item.text,
        command: item.command,
        aggregatedOutput: item.aggregatedOutput,
        exitCode: item.exitCode,
        error: item.error,
      };
    });
}

function extractResponse(turn: JsonObject): string {
  return normalizeItems(turn.items)
    .filter((item) => item.type === 'agentMessage' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function mapStatus(status: string): SubagentStatus {
  if (status === 'active' || status === 'inProgress') return 'running';
  if (status === 'idle' || status === 'completed') return 'idle';
  if (status === 'systemError' || status === 'failed') return 'failed';
  if (status === 'starting') return 'starting';
  return 'unknown';
}

function timestamp(value: unknown): string | undefined {
  return typeof value === 'number' ? new Date(value * 1_000).toISOString() : undefined;
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function delay(ms: number, signal?: SubagentWaitSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal?.addEventListener) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener?.('abort', abort);
      resolvePromise();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener?.('abort', abort);
      reject(abortReason(signal));
    };
    signal.addEventListener?.('abort', abort, { once: true });
  });
}

function throwIfAborted(signal?: SubagentWaitSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: SubagentWaitSignal): unknown {
  return signal.reason ?? Object.assign(new Error('Observation was aborted.'), {
    name: 'AbortError',
  });
}

function isPendingThreadMetadataError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.startsWith('failed to read thread: thread-store internal error:') &&
    message.includes('failed to read session metadata') &&
    message.includes('rollout at ') &&
    message.endsWith(' is empty')
  );
}
