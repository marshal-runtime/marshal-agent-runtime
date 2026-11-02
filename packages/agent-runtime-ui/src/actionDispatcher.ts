import { createHash, randomUUID } from 'node:crypto';
import type {
  InvocationContext,
  PermissionDecision,
  RuntimeError,
  RuntimeExecResponse,
  RuntimeExecutionReceipt,
  RuntimeExecutionStatus,
} from '@marshal/agent-runtime-core';
import {
  type UiActionDispatcherOptions,
  type UiActionExecutionRequest,
  type UiActionIdempotencyLease,
  type UiActionJournalAttempt,
  type UiActionResult,
  type UiActionToolInput,
} from './applicationTypes.js';
import { assertUiSchema } from './schemaValidation.js';
import { stableStringify, stateScopeKey } from './store.js';

interface UiActionOutcome {
  status: RuntimeExecutionStatus;
  hasOutput?: boolean;
  output?: unknown;
  error?: RuntimeError;
  approval?: RuntimeExecResponse['approval'];
  targetReceipt?: RuntimeExecutionReceipt;
}

export class UiActionDispatcher {
  constructor(private readonly options: UiActionDispatcherOptions) {}

  async invoke(input: UiActionToolInput, context: InvocationContext): Promise<UiActionResult> {
    throwIfCancelled(context);
    const application = await this.options.loadApplication(input.renderId, context);
    if (!application) throw new Error(`Render ${input.renderId} has no declared application manifest`);
    const action = application.actions.find((item) => item.id === input.actionId);
    if (!action) throw new Error(`UI action ${input.actionId} is not declared for render ${input.renderId}`);
    if (!action.allowedScopes.includes(input.scope)) {
      throw new Error(`UI action ${action.id} does not allow ${input.scope} scope`);
    }
    if (action.idempotency === 'none' && input.idempotencyKey) {
      throw new Error(`UI action ${action.id} does not accept an idempotency key`);
    }
    if (action.idempotency === 'required' && !input.idempotencyKey) {
      throw new Error(`UI action ${action.id} requires an idempotency key`);
    }
    if (input.idempotencyKey && !this.options.idempotencyStore) {
      throw new Error('UI action idempotency requires a durable idempotency store');
    }
    if (this.options.journalStore && !this.options.idempotencyStore) {
      throw new Error('Durable UI action receipts require a durable ownership store');
    }
    assertUiSchema(input.input ?? {}, action.inputSchema, `action.${action.id}.input`);

    const requestDigest = actionRequestDigest({
      renderId: input.renderId,
      action,
      input: input.input ?? {},
      scope: input.scope,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.approval ? { approval: input.approval } : {}),
    });
    const idempotencyKey = input.idempotencyKey
      ? actionIdempotencyKey(
          input.renderId,
          action.id,
          action.version,
          input.scope,
          input.idempotencyKey,
        )
      : undefined;
    const candidateReceiptId = (this.options.receiptId ?? randomUUID)();
    const journalKey = idempotencyKey ?? actionJournalKey(candidateReceiptId);
    const ownershipKey = idempotencyKey ?? journalKey;
    const leaseMs = this.options.idempotencyLeaseMs ?? 60_000;
    const pollMs = this.options.idempotencyPollMs ?? 25;
    const claim = this.options.idempotencyStore
      ? await this.claim(ownershipKey, input.scope, requestDigest, leaseMs, pollMs, context)
      : undefined;
    if (claim?.status === 'replay') {
      if (!idempotencyKey) {
        throw new Error('Unkeyed UI action ownership unexpectedly resolved to a replay result');
      }
      throwIfCancelled(context);
      if (this.options.journalStore) {
        await this.options.journalStore.close(
          idempotencyKey!,
          input.scope,
          claim.record.result.receipt.receiptId,
          context,
        );
      }
      return replayedResult(claim.record.result);
    }

    const lease = claim?.status === 'acquired' ? claim.lease : undefined;
    const rootIdentity = uiActionRootIdentity(context, candidateReceiptId);
    const candidateAttempt: UiActionJournalAttempt = {
      receiptId: candidateReceiptId,
      executionId: rootIdentity.executionId,
      lineage: rootIdentity.lineage,
      renderId: input.renderId,
      actionId: action.id,
      actionVersion: action.version,
      target: action.target,
      scope: input.scope,
      principalId: context.principal.id,
      ...(context.identity ? { identity: context.identity } : {}),
      ...(context.scope ? { invocationScope: context.scope } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      requestDigest,
      targetIdempotencyKey: actionTargetIdempotencyKey(
        idempotencyKey ?? candidateReceiptId,
        input.scope,
        context,
      ),
      startedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      ...(input.activation ? { activation: input.activation } : {}),
      ...(lease ? { ownerId: lease.ownerId, leaseExpiresAt: lease.expiresAt } : {}),
      ownerPid: process.pid,
      phase: 'pending',
    };

    let heartbeat: Awaited<ReturnType<UiActionDispatcher['heartbeat']>> | undefined;
    try {
      const attempt = this.options.journalStore
        ? await this.options.journalStore.begin(
            journalKey,
            input.scope,
            candidateAttempt,
            context,
          )
        : candidateAttempt;
      if (attempt.phase === 'terminal' && attempt.result?.status === 'success') {
        if (!idempotencyKey || !lease) {
          throw new Error('Recovered successful UI action root has no durable idempotency claim');
        }
        await this.options.idempotencyStore!.complete(
          idempotencyKey,
          input.scope,
          lease,
          { requestDigest, result: attempt.result },
          context,
        );
        await this.options.journalStore?.close(
          journalKey,
          input.scope,
          attempt.receiptId,
          context,
        );
        return replayedResult(attempt.result);
      }

      const controller = new AbortController();
      const detachCallerAbort = relayAbort(context.signal, controller);
      const executionContext = uiActionExecutionContext(context, attempt, controller.signal);
      const request: UiActionExecutionRequest = {
        renderId: input.renderId,
        action,
        input: input.input ?? {},
        scope: input.scope,
        targetIdempotencyKey: attempt.targetIdempotencyKey,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.approval ? { approval: input.approval } : {}),
        ...(input.activation ? { activation: input.activation } : {}),
      };
      heartbeat = lease
        ? await this.heartbeat(
            ownershipKey,
            journalKey,
            input.scope,
            attempt.receiptId,
            lease,
            leaseMs,
            executionContext,
            controller,
          )
        : undefined;

      let permission: PermissionDecision = {
        decision: 'deny',
        code: 'ui_action_not_authorized',
        reason: 'UI action authorization did not complete.',
      };
      let outcome: UiActionOutcome;
      try {
        throwIfAborted(controller.signal);
        permission = await this.options.authorize.authorize(request, executionContext);
        if (heartbeat?.failure()) throw heartbeat.failure();
        throwIfAborted(controller.signal);
        if (permission.decision !== 'allow') {
          outcome = {
            status: permission.decision === 'approval' ? 'approval_required' : 'denied',
            ...(permission.decision === 'approval' ? { approval: permission } : {}),
          };
        } else {
          const executed = await this.options.executor.execute(request, executionContext);
          outcome = this.validateOutcome(executed, request, executionContext);
        }
      } catch (error) {
        outcome = actionFailureOutcome(error, context, heartbeat?.failure());
        if (permission.decision !== 'allow' && outcome.status !== 'approval_required') {
          permission = {
            decision: 'deny',
            code: outcome.error?.code ?? 'ui_action_failed',
            reason: outcome.error?.message ?? 'UI action execution failed.',
          };
        }
      } finally {
        detachCallerAbort();
      }

      await heartbeat?.prepareForPersistence();
      if (heartbeat?.persistenceFailure()) {
        outcome = {
          status: 'failed',
          error: runtimeError(
            heartbeat.persistenceFailure(),
            'ui_action_lease_state_persistence_failed',
            'UI action lease-loss state could not be persisted.',
          ),
          ...(outcome.targetReceipt ? { targetReceipt: outcome.targetReceipt } : {}),
        };
      } else if (heartbeat?.failure()) {
        outcome = {
          ...leaseLossOutcome(heartbeat.failure()!),
          ...(outcome.targetReceipt ? { targetReceipt: outcome.targetReceipt } : {}),
        };
      } else if (context.signal?.aborted && outcome.status !== 'cancelled') {
        outcome = {
          ...cancelledOutcome(),
          ...(outcome.targetReceipt ? { targetReceipt: outcome.targetReceipt } : {}),
        };
      }

      const result = this.result(request, attempt, permission, outcome);
      await this.options.journalStore?.terminalize(
        journalKey,
        input.scope,
        attempt.receiptId,
        result,
        contextWithoutSignal(context),
      );
      if (idempotencyKey && lease && result.status === 'success') {
        await this.options.idempotencyStore!.complete(
          idempotencyKey,
          input.scope,
          heartbeat?.current() ?? lease,
          { requestDigest, result },
          contextWithoutSignal(context),
        );
        await this.options.journalStore?.close(
          journalKey,
          input.scope,
          attempt.receiptId,
          contextWithoutSignal(context),
        );
      }
      return result;
    } finally {
      await heartbeat?.stop();
      if (lease) {
        await this.options.idempotencyStore!.release(
          ownershipKey,
          input.scope,
          heartbeat?.current() ?? lease,
          contextWithoutSignal(context),
        );
      }
    }
  }

  private async claim(
    key: string,
    scope: UiActionToolInput['scope'],
    requestDigest: string,
    leaseMs: number,
    pollMs: number,
    context: InvocationContext,
  ) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 10_000) {
      throw new Error('UI action idempotency poll interval must be 1-10000 milliseconds');
    }
    for (;;) {
      throwIfCancelled(context);
      const claim = await this.options.idempotencyStore!.claim(
        key,
        scope,
        requestDigest,
        leaseMs,
        context,
      );
      if (context.signal?.aborted) {
        if (claim.status === 'acquired') {
          await this.options.idempotencyStore!.release(
            key,
            scope,
            claim.lease,
            contextWithoutSignal(context),
          );
        }
        throwIfCancelled(context);
      }
      if (claim.status !== 'busy') return claim;
      await delay(Math.max(1, Math.min(pollMs, claim.retryAfterMs)), context);
    }
  }

  private async heartbeat(
    key: string,
    journalKey: string,
    scope: UiActionToolInput['scope'],
    receiptId: string,
    initialLease: UiActionIdempotencyLease,
    leaseMs: number,
    context: InvocationContext,
    controller: AbortController,
  ) {
    let lease = initialLease;
    let renewTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failure: Error | undefined;
    let persistenceFailure: Error | undefined;
    let markPromise: Promise<void> | undefined;
    let renewal: Promise<void> | undefined;
    const intervalMs = Math.max(5, Math.floor(leaseMs / 3));
    const storageContext = contextWithoutSignal(context);

    const lose = (reason: unknown) => {
      if (stopped || failure) return;
      failure = leaseLossError(reason);
      controller.abort(failure);
      if (renewTimer) clearTimeout(renewTimer);
      if (this.options.journalStore) {
        markPromise = this.options.journalStore.markLeaseLost(
          journalKey,
          scope,
          receiptId,
          { code: 'ui_action_lease_lost', message: failure.message },
          storageContext,
        ).catch((error: unknown) => {
          persistenceFailure = runtimeErrorObject(
            error,
            'UI action lease-loss state persistence failed',
          );
        });
      }
    };

    const renewOnce = async (durationMs = leaseMs): Promise<void> => {
      const renewed = await this.options.idempotencyStore!.renew(
        key,
        scope,
        lease,
        durationMs,
        storageContext,
      );
      if (!renewed) {
        lose(new Error('UI action idempotency lease was lost during execution'));
        return;
      }
      lease = renewed;
    };
    const renew = (): Promise<void> => {
      if (renewal) return renewal;
      renewal = renewOnce()
        .catch(lose)
        .finally(() => { renewal = undefined; });
      return renewal;
    };
    const schedule = () => {
      if (stopped || failure || context.signal?.aborted) return;
      if (renewTimer) clearTimeout(renewTimer);
      renewTimer = setTimeout(() => {
        void renew().then(() => {
          if (stopped || failure) return;
          schedule();
        });
      }, intervalMs);
      renewTimer.unref?.();
    };
    await renew();
    if (!failure) schedule();

    return {
      current: () => lease,
      failure: () => failure,
      persistenceFailure: () => persistenceFailure,
      prepareForPersistence: async () => {
        if (renewTimer) clearTimeout(renewTimer);
        await renewal;
        if (!failure) await renew();
        if (!stopped && !failure) schedule();
      },
      stop: async () => {
        if (!stopped) {
          stopped = true;
          if (renewTimer) clearTimeout(renewTimer);
        }
        await renewal;
        await markPromise;
      },
    };
  }

  private validateOutcome(
    executed: RuntimeExecResponse,
    request: UiActionExecutionRequest,
    context: InvocationContext,
  ): UiActionOutcome {
    const targetReceipt = bindTargetReceipt(executed.receipt, context);
    if (context.signal?.aborted && executed.status !== 'cancelled') {
      return { ...cancelledOutcome(), targetReceipt };
    }
    let outcome: UiActionOutcome = {
      status: executed.status,
      ...(executed.result
        ? { hasOutput: true, output: executed.result.output }
        : {}),
      ...(executed.error ? { error: executed.error } : {}),
      ...(executed.approval ? { approval: executed.approval } : {}),
      targetReceipt,
    };
    if (executed.result?.output !== undefined) {
      try {
        assertUiSchema(
          executed.result.output,
          request.action.outputSchema,
          `action.${request.action.id}.output`,
        );
      } catch (error) {
        outcome = {
          ...outcome,
          status: 'failed',
          error: {
            code: 'ui_action_output_schema_failed',
            message:
              error instanceof Error
                ? error.message
                : 'UI action output failed validation.',
          },
        };
      }
    }
    return outcome;
  }

  private result(
    request: UiActionExecutionRequest,
    attempt: UiActionJournalAttempt,
    permission: PermissionDecision,
    outcome: UiActionOutcome,
  ): UiActionResult {
    const completed = (this.options.now ?? (() => new Date()))();
    const started = new Date(attempt.startedAt);
    return {
      status: outcome.status,
      ...(outcome.hasOutput ? { output: outcome.output } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.approval
        ? { approval: outcome.approval }
        : permission.decision === 'approval'
          ? { approval: permission }
          : {}),
      receipt: {
        receiptId: attempt.receiptId,
        executionId: attempt.executionId,
        lineage: attempt.lineage,
        renderId: request.renderId,
        actionId: request.action.id,
        actionVersion: request.action.version,
        target: request.action.target,
        scope: request.scope,
        principalId: attempt.principalId,
        ...(attempt.identity ? { identity: attempt.identity } : {}),
        ...(attempt.invocationScope ? { invocationScope: attempt.invocationScope } : {}),
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
        targetIdempotencyKey: attempt.targetIdempotencyKey,
        requestDigest: attempt.requestDigest,
        permission,
        status: outcome.status,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        ...(request.activation
          ? {
              activation: {
                ...request.activation,
                acceptedAt: started.toISOString(),
                dispatchOverheadMs: Math.max(
                  0,
                  started.getTime() - new Date(request.activation.activatedAt).getTime(),
                ),
              },
            }
          : {}),
        ...(outcome.targetReceipt ? { targetReceipt: outcome.targetReceipt } : {}),
      },
    };
  }
}

async function delay(milliseconds: number, context: InvocationContext): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    throwIfCancelled(context);
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  throwIfCancelled(context);
}

function throwIfCancelled(context: InvocationContext): void {
  if (context.signal?.aborted) throw cancellationError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError();
}

function cancellationError(): Error {
  return Object.assign(new Error('UI action execution was cancelled.'), {
    code: 'UI_ACTION_CANCELLED',
  });
}

function relayAbort(
  signal: InvocationContext['signal'],
  controller: AbortController,
): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  if (isEventedAbortSignal(signal)) {
    signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }
  const timer = setInterval(() => {
    if (signal.aborted) abort();
  }, 5);
  timer.unref?.();
  return () => clearInterval(timer);
}

function contextWithoutSignal(context: InvocationContext): InvocationContext {
  const { signal: _signal, ...rest } = context;
  return rest;
}

function uiActionRootIdentity(
  context: InvocationContext,
  receiptId: string,
): {
  executionId: string;
  lineage: NonNullable<InvocationContext['lineage']>;
} {
  const executionId = context.executionId ?? receiptId;
  return {
    executionId,
    lineage: context.lineage ?? { rootExecutionId: executionId, depth: 0 },
  };
}

function uiActionExecutionContext(
  context: InvocationContext,
  attempt: UiActionJournalAttempt,
  signal: AbortSignal,
): InvocationContext {
  return {
    ...context,
    executionId: attempt.executionId,
    lineage: attempt.lineage,
    signal,
    metadata: {
      ...(context.metadata ?? {}),
      trustedExecutionBoundary: 'ui_action',
      uiActionReceiptId: attempt.receiptId,
      uiActionTargetIdempotencyKey: attempt.targetIdempotencyKey,
    },
  };
}

function bindTargetReceipt(
  receipt: RuntimeExecutionReceipt,
  context: InvocationContext,
): RuntimeExecutionReceipt {
  const parentExecutionId = context.executionId;
  if (!parentExecutionId) return receipt;
  const lineage = {
    rootExecutionId: context.lineage?.rootExecutionId ?? parentExecutionId,
    parentExecutionId,
    depth: (context.lineage?.depth ?? 0) + 1,
  };
  if (
    receipt.lineage.rootExecutionId === lineage.rootExecutionId &&
    receipt.lineage.parentExecutionId === lineage.parentExecutionId &&
    receipt.lineage.depth === lineage.depth
  ) {
    return receipt;
  }
  return { ...receipt, lineage };
}

function actionFailureOutcome(
  error: unknown,
  context: InvocationContext,
  leaseFailure: Error | undefined,
): UiActionOutcome {
  if (leaseFailure) return leaseLossOutcome(leaseFailure);
  const code = errorCode(error);
  if (
    context.signal?.aborted ||
    code === 'UI_ACTION_CANCELLED' ||
    code === 'ABORT_ERR' ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return cancelledOutcome();
  }
  return {
    status: 'failed',
    error: runtimeError(
      error,
      code ?? 'ui_action_execution_failed',
      'UI action execution failed.',
    ),
  };
}

function cancelledOutcome(): UiActionOutcome {
  return {
    status: 'cancelled',
    error: {
      code: 'ui_action_cancelled',
      message: 'UI action execution was cancelled.',
    },
  };
}

function leaseLossOutcome(error: Error): UiActionOutcome {
  return {
    status: 'failed',
    error: {
      code: 'ui_action_lease_lost',
      message: error.message,
    },
  };
}

function leaseLossError(error: unknown): Error {
  return Object.assign(
    runtimeErrorObject(error, 'UI action idempotency lease was lost during execution'),
    { code: 'UI_ACTION_LEASE_LOST' },
  );
}

function runtimeError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): RuntimeError {
  return {
    code: errorCode(error) ?? fallbackCode,
    message: error instanceof Error && error.message ? error.message : fallbackMessage,
  };
}

function runtimeErrorObject(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function isEventedAbortSignal(
  signal: NonNullable<InvocationContext['signal']>,
): signal is NonNullable<InvocationContext['signal']> & {
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
} {
  const candidate = signal as {
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };
  return (
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

function replayedResult(result: UiActionResult): UiActionResult {
  return {
    ...result,
    receipt: { ...result.receipt, replayed: true },
  };
}

function actionJournalKey(receiptId: string): string {
  return createHash('sha256').update(`ui-action-journal\0${receiptId}`).digest('hex');
}

export function actionTargetIdempotencyKey(
  actionKey: string,
  scope: UiActionToolInput['scope'],
  context: InvocationContext,
): string {
  return createHash('sha256')
    .update(`${stateScopeKey(context, scope)}\0${actionKey}`)
    .digest('hex');
}

export function actionIdempotencyKey(
  renderId: string,
  actionId: string,
  version: string,
  scope: string,
  key: string,
): string {
  return createHash('sha256')
    .update(`${renderId}\0${actionId}\0${version}\0${scope}\0${key}`)
    .digest('hex');
}

export function actionRequestDigest(request: UiActionExecutionRequest): string {
  return createHash('sha256')
    .update(stableStringify({
      renderId: request.renderId,
      actionId: request.action.id,
      actionVersion: request.action.version,
      target: request.action.target,
      input: request.input,
      scope: request.scope,
    }))
    .digest('hex');
}
