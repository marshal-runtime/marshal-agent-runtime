import type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationCancellationSignal,
  InvocationContext,
  JsonObject,
} from '../coreTypes.js';
import { RUNTIME_PROTOCOL_VERSION, asObject, optionalString, requireString } from '../coreTypes.js';
import { resolveContainedExistingDirectory, resolveContainedPath } from '../pathSafety.js';
import type {
  SubagentBackend,
  SubagentScopeInheritancePersister,
  SubagentSnapshot,
  WorktreeProvisioner,
} from './types.js';

const VERSION = '1.0.0';
const CANCELLATION_SETTLE_TIMEOUT_MS = 5_000;
const OPERATIONS = [
  'codex.subagents.spawn',
  'codex.subagents.run',
  'codex.subagents.list',
  'codex.subagents.send',
  'codex.subagents.follow_up',
  'codex.subagents.wait',
  'codex.subagents.cancel',
  'codex.subagents.inspect',
] as const;

export interface CodexSubagentProviderOptions {
  backend: SubagentBackend;
  workspaceRoot: string;
  worktreeProvisioner?: WorktreeProvisioner;
  /** Explicit extra containment roots, normally the configured worktree root. */
  additionalWorkspaceRoots?: readonly string[];
  maxPromptCharacters?: number;
  maxWaitMs?: number;
  persistScopeInheritance?: SubagentScopeInheritancePersister;
}

export class CodexSubagentProvider implements CapabilityProvider {
  readonly id = 'codex.subagents';
  readonly version = VERSION;
  private readonly workspaceRoot: string;
  private readonly allowedWorkspaceRoots: readonly string[];

  constructor(private readonly options: CodexSubagentProviderOptions) {
    this.workspaceRoot = resolveContainedPath(options.workspaceRoot, undefined, 'workspaceRoot');
    this.allowedWorkspaceRoots = [
      this.workspaceRoot,
      ...(options.additionalWorkspaceRoots ?? []).map((root) =>
        resolveContainedPath(root, undefined, 'additionalWorkspaceRoot'),
      ),
    ];
  }

  list(): readonly CapabilityDescriptor[] {
    return OPERATIONS.map((name) => descriptor(name));
  }

  get(name: string): CapabilityDescriptor | undefined {
    return OPERATIONS.includes(name as (typeof OPERATIONS)[number])
      ? descriptor(name as (typeof OPERATIONS)[number])
      : undefined;
  }

  async invoke(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<CapabilityInvocationResult> {
    const args = asObject(input);
    switch (name) {
      case 'codex.subagents.spawn': {
        throwIfAlreadyAborted(context.signal);
        let workspacePath = await resolveContainedExistingDirectory(
          this.workspaceRoot,
          optionalString(args.workspacePath, 'workspacePath', 2_000) ?? this.workspaceRoot,
          'workspacePath',
        );
        let worktree: { path: string; branch: string; baseCommit?: string } | undefined;
        if (args.worktreeIsolation === true) {
          if (!this.options.worktreeProvisioner)
            throw new Error('worktreeIsolation requires a configured WorktreeProvisioner');
          worktree = await this.options.worktreeProvisioner.provision({
            workspacePath,
            name: optionalString(args.name, 'name', 128),
            branchName: optionalString(args.branchName, 'branchName', 200),
            baseRef: optionalString(args.baseRef, 'baseRef', 200),
          });
          workspacePath = await this.resolveKnownWorkspace(worktree.path, 'worktree path');
        }
        const prompt = optionalString(
          args.prompt,
          'prompt',
          this.options.maxPromptCharacters ?? 200_000,
        );
        const thread = await this.options.backend.spawn({
          workspacePath,
          backend: parseEnum(args.backend, ['codex', 'copilot'], 'backend'),
          prompt,
          name: optionalString(args.name, 'name', 128),
          role: optionalString(args.role, 'role', 128),
          model: optionalString(args.model, 'model', 128),
          reasoningEffort: optionalString(args.reasoningEffort, 'reasoningEffort', 32),
          developerInstructions: optionalString(
            args.developerInstructions,
            'developerInstructions',
            50_000,
          ),
          approvalPolicy: parseEnum(
            args.approvalPolicy,
            ['never', 'on-request', 'on-failure', 'untrusted'],
            'approvalPolicy',
          ),
          sandbox: parseEnum(
            args.sandbox,
            ['read-only', 'workspace-write', 'danger-full-access'],
            'sandbox',
          ),
          ephemeral: typeof args.ephemeral === 'boolean' ? args.ephemeral : undefined,
          parentThreadId: optionalThreadId(args.parentThreadId),
          worktree,
          baseRef: optionalString(args.baseRef, 'baseRef', 200),
        });
        await assertSnapshotContained(thread, workspacePath);
        await this.options.persistScopeInheritance?.(context, thread.id);
        const run = prompt
          ? await awaitChildTurn(
              () =>
                this.options.backend.run(thread.id, prompt, {
                  reasoningEffort: optionalString(args.reasoningEffort, 'reasoningEffort', 32),
                }),
              context.signal,
              () => this.options.backend.cancel(thread.id),
            )
          : undefined;
        if (run) await this.assertKnownSnapshot(run.thread);
        return result({ thread, run, worktree }, name, context);
      }
      case 'codex.subagents.run': {
        const threadId = requireThreadId(args.threadId);
        const run = await awaitChildTurn(
          () =>
            this.options.backend.run(
              threadId,
              requireString(args.prompt, 'prompt', this.options.maxPromptCharacters ?? 200_000),
              {
                reasoningEffort: optionalString(args.reasoningEffort, 'reasoningEffort', 32),
              },
            ),
          context.signal,
          () => this.options.backend.cancel(threadId),
        );
        await this.assertKnownSnapshot(run.thread);
        return result(run, name, context);
      }
      case 'codex.subagents.list': {
        const workspacePath =
          args.workspacePath === undefined
            ? undefined
            : await resolveContainedExistingDirectory(
                this.workspaceRoot,
                requireString(args.workspacePath, 'workspacePath', 2_000),
                'workspacePath',
              );
        const threads = await this.options.backend.list({
          workspacePath,
          parentThreadId: optionalThreadId(args.parentThreadId),
          limit: optionalPositiveInteger(args.limit, 'limit'),
        });
        for (const thread of threads) await this.assertKnownSnapshot(thread);
        return result({ threads }, name, context);
      }
      case 'codex.subagents.send': {
        const thread = await this.options.backend.steer(
          requireThreadId(args.threadId),
          requireString(args.message, 'message', this.options.maxPromptCharacters ?? 200_000),
        );
        await this.assertKnownSnapshot(thread);
        return result({ thread }, name, context);
      }
      case 'codex.subagents.follow_up': {
        const threadId = requireThreadId(args.threadId);
        const run = await awaitChildTurn(
          () =>
            this.options.backend.followUp(
              threadId,
              requireString(args.message, 'message', this.options.maxPromptCharacters ?? 200_000),
              {
                reasoningEffort: optionalString(args.reasoningEffort, 'reasoningEffort', 32),
              },
            ),
          context.signal,
          () => this.options.backend.cancel(threadId),
        );
        await this.assertKnownSnapshot(run.thread);
        return result(run, name, context);
      }
      case 'codex.subagents.wait': {
        const thread = await this.options.backend.wait(requireThreadId(args.threadId), {
          timeoutMs: integer(
            args.timeoutMs,
            1,
            this.options.maxWaitMs ?? 60_000,
            Math.min(30_000, this.options.maxWaitMs ?? 60_000),
          ),
          pollIntervalMs: integer(args.pollIntervalMs, 100, 5_000, 500),
        });
        await this.assertKnownSnapshot(thread);
        return result({ thread }, name, context);
      }
      case 'codex.subagents.cancel': {
        const thread = await this.options.backend.cancel(requireThreadId(args.threadId));
        await this.assertKnownSnapshot(thread);
        return result({ thread }, name, context);
      }
      case 'codex.subagents.inspect': {
        const thread = await this.options.backend.inspect(requireThreadId(args.threadId));
        await this.assertKnownSnapshot(thread);
        return result({ thread }, name, context);
      }
      default:
        throw new Error(`Unknown Codex subagent capability: ${name}`);
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
        // Try the next explicit root.
      }
    }
    throw new Error(`${field} is outside configured workspace/worktree roots or is unsafe`);
  }
}

function descriptor(name: (typeof OPERATIONS)[number]): CapabilityDescriptor {
  const action = name.split('.').at(-1)?.replace('_', ' ') ?? name;
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: VERSION,
    title: `Codex subagent ${action}`,
    description: `${action[0]?.toLocaleUpperCase()}${action.slice(1)} a visible Codex child-agent thread through a containment-checked backend.`,
    tags: ['codex', 'subagent', 'delegation', name.endsWith('spawn') ? 'worktree' : 'session'],
    inputSchema: subagentInputSchema(name),
    outputSchema: subagentOutputSchema(name),
    permissions: [
      {
        permission: name,
        reason: 'Delegated agent execution can read or change workspace state.',
        risk:
          name.endsWith('list') || name.endsWith('inspect') || name.endsWith('wait')
            ? 'low'
            : 'high',
      },
    ],
  };
}

function subagentOutputSchema(name: (typeof OPERATIONS)[number]): JsonObject {
  const thread = subagentSnapshotSchema(name === 'codex.subagents.inspect');
  const run = subagentRunSchema();
  switch (name) {
    case 'codex.subagents.spawn':
      return strictObject({
        thread: subagentSnapshotSchema(), run,
        worktree: strictObject({
          path: { type: 'string', maxLength: 4_096 },
          branch: { type: 'string', maxLength: 512 },
          baseCommit: { type: 'string', maxLength: 64 },
        }, ['path', 'branch']),
      }, ['thread']);
    case 'codex.subagents.run':
    case 'codex.subagents.follow_up':
      return run;
    case 'codex.subagents.list':
      return strictObject({ threads: { type: 'array', items: subagentSnapshotSchema() } }, ['threads']);
    case 'codex.subagents.send':
    case 'codex.subagents.wait':
    case 'codex.subagents.cancel':
    case 'codex.subagents.inspect':
      return strictObject({ thread }, ['thread']);
  }
}

function strictObject(properties: JsonObject, required: readonly string[]): JsonObject {
  return { type: 'object', properties, required, additionalProperties: false };
}

function subagentSnapshotSchema(includeTranscript = false): JsonObject {
  return strictObject({
    id: { type: 'string', maxLength: 128 },
    status: { enum: ['starting', 'running', 'idle', 'failed', 'unknown'] },
    workspacePath: { type: 'string', maxLength: 4_096 }, name: { type: 'string', maxLength: 128 },
    parentId: { type: 'string', maxLength: 128 }, model: { type: 'string', maxLength: 128 },
    createdAt: { type: 'string', maxLength: 64 }, updatedAt: { type: 'string', maxLength: 64 },
    activeTurnId: { type: 'string', maxLength: 128 }, lastResponse: { type: 'string', maxLength: 1_000_000 },
    metadata: { type: 'object', maxProperties: 256 },
    ...(includeTranscript ? { transcript: { type: 'array', items: { type: 'object', maxProperties: 256 } } } : {}),
  }, ['id', 'status', 'workspacePath']);
}

function subagentRunSchema(): JsonObject {
  return strictObject({
    thread: subagentSnapshotSchema(), response: { type: 'string', maxLength: 1_000_000 },
    turnId: { type: 'string', maxLength: 128 }, status: { enum: ['completed', 'failed', 'interrupted'] },
    error: {},
    items: { type: 'array', items: { type: 'object', maxProperties: 256 } },
    changeRefs: { type: 'array', items: { type: 'string' } },
  }, ['thread', 'response', 'status']);
}

function subagentInputSchema(name: (typeof OPERATIONS)[number]): JsonObject {
  const threadId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
  const prompt = { type: 'string', minLength: 1, maxLength: 200_000 };
  switch (name) {
    case 'codex.subagents.spawn':
      return {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          backend: { enum: ['codex', 'copilot'] },
          prompt,
          name: { type: 'string', maxLength: 128 },
          role: { type: 'string', maxLength: 128 },
          model: { type: 'string', maxLength: 128 },
          reasoningEffort: { type: 'string', maxLength: 32 },
          developerInstructions: { type: 'string', maxLength: 50_000 },
          approvalPolicy: { enum: ['never', 'on-request', 'on-failure', 'untrusted'] },
          sandbox: { enum: ['read-only', 'workspace-write', 'danger-full-access'] },
          ephemeral: { type: 'boolean' },
          parentThreadId: threadId,
          worktreeIsolation: { type: 'boolean' },
          branchName: { type: 'string', maxLength: 200 },
          baseRef: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      };
    case 'codex.subagents.run':
    case 'codex.subagents.follow_up':
      return {
        type: 'object',
        properties: {
          threadId,
          [name.endsWith('follow_up') ? 'message' : 'prompt']: prompt,
          reasoningEffort: { type: 'string', maxLength: 32 },
        },
        required: ['threadId', name.endsWith('follow_up') ? 'message' : 'prompt'],
        additionalProperties: false,
      };
    case 'codex.subagents.send':
      return {
        type: 'object',
        properties: { threadId, message: prompt },
        required: ['threadId', 'message'],
        additionalProperties: false,
      };
    case 'codex.subagents.list':
      return {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          parentThreadId: threadId,
          limit: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      };
    case 'codex.subagents.wait':
      return {
        type: 'object',
        properties: {
          threadId,
          timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
          pollIntervalMs: { type: 'integer', minimum: 100, maximum: 5_000 },
        },
        required: ['threadId'],
        additionalProperties: false,
      };
    case 'codex.subagents.inspect':
    case 'codex.subagents.cancel':
      return {
        type: 'object',
        properties: { threadId },
        required: ['threadId'],
        additionalProperties: false,
      };
  }
}

function result(
  output: unknown,
  operation: string,
  context: InvocationContext,
): CapabilityInvocationResult {
  return {
    output,
    receipt: { operation, principalId: context.principal.id, at: new Date().toISOString() },
  };
}

async function assertSnapshotContained(
  thread: SubagentSnapshot,
  workspace: string,
): Promise<void> {
  const actual = await resolveContainedExistingDirectory(workspace, thread.workspacePath, 'workspacePath');
  const expected = await resolveContainedExistingDirectory(workspace, workspace, 'workspacePath');
  if (resolvePath(actual) !== resolvePath(expected))
    throw new Error('Codex backend returned a different workspace path');
}

function resolvePath(value: string): string {
  const resolved = resolveContainedPath(value, undefined, 'workspacePath');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function requireThreadId(value: unknown): string {
  const id = requireString(value, 'threadId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
    throw new Error('threadId contains unsafe characters');
  return id;
}

function optionalThreadId(value: unknown): string | undefined {
  return value === undefined ? undefined : requireThreadId(value);
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`integer must be between ${min} and ${max}`);
  return value as number;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}

async function awaitChildTurn<T>(
  start: () => Promise<T>,
  signal: InvocationCancellationSignal | undefined,
  cancel: () => Promise<unknown>,
): Promise<T> {
  if (!signal) return start();
  if (signal.aborted) {
    await settleCancellation(cancel);
    throw cancellationError(signal.reason);
  }
  if (!signal.addEventListener) return start();

  let removeAbortListener: () => void = () => undefined;
  let onAbort = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    let handled = false;
    onAbort = () => {
      if (handled) return;
      handled = true;
      void settleCancellation(cancel).finally(() => reject(cancellationError(signal.reason)));
    };
    removeAbortListener = () => signal.removeEventListener?.('abort', onAbort);
    signal.addEventListener?.('abort', onAbort, { once: true });
  });
  if (signal.aborted) {
    onAbort();
    return cancellation;
  }
  const operation = start();
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    removeAbortListener();
  }
}

function throwIfAlreadyAborted(signal: InvocationCancellationSignal | undefined): void {
  if (signal?.aborted) throw cancellationError(signal.reason);
}

async function settleCancellation(cancel: () => Promise<unknown>): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, CANCELLATION_SETTLE_TIMEOUT_MS);
    void Promise.resolve()
      .then(cancel)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolvePromise();
      });
  });
}

function cancellationError(reason: unknown): Error & { code: string } {
  const message = reason instanceof Error ? reason.message : 'Subagent invocation was cancelled.';
  return Object.assign(new Error(message), { code: 'ABORT_ERR' });
}
