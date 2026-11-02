import type {
  InvocationContext,
  MaybePromise,
  RuntimeAbortSignal,
  RuntimeError,
  RuntimeProtocolVersion,
  RuntimeScope,
} from './contracts.js';

export type RuntimeBackgroundJobState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted';

export interface RuntimeBackgroundJobHandle {
  readonly jobId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface RuntimeBackgroundJobStartRequest<TInput = unknown> {
  readonly protocolVersion: string;
  readonly kind: string;
  readonly input?: TInput;
  readonly idempotencyKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeBackgroundJobProgress {
  readonly message?: string;
  readonly completed?: number;
  readonly total?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeBackgroundJobRecord<TInput = unknown, TResult = unknown> {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly handle: RuntimeBackgroundJobHandle;
  readonly principalId: string;
  /** Canonical harness agent identity used in addition to principal and scope authorization. */
  readonly agentId: string;
  readonly scope?: RuntimeScope;
  readonly state: RuntimeBackgroundJobState;
  readonly attempt: number;
  readonly input?: TInput;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly requestDigest: string;
  readonly progress?: RuntimeBackgroundJobProgress;
  readonly checkpoint?: unknown;
  readonly result?: TResult;
  readonly error?: RuntimeError;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly revision: number;
  /** Single-worker lease. Only its token may heartbeat or finalize this run. */
  readonly lease?: {
    readonly ownerId: string;
    readonly token: string;
    readonly expiresAt: string;
  };
}

export interface RuntimeBackgroundJobControl {
  readonly signal: RuntimeAbortSignal;
  reportProgress(progress: RuntimeBackgroundJobProgress): MaybePromise<void>;
}

export interface RuntimeBackgroundJobSucceeded<TResult = unknown> {
  readonly status: 'succeeded';
  readonly result: TResult;
}

/** A durable data checkpoint, never a serialized function or JS continuation. */
export interface RuntimeBackgroundJobPaused {
  readonly status: 'paused';
  readonly checkpoint: unknown;
}

export type RuntimeBackgroundJobHandlerResult<TResult = unknown> =
  RuntimeBackgroundJobSucceeded<TResult> | RuntimeBackgroundJobPaused;

/** Explicit callbacks that a host registers by job kind. */
export interface RuntimeBackgroundJobHandler<TInput = unknown, TResult = unknown> {
  readonly kind: string;
  /** Optional lease bound for handlers whose native work may block the host event loop. */
  readonly leaseDurationMs?: number;
  start(
    request: RuntimeBackgroundJobStartRequest<TInput>,
    context: InvocationContext,
    control: RuntimeBackgroundJobControl,
  ): MaybePromise<RuntimeBackgroundJobHandlerResult<TResult>>;
  resume?(
    job: RuntimeBackgroundJobRecord<TInput, TResult>,
    context: InvocationContext,
    control: RuntimeBackgroundJobControl,
  ): MaybePromise<RuntimeBackgroundJobHandlerResult<TResult>>;
  cancel?(
    job: RuntimeBackgroundJobRecord<TInput, TResult>,
    context: InvocationContext,
  ): MaybePromise<void>;
}

/** Durable persistence boundary; implementations must use revision checks. */
export interface RuntimeBackgroundJobStore {
  get(jobId: string): MaybePromise<RuntimeBackgroundJobRecord | undefined>;
  findByIdempotencyKey(
    principalId: string,
    scope: RuntimeScope | undefined,
    idempotencyKey: string,
  ): MaybePromise<RuntimeBackgroundJobRecord | undefined>;
  create(record: RuntimeBackgroundJobRecord): MaybePromise<void>;
  createOrGetByIdempotencyKey(
    record: RuntimeBackgroundJobRecord,
  ): MaybePromise<{
    readonly status: 'created' | 'existing' | 'conflict';
    readonly record: RuntimeBackgroundJobRecord;
  }>;
  update(record: RuntimeBackgroundJobRecord, expectedRevision: number): MaybePromise<void>;
  list(): MaybePromise<readonly RuntimeBackgroundJobRecord[]>;
  remove(jobId: string): MaybePromise<void>;
}

export type RuntimeBackgroundJobOperation = 'start' | 'status' | 'cancel' | 'resume';

export interface RuntimeBackgroundJobCommandReceipt {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly receiptId: string;
  readonly operation: RuntimeBackgroundJobOperation;
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  readonly principalId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly replayed?: boolean;
}

export type RuntimeBackgroundJobCommandStatus =
  'accepted' | 'success' | 'not_found' | 'conflict' | 'unsupported' | 'failed';

export interface RuntimeBackgroundJobResponse {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly status: RuntimeBackgroundJobCommandStatus;
  readonly handle?: RuntimeBackgroundJobHandle;
  readonly job?: RuntimeBackgroundJobRecord;
  readonly error?: RuntimeError;
  readonly receipt: RuntimeBackgroundJobCommandReceipt;
}
