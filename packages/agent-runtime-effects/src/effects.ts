import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  RUNTIME_PROTOCOL_VERSION,
  assertSupportedProtocolVersion,
  type InvocationContext,
  type RuntimeEffectApprovalGrant,
  type RuntimeEffectClaimPort,
  type RuntimeEffectClaimResult,
  type RuntimeEffectExecutionClaim,
  type RuntimeEffectExecutionReceipt,
  type RuntimeEffectHandler,
  type RuntimeEffectHandlerResult,
  type RuntimeEffectReplayIdentity,
  type RuntimeEffectReplayEntry,
  type RuntimeEffectReplayPort,
  type RuntimeEffectRequest,
  type RuntimeEffectResponse,
} from '@marshal/agent-runtime-core';
import {
  cloneJson,
  codedError,
  requireKey,
  sha256,
  stableJson,
  storageKey,
  stringifyJson,
} from './json.js';

const DEFAULT_MAX_VALUE_BYTES = 1024 * 1024;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_CLAIM_POLL_MS = 25;

export interface RuntimeEffectApprovalVerificationRequest {
  readonly approval: RuntimeEffectApprovalGrant;
  readonly principalId: string;
  readonly scope?: InvocationContext['scope'];
  readonly kind: string;
  readonly requestDigest: string;
  readonly idempotencyKey: string;
  readonly effectId: string;
}

export type RuntimeEffectApprovalVerification =
  | {
      readonly decision: 'allow';
      /** Verifier-authenticated grant forwarded to the native handler. */
      readonly approval: RuntimeEffectApprovalGrant;
      /** The verifier must atomically consume the grant before returning allow. */
      readonly consumedAt: string;
      readonly expiresAt: string;
    }
  | { readonly decision: 'deny'; readonly code?: string; readonly reason: string };

/** Harness-owned trust port. `verifyAndConsume` must be atomic and one-time. */
export interface RuntimeEffectApprovalVerifier {
  verifyAndConsume(
    request: RuntimeEffectApprovalVerificationRequest,
  ): Promise<RuntimeEffectApprovalVerification> | RuntimeEffectApprovalVerification;
}

export interface EffectDispatcherOptions {
  readonly handler?: RuntimeEffectHandler;
  readonly replay?: RuntimeEffectReplayPort;
  readonly approvalVerifier?: RuntimeEffectApprovalVerifier;
  readonly maxValueBytes?: number;
  readonly claimLeaseMs?: number;
  readonly claimPollMs?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** Standardizes adapter callbacks, unsupported effects, approvals, and replay receipts. */
export class EffectDispatcher {
  private readonly handler?: RuntimeEffectHandler;
  private readonly replay?: RuntimeEffectReplayPort;
  private readonly approvalVerifier?: RuntimeEffectApprovalVerifier;
  private readonly maxValueBytes: number;
  private readonly claimLeaseMs: number;
  private readonly claimPollMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: EffectDispatcherOptions = {}) {
    this.handler = options.handler;
    this.replay = options.replay;
    this.approvalVerifier = options.approvalVerifier;
    this.maxValueBytes = positiveInteger(options.maxValueBytes, DEFAULT_MAX_VALUE_BYTES);
    this.claimLeaseMs = positiveInteger(options.claimLeaseMs, DEFAULT_CLAIM_LEASE_MS);
    this.claimPollMs = positiveInteger(options.claimPollMs, DEFAULT_CLAIM_POLL_MS);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: RuntimeEffectRequest<TInput>,
    context: InvocationContext,
    options: { readonly replay?: boolean } = {},
  ): Promise<RuntimeEffectResponse<TOutput>> {
    assertSupportedProtocolVersion(request.protocolVersion);
    validateEffectRequest(request, this.maxValueBytes);
    const replayEnabled = options.replay !== false;
    const requestDigest = sha256(
      stableJson({
        kind: request.kind,
        input: request.input ?? null,
        metadata: request.metadata ?? {},
      }),
    );
    const identity: RuntimeEffectReplayIdentity = {
      principalId: context.principal.id,
      scope: context.scope,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
    };
    const started = this.now();
    const effectId = request.effectId ?? this.createId();
    let claimPort: RuntimeEffectClaimPort | undefined;
    let claim: RuntimeEffectExecutionClaim | undefined;
    let heartbeat: ClaimHeartbeat | undefined;
    try {
      if (replayEnabled && this.handler) {
        if (!isClaimPort(this.replay)) {
          return this.responseWithReceipt<TOutput>(
            {
              status: 'failed',
              error: {
                code: 'effect_idempotency_unavailable',
                message: 'Native effect execution requires a durable atomic claim store.',
              },
            },
            request,
            context,
            started,
            effectId,
            false,
            undefined,
            requestDigest,
          );
        }
        claimPort = this.replay;
        try {
          const acquired = await acquireClaim(
            claimPort,
            identity,
            this.claimLeaseMs,
            this.claimPollMs,
            this.now,
            this.createId,
            context.signal,
          );
          if (acquired.status === 'completed') {
            return this.responseWithReceipt<TOutput>(
              stripReceipt(acquired.entry.response) as RuntimeEffectHandlerResult<TOutput>,
              request,
              context,
              started,
              effectId,
              true,
              acquired.entry.response.receipt.receiptId,
              requestDigest,
            );
          }
          if (acquired.status === 'conflict') {
            return this.responseWithReceipt<TOutput>(
              {
                status: 'failed',
                error: {
                  code: 'idempotency_key_reused',
                  message: 'The idempotency key is already bound to a different effect request.',
                },
              },
              request,
              context,
              started,
              effectId,
              false,
              undefined,
              requestDigest,
            );
          }
          claim = acquired.claim;
          heartbeat = maintainClaim(
            claimPort,
            identity,
            claim,
            this.claimLeaseMs,
            this.now,
          );
        } catch (error) {
          return this.responseWithReceipt<TOutput>(
            { status: 'failed', error: serializeError(error, 'effect_claim_failed') },
            request,
            context,
            started,
            effectId,
            false,
            undefined,
            requestDigest,
          );
        }
      }

      let result: RuntimeEffectHandlerResult<TOutput>;
      let handlerRequest = request;
      let approvalFailure: RuntimeEffectHandlerResult<TOutput> | undefined;
      if (request.approval) {
        const verification = await verifyApproval(
          this.approvalVerifier,
          request,
          context,
          effectId,
          requestDigest,
          this.now,
        );
        if (verification.decision === 'deny') {
          approvalFailure = {
            status: 'failed',
            error: {
              code: verification.code ?? 'effect_approval_unverified',
              message: verification.reason,
            },
          };
        } else {
          handlerRequest = { ...request, approval: verification.approval };
        }
      }
      let supports = false;
      let supportFailure: unknown;
      if (!approvalFailure && this.handler) {
        try {
          supports =
            (!this.handler.supportedKinds || this.handler.supportedKinds.includes(request.kind)) &&
            (!this.handler.supports || (await this.handler.supports(request.kind, context)));
        } catch (error) {
          supportFailure = error;
        }
      }
      if (approvalFailure) {
        result = approvalFailure;
      } else if (supportFailure) {
        result = {
          status: 'failed',
          error: serializeError(supportFailure, 'effect_support_check_failed'),
        };
      } else if (!supports || !this.handler) {
        result = {
          status: 'unsupported',
          reason: `No adapter handler supports effect "${request.kind}".`,
          supportedKinds: this.handler?.supportedKinds,
        };
      } else if (context.signal?.aborted) {
        result = {
          status: 'cancelled',
          error: { code: 'effect_cancelled', message: 'Effect execution was cancelled.' },
        };
      } else {
        try {
          result = await this.handler.handle<TInput, TOutput>(handlerRequest, context);
          validateHandlerResult(result, this.maxValueBytes);
        } catch (error) {
          result = {
            status: context.signal?.aborted ? 'cancelled' : 'failed',
            error: serializeError(error),
          };
        }
      }

      const response = this.responseWithReceipt(
        result,
        request,
        context,
        started,
        effectId,
        false,
        undefined,
        requestDigest,
      );
      heartbeat?.stop();
      heartbeat = undefined;
      if (claimPort && claim) {
        if (
          !approvalFailure &&
          response.status !== 'approval_required' &&
          response.status !== 'unsupported'
        ) {
          await claimPort.complete(identity, claim.claimId, response as RuntimeEffectResponse);
          claim = undefined;
        } else {
          await claimPort.release(identity, claim.claimId);
          claim = undefined;
        }
      }
      return response;
    } finally {
      heartbeat?.stop();
      if (claimPort && claim) {
        await Promise.resolve(claimPort.release(identity, claim.claimId)).catch(() => undefined);
      }
    }
  }

  private responseWithReceipt<TOutput>(
    result: RuntimeEffectHandlerResult<TOutput>,
    request: RuntimeEffectRequest,
    context: InvocationContext,
    started: Date,
    effectId: string,
    replayed: boolean,
    replayOfReceiptId?: string,
    requestDigest?: string,
  ): RuntimeEffectResponse<TOutput> {
    const completed = this.now();
    const resultDigest = sha256(stringifyJson(result, 'Effect result'));
    const receipt: RuntimeEffectExecutionReceipt = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      receiptId: this.createId(),
      effectId,
      kind: request.kind,
      idempotencyKey: request.idempotencyKey,
      requestDigest:
        requestDigest ??
        sha256(
          stableJson({
            kind: request.kind,
            input: request.input ?? null,
            metadata: request.metadata ?? {},
          }),
        ),
      principalId: context.principal.id,
      scope: context.scope,
      handler: this.handler ? { id: this.handler.id, version: this.handler.version } : undefined,
      status: result.status,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      replayed,
      replayOfReceiptId,
      resultDigest,
    };
    return cloneJson(
      { ...result, protocolVersion: RUNTIME_PROTOCOL_VERSION, receipt },
      'Effect response',
      this.maxValueBytes,
    ) as RuntimeEffectResponse<TOutput>;
  }
}

export interface BoundedFileEffectReplayStoreOptions {
  readonly rootDirectory: string;
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxTotalBytes?: number;
  readonly transactionLockTimeoutMs?: number;
  readonly staleTransactionLockMs?: number;
}

/** Content-bounded durable replay cache. It stores results, never callbacks. */
export class BoundedFileEffectReplayStore implements RuntimeEffectClaimPort {
  private readonly rootPromise: Promise<string>;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private readonly maxTotalBytes: number;
  private readonly transactionLockTimeoutMs: number;
  private readonly staleTransactionLockMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: BoundedFileEffectReplayStoreOptions) {
    if (!path.isAbsolute(options.rootDirectory)) throw new Error('rootDirectory must be absolute.');
    this.maxEntries = positiveInteger(options.maxEntries, 1_000);
    this.maxEntryBytes = positiveInteger(options.maxEntryBytes, 2 * 1024 * 1024);
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes, 64 * 1024 * 1024);
    this.transactionLockTimeoutMs = positiveInteger(options.transactionLockTimeoutMs, 10_000);
    this.staleTransactionLockMs = positiveInteger(options.staleTransactionLockMs, 30_000);
    this.rootPromise = initializeRoot(options.rootDirectory);
  }

  async get(identity: RuntimeEffectReplayIdentity): Promise<RuntimeEffectReplayEntry | undefined> {
    const root = await this.rootPromise;
    const target = path.join(root, `${effectStorageKey(identity)}.json`);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Replay entry is not a file.');
      if (stat.size > this.maxEntryBytes) throw new Error('Replay entry exceeds its byte limit.');
      return JSON.parse(await fs.readFile(target, 'utf8')) as RuntimeEffectReplayEntry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  put(identity: RuntimeEffectReplayIdentity, response: RuntimeEffectResponse): Promise<void> {
    return this.serial(async () => {
      const root = await this.rootPromise;
      await this.withTransaction(root, identity, async () => {
        const existing = await this.get(identity);
        if (existing && existing.identity.requestDigest !== identity.requestDigest) {
          throw codedError(
            'IDEMPOTENCY_KEY_REUSED',
            'The replay key is already bound to a different effect request.',
          );
        }
        const activeClaim = await this.readClaim(root, identity);
        if (activeClaim) {
          throw codedError(
            'EFFECT_CLAIM_REQUIRED',
            'Cannot write replay state while an execution claim is active.',
          );
        }
        await this.writeReplay(root, identity, response);
      });
    });
  }

  async claim(
    identity: RuntimeEffectReplayIdentity,
    claim: RuntimeEffectExecutionClaim,
  ): Promise<RuntimeEffectClaimResult> {
    const root = await this.rootPromise;
    return this.withTransaction(root, identity, async () => {
      const completed = await this.get(identity);
      if (completed) {
        return completed.identity.requestDigest === identity.requestDigest
          ? { status: 'completed' as const, entry: completed }
          : {
              status: 'conflict' as const,
              existingRequestDigest: completed.identity.requestDigest,
            };
      }
      const existing = await this.readClaim(root, identity);
      if (existing) {
        if (existing.identity.requestDigest !== identity.requestDigest) {
          return {
            status: 'conflict' as const,
            existingRequestDigest: existing.identity.requestDigest,
          };
        }
        if (Date.parse(existing.claim.expiresAt) > Date.parse(claim.claimedAt)) {
          return { status: 'busy' as const, expiresAt: existing.claim.expiresAt };
        }
      }
      await atomicWrite(
        root,
        claimPath(root, identity),
        stringifyJson({ identity, claim }, 'Effect execution claim'),
      );
      return { status: 'acquired' as const, claim };
    });
  }

  async renew(
    identity: RuntimeEffectReplayIdentity,
    claim: RuntimeEffectExecutionClaim,
  ): Promise<boolean> {
    const root = await this.rootPromise;
    return this.withTransaction(root, identity, async () => {
      const existing = await this.readClaim(root, identity);
      if (
        !existing ||
        existing.identity.requestDigest !== identity.requestDigest ||
        existing.claim.claimId !== claim.claimId
      ) return false;
      await atomicWrite(
        root,
        claimPath(root, identity),
        stringifyJson({ identity, claim }, 'Effect execution claim'),
      );
      return true;
    });
  }

  async complete(
    identity: RuntimeEffectReplayIdentity,
    claimId: string,
    response: RuntimeEffectResponse,
  ): Promise<void> {
    const root = await this.rootPromise;
    await this.withTransaction(root, identity, async () => {
      const existing = await this.readClaim(root, identity);
      if (
        !existing ||
        existing.identity.requestDigest !== identity.requestDigest ||
        existing.claim.claimId !== claimId
      ) throw codedError('EFFECT_CLAIM_LOST', 'Effect execution claim is no longer owned.');
      await this.writeReplay(root, identity, response);
      await fs.rm(claimPath(root, identity), { force: true });
    });
  }

  async release(identity: RuntimeEffectReplayIdentity, claimId: string): Promise<void> {
    const root = await this.rootPromise;
    await this.withTransaction(root, identity, async () => {
      const existing = await this.readClaim(root, identity);
      if (existing?.claim.claimId === claimId) {
        await fs.rm(claimPath(root, identity), { force: true });
      }
    });
  }

  private async readClaim(
    root: string,
    identity: RuntimeEffectReplayIdentity,
  ): Promise<{ identity: RuntimeEffectReplayIdentity; claim: RuntimeEffectExecutionClaim } | undefined> {
    const target = claimPath(root, identity);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Effect claim is not a file.');
      if (stat.size > this.maxEntryBytes) throw new Error('Effect claim exceeds its byte limit.');
      return JSON.parse(await fs.readFile(target, 'utf8')) as {
        identity: RuntimeEffectReplayIdentity;
        claim: RuntimeEffectExecutionClaim;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async writeReplay(
    root: string,
    identity: RuntimeEffectReplayIdentity,
    response: RuntimeEffectResponse,
  ): Promise<void> {
    const content = stringifyJson({ identity, response }, 'Effect replay response');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxEntryBytes) {
      throw codedError('REPLAY_ENTRY_TOO_LARGE', `Replay entry exceeds ${this.maxEntryBytes} bytes.`);
    }
    const target = path.join(root, `${effectStorageKey(identity)}.json`);
    await atomicWrite(root, target, content);
    await enforceDirectoryBounds(root, this.maxEntries, this.maxTotalBytes, path.basename(target));
  }

  private async withTransaction<T>(
    root: string,
    identity: RuntimeEffectReplayIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await acquireStorageLock(
      root,
      effectStorageKey(identity),
      this.transactionLockTimeoutMs,
      this.staleTransactionLockMs,
    );
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private serial(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

interface ClaimHeartbeat {
  stop(): void;
}

async function verifyApproval(
  verifier: RuntimeEffectApprovalVerifier | undefined,
  request: RuntimeEffectRequest,
  context: InvocationContext,
  effectId: string,
  requestDigest: string,
  now: () => Date,
): Promise<RuntimeEffectApprovalVerification> {
  if (!verifier) {
    return {
      decision: 'deny',
      code: 'effect_approval_verifier_unavailable',
      reason: 'Caller-supplied effect approval cannot be trusted without a harness verifier.',
    };
  }
  try {
    const verified = await verifier.verifyAndConsume({
      approval: request.approval!,
      principalId: context.principal.id,
      scope: context.scope,
      kind: request.kind,
      requestDigest,
      idempotencyKey: request.idempotencyKey,
      effectId,
    });
    if (verified.decision === 'deny') return verified;
    if (verified.approval.approvalId !== request.approval!.approvalId) {
      return {
        decision: 'deny',
        code: 'effect_approval_identity_mismatch',
        reason: 'The verified approval does not match the supplied approval identity.',
      };
    }
    const consumedAt = Date.parse(verified.consumedAt);
    const expiresAt = Date.parse(verified.expiresAt);
    const verifiedAt = now().getTime();
    if (
      !Number.isFinite(consumedAt) ||
      !Number.isFinite(expiresAt) ||
      consumedAt > verifiedAt ||
      consumedAt >= expiresAt ||
      expiresAt <= verifiedAt
    ) {
      return {
        decision: 'deny',
        code: 'effect_approval_expired',
        reason: 'The verified approval is expired or has invalid verifier timestamps.',
      };
    }
    return verified;
  } catch (error) {
    return {
      decision: 'deny',
      code: 'effect_approval_verification_failed',
      reason: error instanceof Error ? error.message : 'Effect approval verification failed.',
    };
  }
}

async function acquireClaim(
  port: RuntimeEffectClaimPort,
  identity: RuntimeEffectReplayIdentity,
  leaseMs: number,
  pollMs: number,
  now: () => Date,
  createId: () => string,
  signal?: { readonly aborted: boolean; readonly reason?: unknown },
): Promise<Exclude<RuntimeEffectClaimResult, { status: 'busy' }>> {
  const claimId = createId();
  while (true) {
    if (signal?.aborted) throw codedError('effect_cancelled', 'Effect execution was cancelled.');
    const claimedAt = now();
    const requested: RuntimeEffectExecutionClaim = {
      claimId,
      claimedAt: claimedAt.toISOString(),
      expiresAt: new Date(claimedAt.getTime() + leaseMs).toISOString(),
    };
    const result = await port.claim(identity, requested);
    if (result.status !== 'busy') return result;
    const remaining = Math.max(1, Date.parse(result.expiresAt) - now().getTime());
    await waitForClaim(Math.min(pollMs, remaining), signal);
  }
}

function maintainClaim(
  port: RuntimeEffectClaimPort,
  identity: RuntimeEffectReplayIdentity,
  initial: RuntimeEffectExecutionClaim,
  leaseMs: number,
  now: () => Date,
): ClaimHeartbeat {
  let stopped = false;
  let current = initial;
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      if (stopped) return;
      const renewedAt = now();
      const renewed: RuntimeEffectExecutionClaim = {
        ...current,
        expiresAt: new Date(renewedAt.getTime() + leaseMs).toISOString(),
      };
      try {
        if (!(await port.renew(identity, renewed))) return;
        current = renewed;
        schedule();
      } catch {
        // Completion validates ownership and reports a lost lease. The native
        // adapter must also honor the downstream idempotency key after crashes.
      }
    }, Math.max(10, Math.floor(leaseMs / 3)));
    timer.unref?.();
  };
  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function isClaimPort(port: RuntimeEffectReplayPort | undefined): port is RuntimeEffectClaimPort {
  return Boolean(
    port &&
      typeof (port as Partial<RuntimeEffectClaimPort>).claim === 'function' &&
      typeof (port as Partial<RuntimeEffectClaimPort>).renew === 'function' &&
      typeof (port as Partial<RuntimeEffectClaimPort>).complete === 'function' &&
      typeof (port as Partial<RuntimeEffectClaimPort>).release === 'function',
  );
}

async function waitForClaim(
  ms: number,
  signal?: { readonly aborted: boolean; readonly reason?: unknown },
): Promise<void> {
  if (signal?.aborted) throw codedError('effect_cancelled', 'Effect execution was cancelled.');
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
  if (signal?.aborted) throw codedError('effect_cancelled', 'Effect execution was cancelled.');
}

function validateEffectRequest(request: RuntimeEffectRequest, maxBytes: number): void {
  if (typeof request.kind !== 'string' || !request.kind.trim() || request.kind.length > 256) {
    throw codedError('INVALID_EFFECT_KIND', 'Effect kind must be 1-256 characters.');
  }
  requireKey(request.idempotencyKey, 'Effect idempotencyKey');
  cloneJson(request, 'Effect request', maxBytes);
}

function validateHandlerResult(result: RuntimeEffectHandlerResult, maxBytes: number): void {
  if (!result || typeof result !== 'object')
    throw new TypeError('Effect handler returned no result.');
  if (
    !['success', 'unsupported', 'approval_required', 'failed', 'cancelled'].includes(result.status)
  ) {
    throw new TypeError(
      `Invalid effect handler status: ${String((result as { status?: unknown }).status)}`,
    );
  }
  cloneJson(result, 'Effect handler result', maxBytes);
}

function stripReceipt(response: RuntimeEffectResponse): RuntimeEffectHandlerResult {
  const { protocolVersion: _protocolVersion, receipt: _receipt, ...result } = response;
  return result as RuntimeEffectHandlerResult;
}

function serializeError(error: unknown, fallbackCode = 'effect_handler_failed') {
  return {
    code:
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function effectStorageKey(identity: RuntimeEffectReplayIdentity): string {
  const { requestDigest: _requestDigest, ...partition } = identity;
  return storageKey(partition);
}

function claimPath(root: string, identity: RuntimeEffectReplayIdentity): string {
  const target = path.join(root, `${effectStorageKey(identity)}.claim`);
  assertContained(root, target);
  return target;
}

async function acquireStorageLock(
  root: string,
  key: string,
  timeoutMs: number,
  staleMs: number,
): Promise<() => Promise<void>> {
  const target = path.join(root, `.${key}.lock`);
  assertContained(root, target);
  const owner = randomUUID();
  const deadline = Date.now() + timeoutMs;
  await cleanupStorageLockQuarantines(root, key, timeoutMs);
  while (true) {
    assertStorageLockDeadline(deadline);
    try {
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'owner'), owner, { flag: 'wx', mode: 0o600 });
      const heartbeat = maintainStorageLock(target, owner, staleMs);
      return async () => {
        await heartbeat.stop();
        try {
          if ((await fs.readFile(path.join(target, 'owner'), 'utf8')) !== owner) return;
          const released = path.join(root, `.${key}.released-${sha256(owner).slice(7, 39)}`);
          await renameDirectoryPortable(target, released);
          const movedOwner = await fs.readFile(path.join(released, 'owner'), 'utf8');
          if (movedOwner !== owner) {
            throw new Error('Effect transaction lock ownership changed during release.');
          }
          await fs.rm(released, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observed = await observeStorageLock(target);
      if (!observed) continue;
      if (Date.now() - observed.modifiedAt > staleMs) {
        assertStorageLockDeadline(deadline);
        const observedKey = sha256(observed.ownerToken).slice(7, 39);
        const reclaimMarker = path.join(root, `.${key}.reclaim-${observedKey}`);
        const quarantine = path.join(
          root,
          `.${key}.stale-${observedKey}`,
        );
        assertContained(root, reclaimMarker);
        assertContained(root, quarantine);
        try {
          await fs.mkdir(reclaimMarker);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'EEXIST') {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            continue;
          }
          throw failure;
        }
        try {
          // Token-bound re-observation closes the stale-reclaimer ABA window:
          // a paused contender cannot move a successor that acquired the
          // canonical path after the observed owner was quarantined.
          const current = await observeStorageLock(target);
          if (
            !current ||
            current.ownerToken !== observed.ownerToken ||
            Date.now() - current.modifiedAt <= staleMs
          ) continue;
          await fs.rename(target, quarantine);
          const moved = await observeStorageLock(quarantine);
          if (!moved || moved.ownerToken !== observed.ownerToken) {
            throw new Error('Effect transaction lock changed during stale-owner recovery.');
          }
          const reclaimedAt = new Date();
          await fs.utimes(quarantine, reclaimedAt, reclaimedAt);
          scheduleStorageLockQuarantineCleanup(quarantine, timeoutMs);
        } catch (failure) {
          const code = (failure as NodeJS.ErrnoException).code;
          if (
            code !== 'ENOENT' &&
            code !== 'EEXIST' &&
            code !== 'ENOTEMPTY' &&
            code !== 'EPERM'
          ) throw failure;
        } finally {
          await fs.rm(reclaimMarker, { recursive: true, force: true }).catch(() => undefined);
        }
        continue;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}

async function renameDirectoryPortable(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 20) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}

interface StorageLockObservation {
  readonly ownerToken: string;
  readonly modifiedAt: number;
}

async function observeStorageLock(target: string): Promise<StorageLockObservation | undefined> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Effect transaction lock is unsafe.');
    }
    const ownerPath = path.join(target, 'owner');
    try {
      const ownerStat = await fs.lstat(ownerPath);
      if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
        throw new Error('Effect transaction lock owner is unsafe.');
      }
      return {
        ownerToken: await fs.readFile(ownerPath, 'utf8'),
        modifiedAt: ownerStat.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { ownerToken: `missing:${Math.floor(stat.birthtimeMs)}`, modifiedAt: stat.mtimeMs };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function maintainStorageLock(
  target: string,
  owner: string,
  staleMs: number,
): { stop(): Promise<void> } {
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const intervalMs = Math.max(1, Math.floor(staleMs / 3));
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending.then(async () => {
      const ownerPath = path.join(target, 'owner');
      if ((await fs.readFile(ownerPath, 'utf8').catch(() => undefined)) !== owner) return;
      const now = new Date();
      await fs.utimes(ownerPath, now, now);
    }).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}

function assertStorageLockDeadline(deadline: number): void {
  if (Date.now() >= deadline) {
    throw codedError('EFFECT_STORAGE_LOCK_TIMEOUT', 'Timed out acquiring effect storage lock.');
  }
}

async function cleanupStorageLockQuarantines(
  root: string,
  key: string,
  timeoutMs: number,
): Promise<void> {
  const prefix = `.${key}.stale-`;
  const now = Date.now();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const target = path.join(root, entry.name);
    const stat = await fs.lstat(target);
    if (now - stat.mtimeMs > timeoutMs) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
}

function scheduleStorageLockQuarantineCleanup(target: string, timeoutMs: number): void {
  const timer = setTimeout(() => {
    void fs.rm(target, { recursive: true, force: true });
  }, timeoutMs + 10);
  timer.unref?.();
}

async function initializeRoot(configured: string): Promise<string> {
  await fs.mkdir(configured, { recursive: true });
  const stat = await fs.lstat(configured);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Replay root must be a directory.');
  return fs.realpath(configured);
}

async function atomicWrite(root: string, target: string, content: string): Promise<void> {
  assertContained(root, target);
  const temp = path.join(root, `.effect-${randomUUID()}.tmp`);
  await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await fs.rename(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      const existing = await fs.lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile())
        throw new Error('Replay target is unsafe.');
      await fs.unlink(target);
      await fs.rename(temp, target);
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function enforceDirectoryBounds(
  root: string,
  maxEntries: number,
  maxTotalBytes: number,
  preserve: string,
): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const stat = await fs.lstat(path.join(root, entry.name));
        return { name: entry.name, size: stat.size, modified: stat.mtimeMs };
      }),
  );
  files.sort(
    (left, right) => left.modified - right.modified || left.name.localeCompare(right.name),
  );
  let total = files.reduce((sum, file) => sum + file.size, 0);
  let count = files.length;
  for (const file of files) {
    if (count <= maxEntries && total <= maxTotalBytes) break;
    if (file.name === preserve && files.length > 1) continue;
    await fs.rm(path.join(root, file.name), { force: true });
    total -= file.size;
    count -= 1;
  }
  if (count > maxEntries || total > maxTotalBytes) {
    await fs.rm(path.join(root, preserve), { force: true });
    throw codedError('REPLAY_CAPACITY_EXCEEDED', 'Replay store capacity is exhausted.');
  }
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Replay path escaped its root.');
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}
