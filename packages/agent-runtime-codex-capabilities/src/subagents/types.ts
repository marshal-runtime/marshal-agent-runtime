import type { InvocationContext, JsonObject } from '../coreTypes.js';

export type SubagentStatus = 'starting' | 'running' | 'idle' | 'failed' | 'unknown';
export type SubagentBackendName = 'codex' | 'copilot';

export interface SubagentSnapshot {
  id: string;
  status: SubagentStatus;
  workspacePath: string;
  name?: string;
  parentId?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  activeTurnId?: string;
  lastResponse?: string;
  metadata?: JsonObject;
}

export interface SubagentRunResult {
  thread: SubagentSnapshot;
  response: string;
  error?: unknown;
  changeRefs?: readonly string[];
  turnId?: string;
  status: 'completed' | 'failed' | 'interrupted';
  items?: readonly JsonObject[];
}

export interface SubagentWaitSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(
    type: 'abort',
    listener: () => void,
    options?: Readonly<{ once?: boolean }>,
  ): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

export interface SpawnSubagentRequest {
  workspacePath: string;
  backend?: SubagentBackendName;
  prompt?: string;
  name?: string;
  role?: string;
  model?: string;
  reasoningEffort?: string;
  developerInstructions?: string;
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  ephemeral?: boolean;
  parentThreadId?: string;
  worktree?: { path: string; branch: string; baseCommit?: string };
  baseRef?: string;
}

export interface SubagentListRequest {
  workspacePath?: string;
  parentThreadId?: string;
  limit?: number;
}

export interface SubagentBackend {
  spawn(request: SpawnSubagentRequest): Promise<SubagentSnapshot>;
  run(
    threadId: string,
    prompt: string,
    options?: { reasoningEffort?: string },
  ): Promise<SubagentRunResult>;
  list(request: SubagentListRequest): Promise<readonly SubagentSnapshot[]>;
  steer(threadId: string, message: string): Promise<SubagentSnapshot>;
  pause?(threadId: string, reason: string): Promise<SubagentSnapshot>;
  followUp(
    threadId: string,
    message: string,
    options?: { reasoningEffort?: string },
  ): Promise<SubagentRunResult>;
  wait(
    threadId: string,
    options?: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: SubagentWaitSignal;
    },
  ): Promise<SubagentSnapshot>;
  cancel(threadId: string): Promise<SubagentSnapshot>;
  inspect(threadId: string): Promise<SubagentSnapshot & { transcript?: readonly JsonObject[] }>;
  dispose?(): void | Promise<void>;
}

export type SubagentScopeInheritancePersister = (
  parent: InvocationContext,
  childThreadId: string,
) => void | Promise<void>;

export interface WorktreeProvisioner {
  provision(request: {
    workspacePath: string;
    name?: string;
    branchName?: string;
    baseRef?: string;
  }): Promise<{ path: string; branch: string; baseCommit?: string }>;
  /** Release an adapter-owned lease after failed or cancelled delegated work. */
  release(
    worktree: { path: string; branch: string },
    reason: 'spawn_failed' | 'run_failed' | 'cancelled',
  ): Promise<void>;
}
