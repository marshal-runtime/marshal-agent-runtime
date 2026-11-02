import type {
  InvocationContext,
  MaybePromise,
  ProvenanceRecord,
  RuntimeArtifactReference,
  RuntimeDiagnostic,
  RuntimeError,
  RuntimeProtocolVersion,
  RuntimeScope,
} from './contracts.js';

/** Caller-owned key used to replay a completed effect without performing it twice. */
export type RuntimeEffectIdempotencyKey = string;

export interface RuntimeEffectApprovalGrant {
  readonly approvalId: string;
  readonly grantedBy?: string;
  readonly grantedAt?: string;
  readonly token?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A request for a harness-native action such as opening UI or spawning an agent. */
export interface RuntimeEffectRequest<TInput = unknown> {
  readonly protocolVersion: string;
  readonly kind: string;
  readonly input?: TInput;
  readonly idempotencyKey: RuntimeEffectIdempotencyKey;
  readonly effectId?: string;
  readonly approval?: RuntimeEffectApprovalGrant;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeEffectSuccess<TOutput = unknown> {
  readonly status: 'success';
  readonly output: TOutput;
  readonly provenance?: readonly ProvenanceRecord[];
  readonly diagnostics?: readonly RuntimeDiagnostic[];
  readonly artifacts?: readonly RuntimeArtifactReference[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeEffectUnsupported {
  readonly status: 'unsupported';
  readonly reason: string;
  readonly supportedKinds?: readonly string[];
}

export interface RuntimeEffectApprovalRequirement {
  readonly approvalId?: string;
  readonly reason: string;
  readonly prompt?: string;
  readonly expiresAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeEffectApprovalRequired {
  readonly status: 'approval_required';
  readonly approval: RuntimeEffectApprovalRequirement;
}

export interface RuntimeEffectFailed {
  readonly status: 'failed';
  readonly error: RuntimeError;
  readonly diagnostics?: readonly RuntimeDiagnostic[];
}

export interface RuntimeEffectCancelled {
  readonly status: 'cancelled';
  readonly error?: RuntimeError;
}

/** Result returned by an adapter callback before the portable layer adds a receipt. */
export type RuntimeEffectHandlerResult<TOutput = unknown> =
  | RuntimeEffectSuccess<TOutput>
  | RuntimeEffectUnsupported
  | RuntimeEffectApprovalRequired
  | RuntimeEffectFailed
  | RuntimeEffectCancelled;

/** Optional callback port implemented by a harness adapter. */
export interface RuntimeEffectHandler {
  readonly id: string;
  readonly version?: string;
  readonly supportedKinds?: readonly string[];
  supports?(kind: string, context: InvocationContext): MaybePromise<boolean>;
  handle<TInput = unknown, TOutput = unknown>(
    request: RuntimeEffectRequest<TInput>,
    context: InvocationContext,
  ): MaybePromise<RuntimeEffectHandlerResult<TOutput>>;
}

export interface RuntimeEffectExecutionReceipt {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly receiptId: string;
  readonly effectId: string;
  readonly kind: string;
  readonly idempotencyKey: RuntimeEffectIdempotencyKey;
  readonly requestDigest: string;
  readonly principalId: string;
  readonly scope?: InvocationContext['scope'];
  readonly handler?: { readonly id: string; readonly version?: string };
  readonly status: RuntimeEffectHandlerResult['status'];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly replayed: boolean;
  readonly replayOfReceiptId?: string;
  readonly resultDigest?: string;
}

export type RuntimeEffectResponse<TOutput = unknown> = RuntimeEffectHandlerResult<TOutput> & {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly receipt: RuntimeEffectExecutionReceipt;
};

export interface RuntimeEffectReplayIdentity {
  readonly principalId: string;
  readonly scope?: RuntimeScope;
  readonly idempotencyKey: RuntimeEffectIdempotencyKey;
  readonly requestDigest: string;
}

export interface RuntimeEffectReplayEntry {
  readonly identity: RuntimeEffectReplayIdentity;
  readonly response: RuntimeEffectResponse;
}

export interface RuntimeEffectExecutionClaim {
  readonly claimId: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export type RuntimeEffectClaimResult =
  | { readonly status: 'acquired'; readonly claim: RuntimeEffectExecutionClaim }
  | { readonly status: 'busy'; readonly expiresAt: string }
  | { readonly status: 'completed'; readonly entry: RuntimeEffectReplayEntry }
  | { readonly status: 'conflict'; readonly existingRequestDigest: string };

/** Optional persistence port for idempotent effect replay. */
export interface RuntimeEffectReplayPort {
  get(identity: RuntimeEffectReplayIdentity): MaybePromise<RuntimeEffectReplayEntry | undefined>;
  put(identity: RuntimeEffectReplayIdentity, response: RuntimeEffectResponse): MaybePromise<void>;
}

/**
 * Durable execution-ownership extension for replay stores. Claims are scoped by
 * the replay identity partition and must be atomic across host processes.
 */
export interface RuntimeEffectClaimPort extends RuntimeEffectReplayPort {
  claim(
    identity: RuntimeEffectReplayIdentity,
    claim: RuntimeEffectExecutionClaim,
  ): MaybePromise<RuntimeEffectClaimResult>;
  renew(
    identity: RuntimeEffectReplayIdentity,
    claim: RuntimeEffectExecutionClaim,
  ): MaybePromise<boolean>;
  complete(
    identity: RuntimeEffectReplayIdentity,
    claimId: string,
    response: RuntimeEffectResponse,
  ): MaybePromise<void>;
  release(identity: RuntimeEffectReplayIdentity, claimId: string): MaybePromise<void>;
}
