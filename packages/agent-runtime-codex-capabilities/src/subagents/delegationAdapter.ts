import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DelegationAdapterPort,
  DelegationAdapterSnapshot,
  DelegationAdapterSpawnRequest,
  DelegationContext,
  DelegationState,
  JsonValue,
} from '@marshal/agent-runtime-delegation';
import { resolveContainedExistingDirectory, resolveContainedPath } from '../pathSafety.js';
import { WorktreeCreationError } from './gitWorktreeProvisioner.js';
import type {
  SubagentBackend,
  SubagentBackendName,
  SubagentRunResult,
  SubagentScopeInheritancePersister,
  SubagentSnapshot,
  WorktreeProvisioner,
} from './types.js';

const WORKTREE_CREATE_ATTEMPTS = 3;
const execFileAsync = promisify(execFile);
const DEFAULT_PAUSE_MESSAGE =
  'Pause cooperatively at the next safe point. Preserve current progress and await further instructions.';

export interface CodexDelegationAdapterOptions {
  readonly backend: SubagentBackend;
  readonly workspaceRoot: string;
  readonly worktreeProvisioner?: WorktreeProvisioner;
  /** Explicit extra containment roots, normally the configured worktree root. */
  readonly additionalWorkspaceRoots?: readonly string[];
  readonly persistScopeInheritance?: SubagentScopeInheritancePersister;
}

async function gitChangeRefs(
  worktree: Worktree,
  role: string | undefined,
): Promise<readonly string[]> {
  const { path } = worktree;
  const status = (await execFileAsync('git', ['-C', path, 'status', '--porcelain'])).stdout.trim();
  if (status && shouldSnapshotRole(role)) {
    await execFileAsync('git', ['-C', path, 'add', '--all']);
    await execFileAsync('git', [
      '-C',
      path,
      '-c',
      'user.name=Marshal Runtime',
      '-c',
      'user.email=marshal-runtime@localhost',
      'commit',
      '-m',
      'Snapshot delegated agent changes',
    ]);
  }
  if (status && !shouldSnapshotRole(role)) return [];
  const head = (await execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim();
  return head && head !== worktree.baseCommit ? [head] : [];
}

type TrackedRun =
  | { readonly run: SubagentRunResult }
  | { readonly error: JsonValue };

type Worktree = {
  readonly path: string;
  readonly branch: string;
  readonly baseCommit?: string;
};

type EnvironmentalWorktreeError = {
  readonly kind: 'environmental';
  readonly category: string;
  readonly operation: 'worktree.create';
  readonly attempts: 3;
  readonly message: string;
  readonly code: string;
};

/** Detachable Codex edge for the harness-neutral delegation transport. */
export class CodexDelegationAdapter implements DelegationAdapterPort {
  private readonly workspaceRoot: string;
  private readonly allowedWorkspaceRoots: readonly string[];
  private readonly activeRuns = new Map<string, Promise<TrackedRun>>();

  constructor(private readonly options: CodexDelegationAdapterOptions) {
    this.workspaceRoot = resolveContainedPath(options.workspaceRoot, undefined, 'workspaceRoot');
    this.allowedWorkspaceRoots = [
      this.workspaceRoot,
      ...(options.additionalWorkspaceRoots ?? []).map((root) =>
        resolveContainedPath(root, undefined, 'additionalWorkspaceRoot'),
      ),
    ];
  }

  async spawn(
    { request }: DelegationAdapterSpawnRequest,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    throwIfAborted(context);
    const workspaceMode = workspaceModeOf(request);
    let workspacePath = await this.resolveKnownWorkspace(
      this.workspaceRoot,
      'delegation workspace',
    );
    let worktree: Worktree | undefined;
    if (workspaceMode === 'isolated') {
      const provisioned = await this.provisionIsolatedWorkspace(request);
      if ('failure' in provisioned) {
        return {
          state: 'failed',
          error: provisioned.failure,
        };
      }
      worktree = provisioned.worktree;
      try {
        workspacePath = await this.resolveKnownWorkspace(worktree.path, 'worktree path');
        throwIfAborted(context);
      } catch (error) {
        await this.releaseBeforeSpawn(worktree, error);
      }
    }
    let thread: SubagentSnapshot;
    try {
      thread = await this.options.backend.spawn({
        workspacePath,
        ephemeral: false,
        ...(request.backend === undefined ? {} : { backend: supportedBackend(request.backend) }),
        ...(request.role === undefined ? {} : { role: request.role }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(worktree === undefined ? {} : { worktree, baseRef: request.baseRef }),
      });
    } catch (error) {
      if (worktree) await this.releaseBeforeSpawn(worktree, error);
      throw error;
    }

    await this.cancelAbortedSpawn(thread.id, context);

    try {
      await this.assertSnapshot(thread, workspacePath);
    } catch (error) {
      if (context.signal?.aborted) {
        await this.cancelAbortedSpawn(thread.id, context);
      }
      return {
        adapterHandle: thread.id,
        state: 'failed',
        error: plainError(error),
      };
    }
    await this.cancelAbortedSpawn(thread.id, context);
    try {
      if (this.options.persistScopeInheritance) {
        if (!context.invocation) {
          throw new Error('Delegation scope inheritance requires a trusted invocation context.');
        }
        await this.options.persistScopeInheritance(context.invocation, thread.id);
      }
      const run = request.reasoningEffort === undefined
        ? this.options.backend.run(thread.id, request.prompt)
        : this.options.backend.run(thread.id, request.prompt, {
            reasoningEffort: request.reasoningEffort,
          });
      this.trackRun(thread.id, run.then(async (result) => ({
        ...result,
        changeRefs: result.changeRefs
          ?? (worktree ? await gitChangeRefs(worktree, request.role) : undefined),
      })));
      return snapshot(thread.id, 'running', thread);
    } catch (error) {
      if (context.signal?.aborted) {
        await this.cancelAbortedSpawn(thread.id, context);
      }
      return {
        adapterHandle: thread.id,
        state: 'failed',
        error: plainError(error),
      };
    }
  }

  async pause(
    adapterHandle: string,
    reason: string,
    context: DelegationContext,
  ): Promise<void> {
    throwIfAborted(context);
    const inspected = await this.options.backend.inspect(adapterHandle);
    await this.assertKnownSnapshot(inspected);
    throwIfAborted(context);
    if (!inspected.activeTurnId) return;
    if (this.options.backend.pause) {
      const paused = await this.options.backend.pause(adapterHandle, reason);
      await this.assertKnownSnapshot(paused);
      this.activeRuns.delete(adapterHandle);
      return;
    }
    const detail = reason.trim();
    const message = detail ? `${DEFAULT_PAUSE_MESSAGE} Reason: ${detail}` : DEFAULT_PAUSE_MESSAGE;
    let steered: SubagentSnapshot;
    try {
      steered = await this.options.backend.steer(adapterHandle, message);
    } catch (steerError) {
      try {
        const current = await this.options.backend.inspect(adapterHandle);
        await this.assertKnownSnapshot(current);
        if (current.status === 'idle' && !current.activeTurnId) return;
      } catch (inspectionError) {
        throw new AggregateError(
          [steerError, inspectionError],
          `Delegation "${adapterHandle}" could not be paused or re-inspected.`,
        );
      }
      throw steerError;
    }
    await this.assertKnownSnapshot(steered);
  }

  async continue(
    adapterHandle: string,
    prompt: string,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    throwIfAborted(context);
    const inspected = await this.options.backend.inspect(adapterHandle);
    await this.assertKnownSnapshot(inspected);
    throwIfAborted(context);
    this.trackRun(
      adapterHandle,
      this.options.backend.followUp(adapterHandle, prompt).then(async (result) => ({
        ...result,
        changeRefs: result.changeRefs
          ?? await changeRefsFromSnapshot(result.thread)
          ?? await changeRefsFromSnapshot(inspected),
      })),
    );
    return { adapterHandle, state: 'running' };
  }

  async wait(
    adapterHandle: string,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    const active = this.activeRuns.get(adapterHandle);
    if (active) {
      const tracked = await raceAbort(active, context);
      if ('run' in tracked) await this.assertKnownSnapshot(tracked.run.thread);
      return this.resultSnapshot(adapterHandle, tracked);
    }
    throwIfAborted(context);
    const inspected = await (
      context.signal
        ? this.options.backend.wait(adapterHandle, { signal: context.signal })
        : this.options.backend.wait(adapterHandle)
    );
    await this.assertKnownSnapshot(inspected);
    return inspectionSnapshot(adapterHandle, stateFromInspection(inspected), inspected);
  }

  async cancel(
    adapterHandle: string,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    throwIfAborted(context);
    const thread = await this.options.backend.cancel(adapterHandle);
    await this.assertKnownSnapshot(thread);
    return terminalCancellationSnapshot(adapterHandle, thread);
  }

  private trackRun(threadId: string, run: Promise<SubagentRunResult>): void {
    const tracked = run.then<TrackedRun, TrackedRun>(
      (result) => ({ run: result }),
      (error) => ({ error: plainError(error) }),
    );
    this.activeRuns.set(threadId, tracked);
  }

  private async provisionIsolatedWorkspace(
    request: DelegationAdapterSpawnRequest['request'],
  ): Promise<
    | { readonly worktree: Worktree }
    | { readonly failure: EnvironmentalWorktreeError }
  > {
    const provisioner = this.options.worktreeProvisioner;
    if (!provisioner) {
      throw new Error('workspaceMode "isolated" requires a configured WorktreeProvisioner.');
    }
    for (let attempt = 1; attempt <= WORKTREE_CREATE_ATTEMPTS; attempt += 1) {
      try {
        return {
          worktree: await provisioner.provision({
            workspacePath: this.workspaceRoot,
            name: request.role,
            baseRef: request.baseRef,
          }),
        };
      } catch (error) {
        if (!(error instanceof WorktreeCreationError) || !error.retryable) throw error;
        if (attempt === WORKTREE_CREATE_ATTEMPTS) {
          return {
            failure: {
              kind: error.kind,
              category: error.category,
              operation: error.operation,
              attempts: WORKTREE_CREATE_ATTEMPTS,
              message: error.message,
              code: error.code,
            },
          };
        }
      }
    }
    throw new Error('Unreachable worktree provisioning state.');
  }

  private async releaseBeforeSpawn(worktree: Worktree, error: unknown): Promise<never> {
    const provisioner = this.options.worktreeProvisioner;
    if (!provisioner) throw error;
    try {
      await provisioner.release(worktree, 'spawn_failed');
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Isolated worktree "${worktree.path}" could not be released after spawn failed.`,
      );
    }
    throw error;
  }

  private async resultSnapshot(
    adapterHandle: string,
    tracked: TrackedRun,
  ): Promise<DelegationAdapterSnapshot> {
    if ('error' in tracked) {
      return {
        adapterHandle,
        state: 'failed',
        error: tracked.error,
      };
    }
    const result = tracked.run;
    await this.assertKnownSnapshot(result.thread);
    const state: DelegationState =
      result.status === 'completed' ? 'done' : 'failed';
    if (state === 'failed') {
      return {
        adapterHandle,
        state,
        error: plainError(result.error === undefined ? result.response : result.error),
        ...(result.changeRefs === undefined ? {} : { changeRefs: result.changeRefs }),
      };
    }
    return snapshot(
      adapterHandle,
      state,
      result.thread,
      result.response,
      result.changeRefs,
    );
  }

  private async assertSnapshot(thread: SubagentSnapshot, workspacePath: string): Promise<void> {
    const actual = await this.resolveKnownWorkspace(thread.workspacePath, 'subagent workspacePath');
    if (normalizePath(actual) !== normalizePath(workspacePath)) {
      throw new Error('Codex backend returned a different workspace path.');
    }
  }

  private async assertKnownSnapshot(thread: SubagentSnapshot): Promise<void> {
    await this.resolveKnownWorkspace(thread.workspacePath, 'subagent workspacePath');
  }

  private async resolveKnownWorkspace(candidate: string, field: string): Promise<string> {
    for (const root of this.allowedWorkspaceRoots) {
      try {
        return await resolveContainedExistingDirectory(root, candidate, field);
      } catch {
        // Try the next configured root.
      }
    }
    throw new Error(`${field} is outside configured roots or is unsafe.`);
  }

  private async cancelAbortedSpawn(
    adapterHandle: string,
    context: DelegationContext,
  ): Promise<void> {
    if (!context.signal?.aborted) return;
    try {
      await this.options.backend.cancel(adapterHandle);
    } catch (cancelError) {
      throw new AggregateError(
        [abortReason(context), cancelError],
        `Spawned host session "${adapterHandle}" could not be cancelled after abort.`,
      );
    }
    throwIfAborted(context);
  }
}

async function changeRefsFromSnapshot(
  snapshot: SubagentSnapshot,
): Promise<readonly string[] | undefined> {
  const worktree = asWorktree(snapshot.metadata?.worktree);
  if (!worktree) return undefined;
  const role = typeof snapshot.metadata?.role === 'string' ? snapshot.metadata.role : undefined;
  return gitChangeRefs(worktree, role);
}

function asWorktree(value: unknown): Worktree | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== 'string' || typeof record.branch !== 'string') return undefined;
  return {
    path: record.path,
    branch: record.branch,
    ...(typeof record.baseCommit === 'string' ? { baseCommit: record.baseCommit } : {}),
  };
}

function shouldSnapshotRole(role: string | undefined): boolean {
  const normalized = role?.trim().toLowerCase();
  if (!normalized || normalized.includes('reviewer') || normalized.includes('planner')) return false;
  return normalized.includes('worker') || normalized.includes('reconciler');
}

function snapshot(
  adapterHandle: string,
  state: DelegationState,
  thread: SubagentSnapshot,
  result?: string,
  changeRefs?: readonly string[],
): DelegationAdapterSnapshot {
  const value = state === 'done' ? result ?? thread.lastResponse : undefined;
  return {
    adapterHandle,
    state,
    ...(value === undefined ? {} : { result: value }),
    ...(changeRefs === undefined ? {} : { changeRefs }),
  };
}

function inspectionSnapshot(
  adapterHandle: string,
  state: DelegationState,
  thread: SubagentSnapshot & { transcript?: readonly Record<string, unknown>[] },
): DelegationAdapterSnapshot {
  if (state !== 'failed') return snapshot(adapterHandle, state, thread);
  const failedTurn = [...(thread.transcript ?? [])]
    .reverse()
    .find((turn) => turn.status === 'failed' || turn.status === 'interrupted');
  const error =
    failedTurn?.error
    ?? (failedTurn?.status === 'interrupted' ? 'cancelled' : thread.lastResponse);
  return {
    adapterHandle,
    state,
    ...(error === undefined ? {} : { error: plainError(error) }),
  };
}

function stateFromInspection(
  thread: SubagentSnapshot & { transcript?: readonly Record<string, unknown>[] },
): DelegationState {
  if (thread.status === 'running') return 'running';
  if (thread.status === 'starting') return 'pending';
  if (thread.status === 'failed') return 'failed';
  const status = String(thread.transcript?.at(-1)?.status ?? '');
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'failed';
  if (status === 'completed' || thread.status === 'idle') return 'done';
  return 'running';
}

function terminalCancellationSnapshot(
  adapterHandle: string,
  thread: SubagentSnapshot & { transcript?: readonly Record<string, unknown>[] },
): DelegationAdapterSnapshot {
  const observed = stateFromInspection(thread);
  return inspectionSnapshot(
    adapterHandle,
    observed === 'running' || observed === 'pending' ? 'failed' : observed,
    thread,
  );
}

function normalizePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function workspaceModeOf(
  request: DelegationAdapterSpawnRequest['request'],
): 'shared' | 'isolated' {
  const mode = (request as DelegationAdapterSpawnRequest['request'] & {
    readonly workspaceMode?: unknown;
  }).workspaceMode;
  if (mode === undefined || mode === 'shared') return 'shared';
  if (mode === 'isolated') return 'isolated';
  throw new TypeError('workspaceMode must be "shared" or "isolated".');
}

function supportedBackend(value: string): SubagentBackendName {
  if (value === 'codex' || value === 'copilot') return value;
  throw new TypeError('backend must be "codex" or "copilot".');
}

function throwIfAborted(context: DelegationContext): void {
  if (!context.signal?.aborted) return;
  throw abortReason(context);
}

function abortReason(context: DelegationContext): unknown {
  return context.signal?.reason ?? Object.assign(new Error('Delegation was cancelled.'), {
    name: 'AbortError',
  });
}

async function raceAbort<T>(
  promise: Promise<T>,
  context: DelegationContext,
): Promise<T> {
  const signal = context.signal;
  if (!signal) return promise;
  throwIfAborted(context);
  if (!signal.addEventListener) return promise;
  let listener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () =>
      reject(
        signal.reason ??
          Object.assign(new Error('Delegation was cancelled.'), { name: 'AbortError' }),
      );
    signal.addEventListener?.('abort', listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener?.('abort', listener);
  }
}

function plainError(error: unknown): JsonValue {
  if (error instanceof Error) return error.message;
  if (isJsonValue(error)) return error;
  return String(error);
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== 'object' || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}
