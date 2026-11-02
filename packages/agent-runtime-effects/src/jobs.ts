import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  RUNTIME_PROTOCOL_VERSION,
  assertSupportedProtocolVersion,
  sameStableFileIdentity,
  sameStableFileSnapshot,
  type InvocationContext,
  type RuntimeBackgroundJobCommandReceipt,
  type RuntimeBackgroundJobHandler,
  type RuntimeBackgroundJobHandlerResult,
  type RuntimeBackgroundJobOperation,
  type RuntimeBackgroundJobRecord,
  type RuntimeBackgroundJobResponse,
  type RuntimeBackgroundJobStartRequest,
  type RuntimeBackgroundJobState,
  type RuntimeBackgroundJobStore,
  type RuntimeScope,
} from '@marshal/agent-runtime-core';
import {
  cloneJson,
  codedError,
  requireKey,
  sameScope,
  sha256,
  stableJson,
  stringifyJson,
} from './json.js';

const TERMINAL_STATES = new Set<RuntimeBackgroundJobState>(['succeeded', 'failed', 'cancelled']);
const RESUMABLE_STATES = new Set<RuntimeBackgroundJobState>([
  'paused',
  'failed',
  'interrupted',
  'running',
]);
const DEFAULT_MAX_VALUE_BYTES = 1024 * 1024;
const JOB_STORE_LOCK_NAME = '.job-store.lock';
const JOB_STORE_LOCK_CANDIDATE_PREFIX = '.job-store-lock-';
const JOB_STORE_LOCK_TIMEOUT_MS = 30_000;
const JOB_STORE_LOCK_RETRY_MS = 10;
const JOB_STORE_LOCK_OWNER_READ_ATTEMPTS = 100;
const EXPLICIT_CANCEL_REASON = 'cancelled';

export class JobStoreRevisionConflictError extends Error {
  readonly code = 'job_revision_conflict';

  constructor(readonly jobId: string) {
    super(`Job "${jobId}" changed before the update could be applied.`);
    this.name = 'JobStoreRevisionConflictError';
  }
}

export interface BackgroundJobManagerOptions {
  readonly store: RuntimeBackgroundJobStore;
  readonly handlers?: readonly RuntimeBackgroundJobHandler[];
  readonly maxValueBytes?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Maximum automatic attempts, including the first start, during recovery. */
  readonly maxAttempts?: number;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
}

interface ActiveJob {
  readonly kind: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  readonly leaseToken: string;
  readonly heartbeat: NodeJS.Timeout;
}

export interface BackgroundJobHandlerRegistration {
  dispose(): Promise<void>;
}

export interface BackgroundJobHandlerReservation extends BackgroundJobHandlerRegistration {
  publish(): void;
}

/**
 * Durable job coordinator. Persistence contains only JSON inputs, outputs, and
 * checkpoints; resume always calls a currently registered handler explicitly.
 */
export class BackgroundJobManager {
  private readonly store: RuntimeBackgroundJobStore;
  private readonly handlers = new Map<string, RuntimeBackgroundJobHandler>();
  private readonly reservedHandlers = new Map<string, RuntimeBackgroundJobHandler>();
  private readonly active = new Map<string, ActiveJob>();
  private readonly renewing = new Map<string, Promise<void>>();
  private readonly maxValueBytes: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxAttempts: number;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private queue: Promise<void> = Promise.resolve();
  private shutdownOperation: Promise<void> | undefined;
  private shutdownMode: 'drain' | 'interrupt' | undefined;

  constructor(options: BackgroundJobManagerOptions) {
    this.store = options.store;
    this.maxValueBytes = positiveInteger(options.maxValueBytes, DEFAULT_MAX_VALUE_BYTES);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxAttempts = positiveInteger(options.maxAttempts, 3);
    this.workerId = options.workerId ?? this.createId();
    this.leaseMs = positiveInteger(options.leaseMs, 30_000);
    this.heartbeatMs = positiveInteger(options.heartbeatMs, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    if (this.heartbeatMs >= this.leaseMs) throw new Error('heartbeatMs must be lower than leaseMs.');
    for (const handler of options.handlers ?? []) this.register(handler);
  }

  register(handler: RuntimeBackgroundJobHandler): void {
    this.registerHandlers([handler]);
  }

  registerHandlers(
    handlers: readonly RuntimeBackgroundJobHandler[],
  ): BackgroundJobHandlerRegistration {
    const reservation = this.reserveHandlers(handlers);
    reservation.publish();
    return reservation;
  }

  reserveHandlers(
    handlers: readonly RuntimeBackgroundJobHandler[],
  ): BackgroundJobHandlerReservation {
    const owned = [...handlers];
    const kinds = new Set<string>();
    for (const handler of owned) {
      this.validateHandler(handler);
      if (kinds.has(handler.kind)) {
        throw new Error(`Job handler already exists: ${handler.kind}`);
      }
      if (this.handlers.has(handler.kind) || this.reservedHandlers.has(handler.kind)) {
        throw new Error(`Job handler already exists: ${handler.kind}`);
      }
      kinds.add(handler.kind);
    }
    for (const handler of owned) this.reservedHandlers.set(handler.kind, handler);
    let state: 'reserved' | 'published' | 'disposed' = 'reserved';
    let disposeOperation: Promise<void> | undefined;
    return Object.freeze({
      publish: () => {
        if (state === 'published') return;
        if (state !== 'reserved') {
          throw new Error('Job handler reservation is no longer active.');
        }
        for (const handler of owned) {
          if (this.reservedHandlers.get(handler.kind) !== handler) {
            throw new Error(`Job handler reservation was lost: ${handler.kind}`);
          }
        }
        for (const handler of owned) {
          this.reservedHandlers.delete(handler.kind);
          this.handlers.set(handler.kind, handler);
        }
        state = 'published';
      },
      dispose: () => {
        if (!disposeOperation) {
          if (state === 'reserved') {
            for (const handler of owned) {
              if (this.reservedHandlers.get(handler.kind) === handler) {
                this.reservedHandlers.delete(handler.kind);
              }
            }
            state = 'disposed';
            disposeOperation = Promise.resolve();
          } else if (state === 'published') {
            state = 'disposed';
            disposeOperation = this.unregisterHandlers(owned);
          } else {
            disposeOperation = Promise.resolve();
          }
        }
        return disposeOperation;
      },
    });
  }

  private validateHandler(handler: RuntimeBackgroundJobHandler): void {
    if (!handler.kind.trim()) throw new TypeError('Job handler kind cannot be empty.');
    if (
      handler.leaseDurationMs !== undefined
      && (
        !Number.isSafeInteger(handler.leaseDurationMs)
        || handler.leaseDurationMs <= this.heartbeatMs
      )
    ) {
      throw new TypeError('Job handler leaseDurationMs must exceed the default heartbeat interval.');
    }
  }

  private async unregisterHandlers(
    handlers: readonly RuntimeBackgroundJobHandler[],
  ): Promise<void> {
    const active = await this.serial(async () => {
      const removed = new Set<string>();
      for (const handler of handlers) {
        if (this.handlers.get(handler.kind) !== handler) continue;
        this.handlers.delete(handler.kind);
        removed.add(handler.kind);
      }
      const interrupted = [...this.active.values()]
        .filter((job) => removed.has(job.kind));
      for (const job of interrupted) {
        clearInterval(job.heartbeat);
        job.controller.abort(new Error('Runtime extension job handler was disabled.'));
      }
      return interrupted.map((job) => job.promise);
    });
    await Promise.allSettled(active);
  }

  async start(
    request: RuntimeBackgroundJobStartRequest,
    context: InvocationContext,
  ): Promise<RuntimeBackgroundJobResponse> {
    const started = this.now();
    try {
      assertSupportedProtocolVersion(request.protocolVersion);
      validateStartRequest(request, this.maxValueBytes);
      if (!this.handlers.has(request.kind)) {
        return this.response('start', 'unsupported', context, started, {
          idempotencyKey: request.idempotencyKey,
          error: {
            code: 'job_kind_unsupported',
            message: `No handler supports "${request.kind}".`,
          },
        });
      }
      const requestDigest = sha256(
        stableJson({
          kind: request.kind,
          input: request.input ?? null,
          metadata: request.metadata ?? {},
        }),
      );
      return await this.serial(async () => {
        if (!this.handlers.has(request.kind)) {
          return this.response('start', 'unsupported', context, started, {
            idempotencyKey: request.idempotencyKey,
            error: {
              code: 'job_kind_unsupported',
              message: `No handler supports "${request.kind}".`,
            },
          });
        }
        const record = createJobRecord(request, context, requestDigest, this.now(), this.createId(), this.maxValueBytes);
        const reservation = await this.store.createOrGetByIdempotencyKey(record);
        if (reservation.status !== 'created') {
          if (reservation.status === 'conflict') {
            return this.response('start', 'conflict', context, started, {
              job: reservation.record,
              handle: reservation.record.handle,
              idempotencyKey: request.idempotencyKey,
              error: {
                code: 'idempotency_key_reused',
                message: 'The idempotency key is already bound to a different job request.',
              },
            });
          }
          const resume = reservation.record.state !== 'queued';
          const reclaimed = (
            reservation.record.state === 'queued' ||
            (this.handlers.get(reservation.record.handle.kind)?.resume && this.isRecoverable(reservation.record))
          ) ? await this.claim(reservation.record) : undefined;
          if (reclaimed) this.scheduleClaimed(reclaimed, resume, portableContext(context));
          return this.response('start', 'accepted', context, started, {
            job: reclaimed ?? reservation.record,
            handle: (reclaimed ?? reservation.record).handle,
            idempotencyKey: request.idempotencyKey,
            replayed: true,
          });
        }

        const claimed = await this.claim(record);
        if (claimed) this.scheduleClaimed(claimed, false, portableContext(context));
        return this.response('start', 'accepted', context, started, {
          job: record,
          handle: record.handle,
          idempotencyKey: request.idempotencyKey,
        });
      });
    } catch (error) {
      return this.failure('start', context, started, error, request.idempotencyKey);
    }
  }

  /**
   * Persist a queued job without requiring a handler in the producing process.
   * This is the hook/worker hand-off boundary: a latency-sensitive producer can
   * durably acknowledge evidence, then a long-lived host with the matching
   * handler claims it through {@link recover}.
   */
  async enqueue(
    request: RuntimeBackgroundJobStartRequest,
    context: InvocationContext,
  ): Promise<RuntimeBackgroundJobResponse> {
    const started = this.now();
    try {
      assertSupportedProtocolVersion(request.protocolVersion);
      validateStartRequest(request, this.maxValueBytes);
      const requestDigest = sha256(
        stableJson({
          kind: request.kind,
          input: request.input ?? null,
          metadata: request.metadata ?? {},
        }),
      );
      return await this.serial(async () => {
        const record = createJobRecord(request, context, requestDigest, this.now(), this.createId(), this.maxValueBytes);
        const reservation = await this.store.createOrGetByIdempotencyKey(record);
        if (reservation.status !== 'created') {
          if (reservation.status === 'conflict') {
            return this.response('start', 'conflict', context, started, {
              job: reservation.record,
              handle: reservation.record.handle,
              idempotencyKey: request.idempotencyKey,
              error: {
                code: 'idempotency_key_reused',
                message: 'The idempotency key is already bound to a different job request.',
              },
            });
          }
          return this.response('start', 'accepted', context, started, {
            job: reservation.record,
            handle: reservation.record.handle,
            idempotencyKey: request.idempotencyKey,
            replayed: true,
          });
        }

        return this.response('start', 'accepted', context, started, {
          job: record,
          handle: record.handle,
          idempotencyKey: request.idempotencyKey,
        });
      });
    } catch (error) {
      return this.failure('start', context, started, error, request.idempotencyKey);
    }
  }

  /** Claim restart-safe queued/interrupted work visible to one scoped worker. */
  async recover(
    context: InvocationContext,
    kinds?: readonly string[],
  ): Promise<readonly string[]> {
    const allowed = kinds ? new Set(kinds) : undefined;
    return this.serial(async () => {
      const claimed: string[] = [];
      for (const record of await this.store.list()) {
        if (!owns(record, context) || (allowed && !allowed.has(record.handle.kind))) continue;
        const handler = this.handlers.get(record.handle.kind);
        if (!handler || this.active.has(record.handle.jobId)) continue;
        const resume = record.state !== 'queued';
        if (record.state === 'paused') continue;
        if (resume && (!handler.resume || !this.isRecoverable(record))) continue;
        const leased = await this.claim(record);
        if (!leased) continue;
        this.scheduleClaimed(leased, resume, portableContext(context));
        claimed.push(leased.handle.jobId);
      }
      return claimed;
    });
  }

  /**
   * Host-only recovery sweep. The resolver reconstructs the original isolated
   * invocation context from each durable record; capability callers never get
   * this cross-scope operation.
   */
  async recoverAll(
    resolveContext: (record: RuntimeBackgroundJobRecord) => InvocationContext | undefined,
    kinds?: readonly string[],
  ): Promise<readonly string[]> {
    const allowed = kinds ? new Set(kinds) : undefined;
    return this.serial(async () => {
      const claimed: string[] = [];
      for (const record of await this.store.list()) {
        if (allowed && !allowed.has(record.handle.kind)) continue;
        const context = resolveContext(record);
        const handler = this.handlers.get(record.handle.kind);
        if (!context || context.principal.id !== record.principalId || !handler || this.active.has(record.handle.jobId)) continue;
        const resume = record.state !== 'queued';
        if (record.state === 'paused') continue;
        if (resume && (!handler.resume || !this.isRecoverable(record))) continue;
        const leased = await this.claim(record);
        if (!leased) continue;
        this.scheduleClaimed(leased, resume, portableContext(context));
        claimed.push(leased.handle.jobId);
      }
      return claimed;
    });
  }

  async status(jobId: string, context: InvocationContext): Promise<RuntimeBackgroundJobResponse> {
    const started = this.now();
    try {
      requireKey(jobId, 'jobId');
      const job = await this.store.get(jobId);
      if (!job || !owns(job, context)) return this.notFound('status', context, started, jobId);
      return this.response('status', 'success', context, started, { job, handle: job.handle });
    } catch (error) {
      return this.failure('status', context, started, error, undefined, jobId);
    }
  }

  async cancel(jobId: string, context: InvocationContext): Promise<RuntimeBackgroundJobResponse> {
    const started = this.now();
    try {
      requireKey(jobId, 'jobId');
      return await this.serial(async () => {
        const job = await this.store.get(jobId);
        if (!job || !owns(job, context)) return this.notFound('cancel', context, started, jobId);
        if (TERMINAL_STATES.has(job.state)) {
          return this.response('cancel', 'conflict', context, started, {
            job,
            handle: job.handle,
            error: { code: 'job_terminal', message: `Job is already ${job.state}.` },
          });
        }
        this.active.get(jobId)?.controller.abort(EXPLICIT_CANCEL_REASON);
        let requested: RuntimeBackgroundJobRecord | undefined;
        for (let attempt = 0; attempt < 5 && !requested; attempt += 1) {
          const latest = await this.store.get(jobId);
          if (!latest) return this.notFound('cancel', context, started, jobId);
          if (TERMINAL_STATES.has(latest.state)) {
            requested = latest;
            break;
          }
          try {
            requested = await this.transition(latest, {
              state: 'cancel_requested',
              error: undefined,
              updatedAt: this.now().toISOString(),
            });
          } catch (error) {
            if (!(error instanceof JobStoreRevisionConflictError)) throw error;
          }
        }
        if (!requested) throw codedError('job_revision_conflict', 'Could not record cancellation.');
        const handler = this.handlers.get(job.handle.kind);
        await handler?.cancel?.(requested, portableContext(context));
        let current = requested;
        if (!this.active.has(jobId)) {
          current = await this.transition(requested, {
            state: 'cancelled',
            completedAt: this.now().toISOString(),
            updatedAt: this.now().toISOString(),
          });
        }
        return this.response('cancel', 'accepted', context, started, {
          job: current,
          handle: current.handle,
        });
      });
    } catch (error) {
      return this.failure('cancel', context, started, error, undefined, jobId);
    }
  }

  async resume(jobId: string, context: InvocationContext): Promise<RuntimeBackgroundJobResponse> {
    const started = this.now();
    try {
      requireKey(jobId, 'jobId');
      return await this.serial(async () => {
        const job = await this.store.get(jobId);
        if (!job || !owns(job, context)) return this.notFound('resume', context, started, jobId);
        const handler = this.handlers.get(job.handle.kind);
        if (!handler?.resume) {
          return this.response('resume', 'unsupported', context, started, {
            job,
            handle: job.handle,
            error: {
              code: 'job_resume_unsupported',
              message: 'The job handler has no resume callback.',
            },
          });
        }
        if (!RESUMABLE_STATES.has(job.state) || this.active.has(jobId) || !this.isRecoverable(job)) {
          return this.response('resume', 'conflict', context, started, {
            job,
            handle: job.handle,
            error: {
              code: 'job_not_resumable',
              message: `Job in state ${job.state} cannot resume.`,
            },
          });
        }
        const claimed = await this.claim(job);
        if (!claimed) throw new JobStoreRevisionConflictError(jobId);
        this.scheduleClaimed(claimed, true, portableContext(context));
        return this.response('resume', 'accepted', context, started, {
          job: claimed,
          handle: claimed.handle,
        });
      });
    } catch (error) {
      return this.failure('resume', context, started, error, undefined, jobId);
    }
  }

  async wait(jobId: string): Promise<void> {
    await this.active.get(jobId)?.promise;
  }

  /** Drain active handlers, optionally interrupting them for later recovery. */
  shutdown(options: { readonly drain?: boolean } = {}): Promise<void> {
    if (options.drain === true) {
      if (this.shutdownMode !== 'interrupt') {
        this.shutdownMode = 'drain';
        for (const job of this.active.values()) job.heartbeat.ref?.();
      }
    } else {
      this.shutdownMode = 'interrupt';
      for (const job of this.active.values()) {
        clearInterval(job.heartbeat);
        job.controller.abort(new Error('Runtime host is shutting down.'));
      }
    }
    if (this.shutdownOperation) return this.shutdownOperation;
    const operation = this.performShutdown();
    this.shutdownOperation = operation;
    void operation.then(
      () => {
        if (this.shutdownOperation === operation) {
          this.shutdownOperation = undefined;
          this.shutdownMode = undefined;
        }
      },
      () => {
        if (this.shutdownOperation === operation) {
          this.shutdownOperation = undefined;
          this.shutdownMode = undefined;
        }
      },
    );
    return operation;
  }

  private async performShutdown(): Promise<void> {
    await this.queue;
    for (;;) {
      const active = [...this.active.values()];
      if (this.shutdownMode === 'interrupt') {
        for (const job of active) {
          clearInterval(job.heartbeat);
          job.controller.abort(new Error('Runtime host is shutting down.'));
        }
      }
      await Promise.allSettled(active.map((job) => job.promise));
      await Promise.allSettled([...this.renewing.values()]);
      await this.queue;
      if (this.active.size === 0) return;
    }
  }

  private scheduleClaimed(
    job: RuntimeBackgroundJobRecord,
    resume: boolean,
    context: InvocationContext,
  ): void {
    const jobId = job.handle.jobId;
    const leaseToken = job.lease?.token;
    if (!leaseToken || this.active.has(jobId)) return;
    const controller = new AbortController();
    const heartbeatMs = Math.max(
      this.heartbeatMs,
      Math.floor(this.leaseDuration(job.handle.kind) / 3),
    );
    const heartbeat = setInterval(() => {
      if (!this.active.has(jobId) || this.renewing.has(jobId)) return;
      const renewal = this.renewLease(jobId, leaseToken, controller);
      this.renewing.set(jobId, renewal);
      void renewal.finally(() => {
        if (this.renewing.get(jobId) === renewal) this.renewing.delete(jobId);
      });
    }, heartbeatMs);
    heartbeat.unref?.();
    const promise = this.run(job, resume, context, controller, leaseToken).finally(() => {
      clearInterval(heartbeat);
      this.active.delete(jobId);
    });
    this.active.set(jobId, {
      kind: job.handle.kind,
      controller,
      promise,
      leaseToken,
      heartbeat,
    });
  }

  private async run(
    job: RuntimeBackgroundJobRecord,
    resume: boolean,
    context: InvocationContext,
    controller: AbortController,
    leaseToken: string,
  ): Promise<void> {
    const jobId = job.handle.jobId;
    const handler = this.handlers.get(job.handle.kind);
    if (!handler) {
      await this.finalize(jobId, controller, leaseToken, {
        state: 'failed',
        error: {
          code: 'job_kind_unsupported',
          message: `No handler supports "${job.handle.kind}".`,
        },
        completedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      });
      return;
    }
    const control = {
      signal: controller.signal,
      reportProgress: async (progress: RuntimeBackgroundJobRecord['progress']) => {
        if (!progress) return;
        cloneJson(progress, 'Job progress', this.maxValueBytes);
        const latest = await this.store.get(jobId);
        if (!this.ownsLease(latest, leaseToken)) return;
        await this.transition(latest, {
          progress,
          lease: this.nextLease(leaseToken, this.leaseDuration(latest.handle.kind)),
          updatedAt: this.now().toISOString(),
        });
      },
    };
    try {
      const result = resume
        ? await handler.resume!(job, context, control)
        : await handler.start(toStartRequest(job), context, control);
      validateHandlerResult(result, this.maxValueBytes);
      if (result.status === 'paused') {
        await this.finalize(jobId, controller, leaseToken, {
          state: 'paused',
          checkpoint: result.checkpoint,
          error: undefined,
          lease: undefined,
          updatedAt: this.now().toISOString(),
        });
      } else {
        await this.finalize(jobId, controller, leaseToken, {
          state: 'succeeded',
          result: result.result,
          checkpoint: undefined,
          error: undefined,
          lease: undefined,
          completedAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        });
      }
    } catch (error) {
      await this.finalize(jobId, controller, leaseToken, {
        state: 'failed',
        error: serializeError(error),
        lease: undefined,
        completedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      });
    }
  }

  private async finalize(
    jobId: string,
    controller: AbortController,
    leaseToken: string,
    changes: Partial<RuntimeBackgroundJobRecord>,
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latest = await this.store.get(jobId);
      if (!latest || TERMINAL_STATES.has(latest.state) || !this.ownsLease(latest, leaseToken)) return;
      const cancelled = latest.state === 'cancel_requested'
        || controller.signal.reason === EXPLICIT_CANCEL_REASON;
      const interrupted = controller.signal.aborted && !cancelled;
      try {
        await this.transition(
          latest,
          cancelled
            ? {
                state: 'cancelled',
                error: undefined,
                lease: undefined,
                completedAt: this.now().toISOString(),
                updatedAt: this.now().toISOString(),
              }
            : interrupted
              ? {
                  state: 'interrupted',
                  error: undefined,
                  lease: undefined,
                  completedAt: undefined,
                  updatedAt: this.now().toISOString(),
                }
              : changes,
        );
        return;
      } catch (error) {
        if (!(error instanceof JobStoreRevisionConflictError)) throw error;
      }
    }
    throw codedError('job_revision_conflict', `Could not finalize job "${jobId}".`);
  }

  private async claim(record: RuntimeBackgroundJobRecord): Promise<RuntimeBackgroundJobRecord | undefined> {
    if (record.state !== 'queued' && !this.isRecoverable(record)) return undefined;
    const leaseToken = this.createId();
    try {
      return await this.transition(record, {
        state: 'running',
        attempt: record.attempt + 1,
        error: undefined,
        completedAt: undefined,
        startedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        lease: this.nextLease(leaseToken, this.leaseDuration(record.handle.kind)),
      });
    } catch (error) {
      if (error instanceof JobStoreRevisionConflictError) return undefined;
      throw error;
    }
  }

  private isRecoverable(record: RuntimeBackgroundJobRecord): boolean {
    if (record.attempt >= this.maxAttempts) return false;
    if (record.state === 'failed' || record.state === 'interrupted' || record.state === 'paused') return true;
    if (record.state !== 'running' || !record.lease) return false;
    return Date.parse(record.lease.expiresAt) <= this.now().getTime();
  }

  private ownsLease(
    record: RuntimeBackgroundJobRecord | undefined,
    leaseToken: string,
  ): record is RuntimeBackgroundJobRecord {
    return Boolean(
      record &&
      (record.state === 'running' || record.state === 'cancel_requested') &&
      record.lease?.token === leaseToken &&
      record.lease.ownerId === this.workerId,
    );
  }

  private leaseDuration(kind: string): number {
    return this.handlers.get(kind)?.leaseDurationMs ?? this.leaseMs;
  }

  private nextLease(
    token: string,
    durationMs = this.leaseMs,
  ): NonNullable<RuntimeBackgroundJobRecord['lease']> {
    return {
      ownerId: this.workerId,
      token,
      expiresAt: new Date(this.now().getTime() + durationMs).toISOString(),
    };
  }

  private async renewLease(
    jobId: string,
    leaseToken: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      const latest = await this.store.get(jobId);
      if (latest?.state === 'cancel_requested') {
        controller.abort(EXPLICIT_CANCEL_REASON);
        return;
      }
      if (!this.ownsLease(latest, leaseToken)) {
        controller.abort('lease_lost');
        return;
      }
      await this.transition(latest, {
        lease: this.nextLease(leaseToken, this.leaseDuration(latest.handle.kind)),
        updatedAt: this.now().toISOString(),
      });
    } catch {
      controller.abort('lease_heartbeat_failed');
    }
  }

  private async transition(
    record: RuntimeBackgroundJobRecord,
    changes: Partial<RuntimeBackgroundJobRecord>,
  ): Promise<RuntimeBackgroundJobRecord> {
    const next = cloneJson(
      { ...record, ...changes, revision: record.revision + 1 },
      'Background job',
      this.maxValueBytes,
    );
    await this.store.update(next, record.revision);
    return next;
  }

  private response(
    operation: RuntimeBackgroundJobOperation,
    status: RuntimeBackgroundJobResponse['status'],
    context: InvocationContext,
    started: Date,
    values: {
      job?: RuntimeBackgroundJobRecord;
      handle?: RuntimeBackgroundJobRecord['handle'];
      error?: RuntimeBackgroundJobResponse['error'];
      idempotencyKey?: string;
      replayed?: boolean;
    } = {},
  ): RuntimeBackgroundJobResponse {
    const completed = this.now();
    const receipt: RuntimeBackgroundJobCommandReceipt = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      receiptId: this.createId(),
      operation,
      jobId: values.handle?.jobId,
      idempotencyKey: values.idempotencyKey ?? values.handle?.idempotencyKey,
      principalId: context.principal.id,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      replayed: values.replayed,
    };
    return { protocolVersion: RUNTIME_PROTOCOL_VERSION, status, ...values, receipt };
  }

  private notFound(
    operation: RuntimeBackgroundJobOperation,
    context: InvocationContext,
    started: Date,
    jobId: string,
  ): RuntimeBackgroundJobResponse {
    return this.response(operation, 'not_found', context, started, {
      error: { code: 'job_not_found', message: `Job "${jobId}" was not found.` },
    });
  }

  private failure(
    operation: RuntimeBackgroundJobOperation,
    context: InvocationContext,
    started: Date,
    error: unknown,
    idempotencyKey?: string,
    jobId?: string,
  ): RuntimeBackgroundJobResponse {
    const response = this.response(operation, 'failed', context, started, {
      idempotencyKey,
      error: serializeError(error),
    });
    return jobId ? { ...response, receipt: { ...response.receipt, jobId } } : response;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface BoundedFileJobStoreOptions {
  readonly rootDirectory: string;
  readonly maxJobs?: number;
  readonly maxRecordBytes?: number;
  readonly maxTotalBytes?: number;
}

/** Durable JSON job store with revision checks and terminal-record eviction. */
export class BoundedFileJobStore implements RuntimeBackgroundJobStore {
  private readonly rootPromise: Promise<string>;
  private readonly maxJobs: number;
  private readonly maxRecordBytes: number;
  private readonly maxTotalBytes: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: BoundedFileJobStoreOptions) {
    if (!path.isAbsolute(options.rootDirectory)) throw new Error('rootDirectory must be absolute.');
    this.maxJobs = positiveInteger(options.maxJobs, 1_000);
    this.maxRecordBytes = positiveInteger(options.maxRecordBytes, 2 * 1024 * 1024);
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes, 128 * 1024 * 1024);
    this.rootPromise = initializeRoot(options.rootDirectory);
  }

  async get(jobId: string): Promise<RuntimeBackgroundJobRecord | undefined> {
    requireKey(jobId, 'jobId');
    // Preserve call ordering within this instance, then coordinate with every
    // store instance/process sharing the durable root. Windows replacement can
    // briefly unlink the target, and revision checks must be globally serial.
    await this.queue;
    const root = await this.rootPromise;
    return withJobStoreLockSync(root, () => {
      const target = path.join(root, `${jobId}.json`);
      try {
        return readRecordSync(target, this.maxRecordBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    });
  }

  async findByIdempotencyKey(
    principalId: string,
    scope: RuntimeScope | undefined,
    idempotencyKey: string,
  ): Promise<RuntimeBackgroundJobRecord | undefined> {
    requireKey(idempotencyKey, 'idempotencyKey');
    return (await this.list()).find(
      (record) =>
        record.principalId === principalId &&
        record.handle.idempotencyKey === idempotencyKey &&
        sameScope(record.scope, scope),
    );
  }

  create(record: RuntimeBackgroundJobRecord): Promise<void> {
    return this.serial(async () => {
      const root = await this.rootPromise;
      withJobStoreLockSync(root, () => {
        const target = recordPath(root, record.handle.jobId);
        try {
          fsSync.lstatSync(target);
          throw new JobStoreRevisionConflictError(record.handle.jobId);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.writeBounded(root, target, record, true);
      });
    });
  }

  createOrGetByIdempotencyKey(
    record: RuntimeBackgroundJobRecord,
  ): Promise<{
    readonly status: 'created' | 'existing' | 'conflict';
    readonly record: RuntimeBackgroundJobRecord;
  }> {
    return this.serialValue(async () => {
      const root = await this.rootPromise;
      return withJobStoreLockSync(root, () => {
        const entries = fsSync.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const existing = readRecordSync(path.join(root, entry.name), this.maxRecordBytes);
          if (
            existing.principalId === record.principalId &&
            existing.agentId === record.agentId &&
            existing.handle.idempotencyKey === record.handle.idempotencyKey &&
            sameScope(existing.scope, record.scope)
          ) {
            return {
              status: existing.requestDigest === record.requestDigest ? 'existing' : 'conflict',
              record: existing,
            };
          }
        }
        const target = recordPath(root, record.handle.jobId);
        this.writeBounded(root, target, record, true);
        return { status: 'created', record };
      });
    });
  }

  update(record: RuntimeBackgroundJobRecord, expectedRevision: number): Promise<void> {
    return this.serial(async () => {
      const root = await this.rootPromise;
      withJobStoreLockSync(root, () => {
        const target = recordPath(root, record.handle.jobId);
        const existing = readRecordSync(target, this.maxRecordBytes);
        if (existing.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
          throw new JobStoreRevisionConflictError(record.handle.jobId);
        }
        this.writeBounded(root, target, record, false);
      });
    });
  }

  async list(): Promise<readonly RuntimeBackgroundJobRecord[]> {
    await this.queue;
    const root = await this.rootPromise;
    return withJobStoreLockSync(root, () => {
      const entries = fsSync.readdirSync(root, { withFileTypes: true });
      const records: RuntimeBackgroundJobRecord[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        records.push(readRecordSync(path.join(root, entry.name), this.maxRecordBytes));
      }
      return records;
    });
  }

  remove(jobId: string): Promise<void> {
    return this.serial(async () => {
      const root = await this.rootPromise;
      withJobStoreLockSync(root, () => {
        fsSync.rmSync(recordPath(root, jobId), { force: true });
      });
    });
  }

  private writeBounded(
    root: string,
    target: string,
    record: RuntimeBackgroundJobRecord,
    isNew: boolean,
  ): void {
    const content = stringifyJson(record, 'Background job record');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxRecordBytes) {
      throw codedError('JOB_RECORD_TOO_LARGE', `Job record exceeds ${this.maxRecordBytes} bytes.`);
    }
    ensureJobCapacitySync(
      root,
      target,
      bytes,
      isNew,
      this.maxJobs,
      this.maxTotalBytes,
      this.maxRecordBytes,
    );
    this.atomicWrite(root, target, content);
  }

  private atomicWrite(root: string, target: string, content: string): void {
    assertContained(root, target);
    const temp = path.join(root, `.job-${randomUUID()}.tmp`);
    fsSync.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    try {
      try {
        this.renameFile(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM') throw error;
        const existing = fsSync.lstatSync(target);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error('Job target is unsafe.');
        }
        fsSync.unlinkSync(target);
        this.renameFile(temp, target);
      }
    } finally {
      try {
        fsSync.rmSync(temp, { force: true });
      } catch {
        // The best-effort temp cleanup must not mask the durable write outcome.
      }
    }
  }

  /** @internal Portability seam for deterministic replacement-path verification. */
  protected renameFile(source: string, target: string): void {
    fsSync.renameSync(source, target);
  }

  private serial(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private serialValue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateStartRequest(request: RuntimeBackgroundJobStartRequest, maxBytes: number): void {
  if (typeof request.kind !== 'string' || !request.kind.trim() || request.kind.length > 256) {
    throw codedError('INVALID_JOB_KIND', 'Job kind must be 1-256 characters.');
  }
  requireKey(request.idempotencyKey, 'Job idempotencyKey');
  cloneJson(request, 'Background job start request', maxBytes);
}

function createJobRecord(
  request: RuntimeBackgroundJobStartRequest,
  context: InvocationContext,
  requestDigest: string,
  now: Date,
  jobId: string,
  maxValueBytes: number,
): RuntimeBackgroundJobRecord {
  const timestamp = now.toISOString();
  return cloneJson({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    handle: {
      jobId,
      kind: request.kind,
      idempotencyKey: request.idempotencyKey,
      createdAt: timestamp,
    },
    principalId: context.principal.id,
    agentId: canonicalAgentId(context),
    scope: context.scope,
    state: 'queued',
    attempt: 0,
    input: request.input,
    metadata: request.metadata,
    requestDigest,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0,
  }, 'Background job', maxValueBytes);
}

function validateHandlerResult(result: RuntimeBackgroundJobHandlerResult, maxBytes: number): void {
  if (!result || (result.status !== 'succeeded' && result.status !== 'paused')) {
    throw new TypeError('Job handler must return a succeeded or paused result.');
  }
  cloneJson(result, 'Background job result', maxBytes);
}

function toStartRequest(job: RuntimeBackgroundJobRecord): RuntimeBackgroundJobStartRequest {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: job.handle.kind,
    input: job.input,
    idempotencyKey: job.handle.idempotencyKey,
    metadata: job.metadata,
  };
}

function portableContext(context: InvocationContext): InvocationContext {
  return {
    principal: { ...context.principal },
    identity: context.identity ? { ...context.identity } : undefined,
    scope: context.scope ? { ...context.scope } : undefined,
    executionId: context.executionId,
    approval: context.approval ? { ...context.approval } : undefined,
    metadata: context.metadata ? { ...context.metadata } : undefined,
  };
}

function owns(job: RuntimeBackgroundJobRecord, context: InvocationContext): boolean {
  return job.principalId === context.principal.id
    && job.agentId === canonicalAgentId(context)
    && sameScope(job.scope, context.scope);
}

function canonicalAgentId(context: InvocationContext): string {
  const metadataAgentId = context.metadata?.agentId;
  const value = context.identity?.agentId
    ?? (typeof metadataAgentId === 'string' ? metadataAgentId : undefined)
    ?? context.principal.id;
  if (!value.trim()) throw new Error('Canonical agent identity is required for background jobs.');
  return value.trim();
}

function serializeError(error: unknown) {
  return {
    code:
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'background_job_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function initializeRoot(configured: string): Promise<string> {
  await fs.mkdir(configured, { recursive: true });
  const stat = await fs.lstat(configured);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Job root must be a directory.');
  return fs.realpath(configured);
}

function recordPath(root: string, jobId: string): string {
  requireKey(jobId, 'jobId');
  const target = path.join(root, `${jobId}.json`);
  assertContained(root, target);
  return target;
}

function readRecordSync(target: string, maxBytes: number): RuntimeBackgroundJobRecord {
  const before = fsSync.lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('Job record is not a regular file.');
  if (before.size > maxBytes) throw codedError('JOB_RECORD_TOO_LARGE', 'Job record exceeds its byte limit.');
  const handle = fsSync.openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fsSync.fstatSync(handle);
    const afterOpen = fsSync.lstatSync(target);
    if (!opened.isFile() || !sameStableFileIdentity(before, opened) || !sameStableFileIdentity(opened, afterOpen)) {
      throw codedError('JOB_RECORD_IDENTITY_CHANGED', 'Job record changed identity while it was opened.');
    }
    if (opened.size > maxBytes) throw codedError('JOB_RECORD_TOO_LARGE', 'Job record exceeds its byte limit.');
    const serialized = fsSync.readFileSync(handle, { encoding: 'utf8' });
    const afterDescriptorRead = fsSync.fstatSync(handle);
    const afterRead = fsSync.lstatSync(target);
    if (
      !sameStableFileSnapshot(opened, afterDescriptorRead) ||
      !sameStableFileIdentity(afterDescriptorRead, afterRead)
    ) {
      throw codedError('JOB_RECORD_IDENTITY_CHANGED', 'Job record changed while it was read.');
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      throw codedError('JOB_RECORD_TOO_LARGE', 'Job record exceeds its byte limit.');
    }
    return JSON.parse(serialized) as RuntimeBackgroundJobRecord;
  } finally {
    fsSync.closeSync(handle);
  }
}

function ensureJobCapacitySync(
  root: string,
  target: string,
  incomingBytes: number,
  isNew: boolean,
  maxJobs: number,
  maxTotalBytes: number,
  maxRecordBytes: number,
): void {
  const entries = fsSync.readdirSync(root, { withFileTypes: true });
  const files: Array<{
    path: string;
    size: number;
    modified: number;
    terminal: boolean;
  }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(root, entry.name);
    const stat = fsSync.lstatSync(filePath);
    const record = readRecordSync(filePath, maxRecordBytes);
    files.push({
      path: filePath,
      size: stat.size,
      modified: stat.mtimeMs,
      terminal: TERMINAL_STATES.has(record.state),
    });
  }
  const existing = files.find((file) => file.path === target);
  let count = files.length + (isNew ? 1 : 0);
  let total =
    files.reduce((sum, file) => sum + file.size, 0) - (existing?.size ?? 0) + incomingBytes;
  const candidates = files
    .filter((file) => file.path !== target && file.terminal)
    .sort((left, right) => left.modified - right.modified || left.path.localeCompare(right.path));
  for (const candidate of candidates) {
    if (count <= maxJobs && total <= maxTotalBytes) break;
    fsSync.rmSync(candidate.path, { force: true });
    count -= 1;
    total -= candidate.size;
  }
  if (count > maxJobs || total > maxTotalBytes) {
    throw codedError(
      'JOB_STORE_CAPACITY_EXCEEDED',
      'Job store capacity is exhausted by active jobs.',
    );
  }
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Job path escaped its root.');
  }
}

interface JobStoreLockOwner {
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
}

function withJobStoreLockSync<T>(root: string, operation: () => T): T {
  const lockPath = path.join(root, JOB_STORE_LOCK_NAME);
  const owner: JobStoreLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + JOB_STORE_LOCK_TIMEOUT_MS;
  acquireJobStoreLockSync(root, lockPath, owner, deadline);
  try {
    return operation();
  } finally {
    releaseJobStoreLockSync(lockPath, owner);
  }
}

function acquireJobStoreLockSync(
  root: string,
  lockPath: string,
  owner: JobStoreLockOwner,
  deadline: number,
): void {
  const candidate = path.join(root, `${JOB_STORE_LOCK_CANDIDATE_PREFIX}${owner.token}`);
  fsSync.mkdirSync(candidate, { mode: 0o700 });
  try {
    fsSync.writeFileSync(path.join(candidate, 'owner.json'), JSON.stringify(owner), {
      flag: 'wx',
      mode: 0o600,
    });
    for (;;) {
      if (isNextJobStoreLockCandidateSync(root, owner)) {
        try {
          fsSync.renameSync(candidate, lockPath);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const contention = code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EACCES';
          const blocked = existingLockBlocksAcquisitionSync(root, lockPath);
          if (!blocked && !contention) throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw codedError(
          'JOB_STORE_LOCK_TIMEOUT',
          `Timed out waiting for the durable job store lock at "${root}".`,
        );
      }
      blockingDelay(JOB_STORE_LOCK_RETRY_MS);
    }
  } finally {
    try {
      fsSync.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // The candidate was renamed into the canonical lock or is already gone.
    }
  }
}

function isNextJobStoreLockCandidateSync(
  root: string,
  owner: JobStoreLockOwner,
): boolean {
  const entries = fsSync.readdirSync(root, { withFileTypes: true });
  const waiters: JobStoreLockOwner[] = [];
  let found = false;
  for (const entry of entries) {
    if (!entry.name.startsWith(JOB_STORE_LOCK_CANDIDATE_PREFIX)) continue;
    const candidatePath = path.join(root, entry.name);
    let stat;
    try {
      stat = fsSync.lstatSync(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Job store lock candidate is unsafe.');
    }

    let serialized: string;
    try {
      serialized = fsSync.readFileSync(path.join(candidatePath, 'owner.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Date.now() - stat.mtimeMs >= JOB_STORE_LOCK_TIMEOUT_MS) {
        removeJobStoreLockCandidateSync(root, candidatePath);
      }
      continue;
    }
    let persisted: unknown;
    try {
      persisted = JSON.parse(serialized);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (Date.now() - stat.mtimeMs >= JOB_STORE_LOCK_TIMEOUT_MS) {
        removeJobStoreLockCandidateSync(root, candidatePath);
      }
      continue;
    }
    if (
      !isJobStoreLockOwner(persisted) ||
      entry.name !== `${JOB_STORE_LOCK_CANDIDATE_PREFIX}${persisted.token}`
    ) {
      if (Date.now() - stat.mtimeMs >= JOB_STORE_LOCK_TIMEOUT_MS) {
        removeJobStoreLockCandidateSync(root, candidatePath);
      }
      continue;
    }
    if (!isProcessAlive(persisted.pid)) {
      removeJobStoreLockCandidateSync(root, candidatePath);
      continue;
    }
    waiters.push(persisted);
    if (persisted.token === owner.token && persisted.pid === owner.pid) {
      found = true;
    }
  }
  if (!found) throw new Error('Job store lock candidate disappeared while waiting.');
  waiters.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.token.localeCompare(right.token),
  );
  return waiters[0]?.token === owner.token;
}

function removeJobStoreLockCandidateSync(root: string, candidate: string): void {
  const abandoned = path.join(root, `.job-store-abandoned-${randomUUID()}`);
  try {
    fsSync.renameSync(candidate, abandoned);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  fsSync.rmSync(abandoned, { recursive: true, force: true });
}

function existingLockBlocksAcquisitionSync(root: string, lockPath: string): boolean {
  let stat;
  try {
    stat = fsSync.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Job store lock is unsafe.');
  }
  const ownerPath = path.join(lockPath, 'owner.json');
  let owner: JobStoreLockOwner | undefined;
  for (let attempt = 0; attempt < JOB_STORE_LOCK_OWNER_READ_ATTEMPTS; attempt += 1) {
    try {
      const candidate = JSON.parse(fsSync.readFileSync(ownerPath, 'utf8')) as unknown;
      if (isJobStoreLockOwner(candidate)) {
        owner = candidate;
        break;
      }
    } catch (error) {
      // The owner may have released the lock after lstat. Treat disappearance as
      // transient contention and retry the atomic rename.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    }
    if (attempt + 1 < JOB_STORE_LOCK_OWNER_READ_ATTEMPTS) {
      blockingDelay(JOB_STORE_LOCK_RETRY_MS);
    }
  }
  if (!owner) throw new Error('Job store lock owner is invalid.');
  if (isProcessAlive(owner.pid)) return true;

  const abandoned = path.join(root, `.job-store-abandoned-${randomUUID()}`);
  try {
    fsSync.renameSync(lockPath, abandoned);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  fsSync.rmSync(abandoned, { recursive: true, force: true });
  return true;
}

function isJobStoreLockOwner(value: unknown): value is JobStoreLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<JobStoreLockOwner>;
  return (
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    Number.isSafeInteger(owner.pid) &&
    (owner.pid ?? 0) > 0 &&
    typeof owner.createdAt === 'string'
  );
}

function releaseJobStoreLockSync(lockPath: string, owner: JobStoreLockOwner): void {
  const persisted = JSON.parse(
    fsSync.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'),
  ) as JobStoreLockOwner;
  if (persisted.token !== owner.token || persisted.pid !== owner.pid) {
    throw new Error('Job store lock ownership changed before release.');
  }
  fsSync.rmSync(lockPath, { recursive: true, force: false });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Reclaim only when the OS definitively reports that the owner is gone.
    // Permission and platform-specific errors must fail closed to avoid
    // breaking a live writer's lock.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function blockingDelay(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}
