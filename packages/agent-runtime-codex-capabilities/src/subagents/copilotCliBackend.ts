import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveContainedExistingDirectory } from '../pathSafety.js';
import type {
  SpawnSubagentRequest,
  SubagentBackend,
  SubagentListRequest,
  SubagentRunResult,
  SubagentSnapshot,
  SubagentWaitSignal,
} from './types.js';
import type { JsonObject } from '../coreTypes.js';

const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_REASONING_EFFORT = 'medium';
const SAFE_ENV_KEYS = [
  'APPDATA', 'HOME', 'LOCALAPPDATA', 'PATH', 'Path', 'PATHEXT', 'SystemRoot',
  'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR', 'NO_COLOR', 'TERM',
] as const;

type Session = {
  snapshot: SubagentSnapshot;
  process?: ChildProcessWithoutNullStreams;
  run?: Promise<SubagentRunResult>;
  response?: string;
  error?: string;
  interruption?: 'pause' | 'cancel';
  started?: boolean;
};

export interface CopilotCliBackendOptions {
  readonly workspaceRoot: string;
  readonly additionalWorkspaceRoots?: readonly string[];
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly yolo?: boolean;
};

export class CopilotCliBackend implements SubagentBackend {
  private readonly workspaceRoot: string;
  private readonly allowedWorkspaceRoots: readonly string[];
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: CopilotCliBackendOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.allowedWorkspaceRoots = [
      this.workspaceRoot,
      ...(options.additionalWorkspaceRoots ?? []).map((root) => resolve(root)),
    ];
  }

  async spawn(request: SpawnSubagentRequest): Promise<SubagentSnapshot> {
    const workspacePath = await this.resolveAllowedWorkspace(request.workspacePath);
    const id = randomUUID();
    const snapshot: SubagentSnapshot = {
      id,
      status: 'idle',
      workspacePath,
      name: request.name,
      parentId: request.parentThreadId,
      model: request.model ?? this.options.model ?? DEFAULT_MODEL,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        backend: 'copilot',
        sessionId: id,
        role: request.role,
        worktree: request.worktree,
      },
    };
    this.sessions.set(id, { snapshot });
    return snapshot;
  }

  async run(
    threadId: string,
    prompt: string,
    options: { reasoningEffort?: string } = {},
  ): Promise<SubagentRunResult> {
    const session = this.requireSession(threadId);
    if (session.run) throw new Error(`Copilot session "${threadId}" already has an active run.`);
    const effort = options.reasoningEffort ?? this.options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    session.interruption = undefined;
    const promise = this.startRun(session, prompt, effort)
      .catch((error) => failedResult(session, error))
      .finally(() => {
        if (session.run === promise) session.run = undefined;
      });
    session.run = promise;
    return promise;
  }

  async list(request: SubagentListRequest): Promise<readonly SubagentSnapshot[]> {
    const workspacePath = request.workspacePath
      ? await this.resolveAllowedWorkspace(request.workspacePath)
      : undefined;
    const snapshots = [...this.sessions.values()]
      .map((session) => session.snapshot)
      .filter((snapshot) =>
        (!workspacePath || normalize(snapshot.workspacePath) === normalize(workspacePath))
        && (!request.parentThreadId || snapshot.parentId === request.parentThreadId));
    return request.limit === undefined ? snapshots : snapshots.slice(0, request.limit);
  }

  async steer(threadId: string, _message: string): Promise<SubagentSnapshot> {
    this.requireSession(threadId);
    throw new Error('Copilot CLI non-interactive sessions do not support active steering.');
  }

  async pause(threadId: string, _reason: string): Promise<SubagentSnapshot> {
    const session = this.requireSession(threadId);
    if (!session.process || !session.run) return this.snapshot(session);
    session.interruption = 'pause';
    await killOwnedProcessTree(session.process);
    await session.run;
    return this.snapshot(session);
  }

  followUp(
    threadId: string,
    message: string,
    options?: { reasoningEffort?: string },
  ): Promise<SubagentRunResult> {
    const session = this.requireSession(threadId);
    if (session.run) throw new Error(`Copilot session "${threadId}" already has an active run.`);
    return this.run(threadId, message, options);
  }

  async wait(
    threadId: string,
    options?: { timeoutMs?: number; pollIntervalMs?: number; signal?: SubagentWaitSignal },
  ): Promise<SubagentSnapshot> {
    const session = this.requireSession(threadId);
    if (!session.run) return this.snapshot(session);
    if (options?.timeoutMs === undefined) {
      await raceAbort(session.run, options?.signal);
    } else {
      await raceAbort(session.run, options.signal, options.timeoutMs);
    }
    return this.snapshot(session);
  }

  async cancel(threadId: string): Promise<SubagentSnapshot> {
    const session = this.requireSession(threadId);
    session.interruption = 'cancel';
    if (session.process && !session.process.killed) await killOwnedProcessTree(session.process);
    if (session.run) {
      try { await session.run; } catch { /* the failed snapshot is returned below */ }
    }
    return this.snapshot(session);
  }

  async inspect(threadId: string): Promise<SubagentSnapshot & { transcript?: readonly JsonObject[] }> {
    const session = this.requireSession(threadId);
    return { ...this.snapshot(session), ...(session.error ? { transcript: [{ status: 'failed', error: session.error }] } : {}) };
  }

  async dispose(): Promise<void> {
    const settling: Promise<unknown>[] = [];
    for (const session of this.sessions.values()) {
      session.interruption = 'cancel';
      if (session.process && !session.process.killed) {
        settling.push(killOwnedProcessTree(session.process));
      }
      if (session.run) settling.push(session.run);
    }
    await Promise.allSettled(settling);
    this.sessions.clear();
  }

  private async startRun(session: Session, prompt: string, effort: string): Promise<SubagentRunResult> {
    const command = await resolveCopilotCommand(this.options.executable);
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--model', session.snapshot.model ?? DEFAULT_MODEL,
      '--effort', effort,
      '-C', session.snapshot.workspacePath,
      '--no-remote',
      '--no-remote-export',
    ];
    if (session.started) args.push(`--resume=${session.snapshot.id}`);
    else args.push('--session-id', session.snapshot.id);
    if (this.options.yolo) args.push('--yolo');
    const child = spawn(command.file, [...command.args, ...args], {
      cwd: session.snapshot.workspacePath,
      env: this.options.env ? { ...this.options.env } : safeEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    session.process = child;
    session.started = true;
    child.stdin.end();
    session.snapshot = { ...session.snapshot, status: 'running', activeTurnId: session.snapshot.id };
    const finalMessageIds = new Set<string>();
    const deltaParts: string[] = [];
    let finalResponse: string | undefined;
    let stderr = '';
    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      const event = parseJson(line);
      if (!event || typeof event.type !== 'string') return;
      const data = event?.data && typeof event.data === 'object' ? event.data as JsonObject : undefined;
      if (
        event.type === 'assistant.message_start'
        && data?.phase === 'final_answer'
        && typeof data.messageId === 'string'
      ) {
        finalMessageIds.add(data.messageId);
      } else if (
        event.type === 'assistant.message_delta'
        && typeof data?.messageId === 'string'
        && finalMessageIds.has(data.messageId)
        && typeof data.deltaContent === 'string'
      ) {
        deltaParts.push(data.deltaContent);
      } else if (
        event.type === 'assistant.message'
        && data?.phase === 'final_answer'
        && typeof data.content === 'string'
      ) {
        finalResponse = data.content;
      }
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderr = appendBounded(stderr, sanitize(line), 8_000);
    });
    return new Promise<SubagentRunResult>((resolvePromise) => {
      let finished = false;
      child.once('error', (error) => finish(error));
      child.once('close', (code, signal) => {
        stdout.close();
        if (session.interruption) {
          const action = session.interruption === 'pause' ? 'paused' : 'cancelled';
          finish(new Error(`Copilot CLI ${action} (${code ?? signal ?? 'unknown'})`));
        } else if (code === 0 && (finalResponse ?? deltaParts.join('')).trim()) finish();
        else finish(new Error(`Copilot CLI exited (${code ?? signal ?? 'unknown'})${stderr.trim() ? `: ${stderr.trim()}` : ': no response'}`));
      });
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        const response = finalResponse ?? deltaParts.join('');
        session.process = undefined;
        session.response = response;
        session.error = session.interruption === 'pause' ? undefined : error?.message;
        session.snapshot = {
          ...session.snapshot,
          status: error && session.interruption !== 'pause' ? 'failed' : 'idle',
          updatedAt: new Date().toISOString(),
          ...(response ? { lastResponse: response } : {}),
          activeTurnId: undefined,
        };
        resolvePromise({
          thread: this.snapshot(session),
          response,
          status: error ? (session.interruption ? 'interrupted' : 'failed') : 'completed',
          ...(error ? { error } : {}),
        });
      };
    });
  }

  private requireSession(threadId: string): Session {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`Copilot session "${threadId}" was not found.`);
    return session;
  }

  private snapshot(session: Session): SubagentSnapshot {
    return { ...session.snapshot, ...(session.process ? { activeTurnId: session.snapshot.id } : {}) };
  }

  private async resolveAllowedWorkspace(candidate: string): Promise<string> {
    for (const root of this.allowedWorkspaceRoots) {
      try { return await resolveContainedExistingDirectory(root, candidate, 'workspacePath'); } catch { /* try next root */ }
    }
    throw new Error('workspacePath is outside configured workspace/worktree roots');
  }
}

async function resolveCopilotCommand(executable?: string): Promise<{ file: string; args: string[] }> {
  const candidate = executable ?? 'copilot';
  if (process.platform !== 'win32') {
    return /\.(?:js|mjs|cjs)$/i.test(candidate)
      ? { file: process.execPath, args: [candidate] }
      : { file: candidate, args: [] };
  }
  if (/\.exe$/i.test(candidate)) return { file: candidate, args: [] };
  const pathEntries = (process.env.PATH ?? '').split(';').filter(Boolean);
  const candidates = candidate.includes('\\')
    ? [candidate]
    : pathEntries.flatMap((entry) => [
        join(entry, candidate),
        join(entry, `${candidate}.cmd`),
        join(entry, `${candidate}.ps1`),
      ]);
  for (const direct of candidates) {
    try {
      await access(direct);
      const native = await nativeCopilotExecutable(direct);
      return { file: native, args: [] };
    } catch { /* try the next PATH candidate */ }
  }
  throw new Error(`Copilot executable "${candidate}" could not be resolved safely.`);
}

async function nativeCopilotExecutable(candidate: string): Promise<string> {
  const platformPackage =
    process.arch === 'arm64' ? 'copilot-win32-arm64' : 'copilot-win32-x64';
  const packageRoot = /npm-loader\.js$/i.test(candidate)
    ? dirname(candidate)
    : join(dirname(candidate), 'node_modules', '@github', 'copilot');
  const native = join(
    packageRoot,
    'node_modules',
    '@github',
    platformPackage,
    'copilot.exe',
  );
  await access(native);
  return native;
}

async function killOwnedProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  const pid = child.pid;
  if (!pid) return;
  const script = [
    `$root=${pid}`,
    '$all=Get-CimInstance Win32_Process',
    'function descendants([int]$id){',
    '  foreach($p in $all){',
    '    if($p.ParentProcessId -eq $id){ descendants $p.ProcessId; $p.ProcessId }',
    '  }',
    '}',
    '$ids=@(descendants $root)+$root',
    'foreach($id in $ids){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
  ].join(';');
  await new Promise<void>((resolvePromise) => {
    const killer = spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: 'ignore', windowsHide: true },
    );
    killer.once('close', () => resolvePromise());
    killer.once('error', () => {
      child.kill();
      resolvePromise();
    });
  });
}

function failedResult(session: Session, error: unknown): SubagentRunResult {
  const failure = error instanceof Error ? error : new Error(String(error));
  session.process = undefined;
  session.error = sanitize(failure.message);
  session.snapshot = {
    ...session.snapshot,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    activeTurnId: undefined,
  };
  return {
    thread: { ...session.snapshot },
    response: '',
    status: 'failed',
    error: new Error(session.error),
  };
}

function appendBounded(current: string, line: string, maxLength: number): string {
  const appended = `${current}${line}\n`;
  return appended.length <= maxLength ? appended : appended.slice(appended.length - maxLength);
}

function parseJson(line: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
  } catch { return undefined; }
}

function sanitize(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/((?:token|secret|password|authorization|api[-_]?key)[=:]\s*)[^\s"'<>]+/gi, '$1[REDACTED]');
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(SAFE_ENV_KEYS.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

function normalize(value: string): string {
  const resolved = resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function raceAbort<T>(promise: Promise<T>, signal?: SubagentWaitSignal, timeoutMs?: number): Promise<T> {
  if (!signal && timeoutMs === undefined) return promise;
  if (signal?.aborted) throw signal.reason ?? new Error('Observation was aborted.');
  return new Promise<T>((resolvePromise, reject) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => resolvePromise(undefined as T), timeoutMs);
    const abort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason ?? new Error('Observation was aborted.'));
    };
    signal?.addEventListener?.('abort', abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    });
  });
}
