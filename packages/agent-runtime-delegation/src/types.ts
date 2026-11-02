import type { InvocationContext, RuntimeScope } from '@marshal/agent-runtime-core';
import type { RuntimeServiceToken } from '@marshal/agent-runtime-composer';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface DelegationAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(
    type: 'abort',
    listener: () => void,
    options?: Readonly<{ once?: boolean }>,
  ): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

export interface DelegationContext {
  readonly scope?: RuntimeScope;
  readonly signal?: DelegationAbortSignal;
  readonly invocation?: InvocationContext;
}

/** Host-owned persistence hook for generic parent/child scope lineage. */
export interface DelegationChildScopeLineageService {
  persistScopeInheritance(
    parent: InvocationContext,
    childThreadId: string,
  ): void | Promise<void>;
}

/** Stable service token shared by hosts and detachable delegation adapters. */
export const RUNTIME_DELEGATION_CHILD_SCOPE_LINEAGE_SERVICE =
  Symbol.for(
    '@marshal/agent-runtime-delegation:child-scope-lineage',
  ) as RuntimeServiceToken<DelegationChildScopeLineageService>;

export type DelegationState = 'pending' | 'running' | 'done' | 'failed';

export interface DelegationLaunchRequest {
  readonly prompt: string;
  /** Optional vendor-neutral backend selection interpreted by the harness adapter. */
  readonly backend?: string;
  readonly scope?: string;
  readonly role?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly workspaceMode?: 'shared' | 'isolated';
  /** Start point an isolated workspace is created from; the adapter resolves it. */
  readonly baseRef?: string;
  /** Replaces the system prompt the host would assemble; the harness may keep its own base prompt. */
  readonly systemPrompt?: string;
  /** Host tool allowlist for the delegated agent; an empty list grants no tools. */
  readonly tools?: readonly string[];
  /** Local file paths the adapter attaches to the launch prompt. */
  readonly attachments?: readonly string[];
}

export interface DelegationSpawnRequest extends DelegationLaunchRequest {
  readonly parentDelegationId?: string;
  /** Preallocated identity for durable registration before dispatch. Collisions are scoped and rejected. */
  readonly delegationId?: string;
  /** Retry identity, scoped to the authenticated caller and its session/workspace. */
  readonly idempotencyKey?: string;
}

export interface DelegationUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** May be a subset of inputTokens; must not be added to it. */
  readonly cachedInputTokens?: number;
  readonly costUsd?: number;
}

export interface DelegationExecutionMetadata {
  readonly sessionId?: string;
  readonly executionId?: string;
  /** Durable reference only; transcript contents are never duplicated here. */
  readonly transcriptRef?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly usage?: DelegationUsage;
  readonly usageByModel?: readonly { readonly model?: string; readonly usage: DelegationUsage }[];
}

export interface DelegationRecord extends DelegationExecutionMetadata {
  readonly delegationId: string;
  readonly parentDelegationId?: string;
  readonly adapterHandle?: string;
  readonly state: DelegationState;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly changeRefs?: readonly string[];
  readonly spawnFingerprint?: string;
  readonly finalized?: boolean;
  readonly recovery?: { readonly idempotencyKey: string; readonly reason: string; readonly previousError: JsonValue };
  readonly ownerSessionId?: string;
  readonly ownerPrincipalId?: string;
}

/** Per-invocation delivery receipt; never persisted on a delegation record. */
export interface DelegationContinuationResult extends DelegationRecord {
  readonly continuationDelivery?: 'held' | 'accepted';
}

export interface DelegationWaitRequest {
  readonly delegationId: string;
}

export interface DelegationPauseRequest {
  readonly delegationId: string;
  readonly reason: string;
}

export interface DelegationContinueRequest {
  readonly delegationId: string;
  readonly prompt: string;
}

/** Explicit reconciliation of a classified failure with its existing host execution. */
export interface DelegationRecoverRequest {
  readonly delegationId: string;
  readonly expectedError: JsonValue;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface DelegationCancelRequest {
  readonly delegationId: string;
  readonly recursive?: boolean;
}

export interface DelegationAdapterSpawnRequest {
  readonly delegationId: string;
  readonly request: DelegationLaunchRequest;
}

export interface DelegationAdapterSnapshot extends DelegationExecutionMetadata {
  /** Only for continue(): held means no prompt was accepted by the native agent. */
  readonly continuationDelivery?: 'held' | 'accepted';
  readonly adapterHandle?: string;
  readonly state: DelegationState;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly changeRefs?: readonly string[];
}

/** Implemented by a harness adapter; portable delegation never imports a harness SDK. */
export interface DelegationAdapterPort {
  spawn(
    request: DelegationAdapterSpawnRequest,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot>;
  continue(
    adapterHandle: string,
    prompt: string,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot>;
  /** Read-only verification of an existing live execution; never launch or deliver a turn. */
  recover?(adapterHandle: string, context: DelegationContext): Promise<DelegationAdapterSnapshot>;
  wait(adapterHandle: string, context: DelegationContext): Promise<DelegationAdapterSnapshot>;
  /** Explicit task finalization, distinct from waiting for a conversational turn. */
  /** Finalize the exact authorized record; native handles may be shared by multiple runs. */
  complete?(adapterHandle: string, context: DelegationContext, delegationId?: string): Promise<DelegationAdapterSnapshot>;
  pause(adapterHandle: string, reason: string, context: DelegationContext): Promise<void>;
  cancel(adapterHandle: string, context: DelegationContext): Promise<DelegationAdapterSnapshot>;
}

export interface DelegationStore {
  get(delegationId: string): Promise<DelegationRecord | undefined>;
  list(): Promise<readonly DelegationRecord[]>;
  create(record: DelegationRecord): Promise<void>;
  update(record: DelegationRecord): Promise<void>;
}
