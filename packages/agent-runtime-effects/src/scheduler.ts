import { randomUUID } from 'node:crypto';
import {
  RUNTIME_SCHEDULE_EFFECT_KINDS,
  type InvocationContext,
  type RuntimeEffectHandler,
  type RuntimeEffectHandlerResult,
  type RuntimeEffectRequest,
  type RuntimeScheduleOperation,
  type RuntimeScheduleSnapshot,
  type RuntimeScheduleState,
  type RuntimeScheduleTiming,
  type RuntimeScheduledTask,
  type RuntimeScope,
} from '@marshal/agent-runtime-core';
import { assertTimeZone, nextCronTime } from './cron.js';
import { sameScope } from './json.js';
import type { ScheduleStore, StoredSchedule } from './scheduleStore.js';

export const AGENT_WAKE_TASK_KIND = 'agent.wake';
export const SCHEDULER_EFFECT_HANDLER_ID = 'marshal.runtime.scheduler';

const MS_PER_SECOND = 1_000;
const MS_PER_DAY = 86_400_000;
const DEFAULT_TICK_MS = 5 * MS_PER_SECOND;
const DEFAULT_CLAIM_LEASE_MS = 60 * MS_PER_SECOND;
const DEFAULT_RUNNER_TIMEOUT_MS = 30 * MS_PER_SECOND;
const DEFAULT_RETRY_BACKOFF_MS = 15 * MS_PER_SECOND;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MIN_INTERVAL_MS = 60 * MS_PER_SECOND;
const DEFAULT_MAX_LIVE_PER_OWNER = 100;
const DEFAULT_MAX_FUTURE_MS = 366 * MS_PER_DAY;
const DEFAULT_PAST_TOLERANCE_MS = 60 * MS_PER_SECOND;
const DEFAULT_RETENTION_MS = 7 * MS_PER_DAY;
const DEFAULT_MAX_CONCURRENT_FIRES = 4;
const DEFAULT_LIST_LIMIT = 50;
const MAX_WAKE_MESSAGE_CHARACTERS = 16_384;
const MAX_TARGET_ID_CHARACTERS = 256;
const SCHEDULE_NOT_FOUND = 'SCHEDULE_NOT_FOUND';
const INVALID_SCHEDULE = 'INVALID_SCHEDULE';
const SCHEDULE_LIMIT = 'SCHEDULE_LIMIT_REACHED';
const RUNNER_TIMEOUT = 'RUNNER_TIMEOUT';

const LIVE_STATES: ReadonlySet<RuntimeScheduleState> = new Set(['active', 'paused']);
const TERMINAL_STATES: ReadonlySet<RuntimeScheduleState> = new Set([
  'completed',
  'cancelled',
  'failed',
]);

export interface RuntimeScheduleFire {
  readonly fireId: string;
  readonly scheduleId: string;
  readonly scheduledFor: string;
  readonly attempt: number;
  readonly principalId: string;
  readonly scope?: RuntimeScope;
  readonly timing: RuntimeScheduleTiming;
  readonly task: RuntimeScheduledTask;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Performs one fire. Throwing marks the attempt failed; the service retries it. */
export type RuntimeScheduleTaskRunner = (fire: RuntimeScheduleFire) => Promise<void> | void;

export interface AgentWakeTarget {
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface AgentWakeRequest {
  readonly target: AgentWakeTarget;
  readonly message: string;
  readonly fire: RuntimeScheduleFire;
}

/** The host-owned way to resume an agent or session; each host supplies its own. */
export interface RuntimeWakePort {
  wake(request: AgentWakeRequest): Promise<void> | void;
}

export type RuntimeScheduleEvent =
  | { readonly type: 'fired'; readonly fire: RuntimeScheduleFire }
  | { readonly type: 'retry'; readonly fire: RuntimeScheduleFire; readonly error: string }
  | { readonly type: 'failed'; readonly fire: RuntimeScheduleFire; readonly error: string };

export interface RuntimeScheduleTickResult {
  readonly fired: number;
  readonly failed: number;
}

export interface RuntimeScheduleServiceOptions {
  readonly store: ScheduleStore;
  readonly runners?: Readonly<Record<string, RuntimeScheduleTaskRunner>>;
  /** Task kinds accepted at create time; defaults to the runner kinds. A write-only process lists kinds that another process runs. */
  readonly acceptedTaskKinds?: readonly string[];
  readonly ownerId?: string;
  readonly tickMs?: number;
  readonly claimLeaseMs?: number;
  readonly runnerTimeoutMs?: number;
  readonly retryBackoffMs?: number;
  readonly maxAttempts?: number;
  readonly minIntervalMs?: number;
  readonly maxLivePerOwner?: number;
  readonly maxFutureMs?: number;
  readonly pastToleranceMs?: number;
  readonly retentionMs?: number;
  readonly maxConcurrentFires?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly onEvent?: (event: RuntimeScheduleEvent) => void;
}

/** Builds the `agent.wake` runner: it validates the task input and hands the wake to the host port. */
export function createAgentWakeRunner(port: RuntimeWakePort): RuntimeScheduleTaskRunner {
  return async (fire) => {
    const { target, message } = parseAgentWakeInput(fire.task.input);
    await port.wake({ target, message, fire });
  };
}

export function parseAgentWakeInput(input: unknown): { target: AgentWakeTarget; message: string } {
  const record = asRecord(input);
  const message = record.message;
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('agent.wake input.message is required.');
  }
  if (message.length > MAX_WAKE_MESSAGE_CHARACTERS) {
    throw new TypeError(`agent.wake input.message must not exceed ${MAX_WAKE_MESSAGE_CHARACTERS} characters.`);
  }
  const target = asRecord(record.target);
  const sessionId = optionalId(target.sessionId, 'target.sessionId');
  const agentId = optionalId(target.agentId, 'target.agentId');
  if (!sessionId && !agentId) {
    throw new TypeError('agent.wake input.target needs a sessionId or an agentId.');
  }
  return { target: { ...(sessionId ? { sessionId } : {}), ...(agentId ? { agentId } : {}) }, message };
}

/** Durable clock for `runtime.schedules.*`: stores schedules and fires them through task runners. */
export class RuntimeScheduleService implements RuntimeEffectHandler {
  readonly id = SCHEDULER_EFFECT_HANDLER_ID;
  readonly version = '1.0.0';
  readonly supportedKinds: readonly string[] = Object.values(RUNTIME_SCHEDULE_EFFECT_KINDS);

  private readonly store: ScheduleStore;
  private readonly runners: Readonly<Record<string, RuntimeScheduleTaskRunner>>;
  private readonly acceptedTaskKinds: ReadonlySet<string>;
  private readonly ownerId: string;
  private readonly tickMs: number;
  private readonly claimLeaseMs: number;
  private readonly runnerTimeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly minIntervalMs: number;
  private readonly maxLivePerOwner: number;
  private readonly maxFutureMs: number;
  private readonly pastToleranceMs: number;
  private readonly retentionMs: number;
  private readonly maxConcurrentFires: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly onEvent?: (event: RuntimeScheduleEvent) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private inFlight?: Promise<unknown>;

  constructor(options: RuntimeScheduleServiceOptions) {
    this.store = options.store;
    this.runners = options.runners ?? {};
    this.acceptedTaskKinds = new Set(options.acceptedTaskKinds ?? Object.keys(this.runners));
    this.ownerId = options.ownerId ?? `scheduler-${randomUUID()}`;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.runnerTimeoutMs = options.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxLivePerOwner = options.maxLivePerOwner ?? DEFAULT_MAX_LIVE_PER_OWNER;
    this.maxFutureMs = options.maxFutureMs ?? DEFAULT_MAX_FUTURE_MS;
    this.pastToleranceMs = options.pastToleranceMs ?? DEFAULT_PAST_TOLERANCE_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxConcurrentFires = options.maxConcurrentFires ?? DEFAULT_MAX_CONCURRENT_FIRES;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `sch-${randomUUID()}`);
    this.onEvent = options.onEvent;
    if (this.claimLeaseMs <= this.runnerTimeoutMs) {
      throw new RangeError('claimLeaseMs must be longer than runnerTimeoutMs.');
    }
  }

  async handle<TInput = unknown, TOutput = unknown>(
    request: RuntimeEffectRequest<TInput>,
    context: InvocationContext,
  ): Promise<RuntimeEffectHandlerResult<TOutput>> {
    const operation = operationForKind(request.kind);
    if (!operation) {
      return { status: 'unsupported', reason: `Not a schedule effect: ${request.kind}`, supportedKinds: this.supportedKinds };
    }
    try {
      return {
        status: 'success',
        output: (await this.dispatch(operation, asRecord(request.input), context)) as TOutput,
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        status: 'failed',
        error: {
          code: typeof code === 'string' ? code : INVALID_SCHEDULE,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /** Starts the loop. The first tick runs at once, so schedules that fell due while no host ran fire immediately. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (): void => {
      this.inFlight = this.tick()
        .catch(() => undefined)
        .finally(() => {
          if (this.running) this.timer = setTimeout(loop, this.tickMs);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Fires every schedule due at `at`. Safe to call from several processes sharing one store. */
  async tick(at: Date = this.now()): Promise<RuntimeScheduleTickResult> {
    await this.prune(at);
    const due = (await this.store.list())
      .filter((record) => isDue(record, at))
      .sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''));
    const outcomes: boolean[] = [];
    const queue = [...due];
    const workers = Array.from({ length: Math.min(this.maxConcurrentFires, queue.length) }, async () => {
      for (let record = queue.shift(); record; record = queue.shift()) {
        const outcome = await this.fireOne(record.scheduleId, at);
        if (outcome !== undefined) outcomes.push(outcome);
      }
    });
    await Promise.all(workers);
    return { fired: outcomes.filter(Boolean).length, failed: outcomes.filter((ok) => !ok).length };
  }

  private async fireOne(scheduleId: string, at: Date): Promise<boolean | undefined> {
    const claimed = await this.store.transaction((tx) => {
      const current = tx.get(scheduleId);
      if (!current || !isDue(current, at)) return undefined;
      const fireId = this.createId();
      const next: StoredSchedule = {
        ...current,
        claim: { owner: this.ownerId, fireId, expiresAt: iso(at.getTime() + this.claimLeaseMs) },
      };
      tx.put(next);
      return { record: current, fireId };
    });
    if (!claimed) return undefined;
    const { record, fireId } = claimed;
    const fire: RuntimeScheduleFire = {
      fireId,
      scheduleId: record.scheduleId,
      scheduledFor: record.nextRunAt ?? iso(at.getTime()),
      attempt: record.attempts + 1,
      principalId: record.principalId,
      ...(record.scope ? { scope: record.scope } : {}),
      timing: record.timing,
      task: record.task,
      ...(record.metadata ? { metadata: record.metadata } : {}),
    };
    let failure: string | undefined;
    try {
      await this.runWithTimeout(fire);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await this.finalize(fire, failure);
    return failure === undefined;
  }

  private async runWithTimeout(fire: RuntimeScheduleFire): Promise<void> {
    const runner = this.runners[fire.task.kind];
    if (!runner) throw new Error(`No runner is registered for task kind "${fire.task.kind}" on this host.`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`Runner exceeded ${this.runnerTimeoutMs} ms.`), { code: RUNNER_TIMEOUT })),
        this.runnerTimeoutMs,
      );
    });
    try {
      await Promise.race([Promise.resolve(runner(fire)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async finalize(fire: RuntimeScheduleFire, failure: string | undefined): Promise<void> {
    const finishedAt = this.now();
    const event = await this.store.transaction((tx): RuntimeScheduleEvent | undefined => {
      const current = tx.get(fire.scheduleId);
      if (!current || current.claim?.fireId !== fire.fireId) return undefined;
      const released: StoredSchedule = { ...current, claim: undefined, updatedAt: iso(finishedAt.getTime()) };
      const live = current.state === 'active';
      if (failure === undefined) {
        const next = live ? computeNext(current, finishedAt) : undefined;
        tx.put({
          ...released,
          state: live ? (next ? 'active' : 'completed') : current.state,
          nextRunAt: live ? next : current.nextRunAt,
          lastRunAt: iso(finishedAt.getTime()),
          fireCount: current.fireCount + 1,
          attempts: 0,
          lastError: undefined,
        });
        return { type: 'fired', fire };
      }
      const attempts = current.attempts + 1;
      if (live && attempts < this.maxAttempts) {
        tx.put({
          ...released,
          attempts,
          lastError: failure,
          nextRunAt: iso(finishedAt.getTime() + this.retryBackoffMs * 2 ** (attempts - 1)),
        });
        return { type: 'retry', fire, error: failure };
      }
      const next = live && current.timing.kind !== 'once' ? computeNext(current, finishedAt) : undefined;
      tx.put({
        ...released,
        state: live ? (current.timing.kind === 'once' ? 'failed' : next ? 'active' : 'completed') : current.state,
        nextRunAt: live ? next : current.nextRunAt,
        attempts: 0,
        lastError: failure,
      });
      return { type: 'failed', fire, error: failure };
    });
    if (event) this.onEvent?.(event);
  }

  private async prune(at: Date): Promise<void> {
    const cutoff = at.getTime() - this.retentionMs;
    const expired = (await this.store.list()).filter(
      (record) => TERMINAL_STATES.has(record.state) && Date.parse(record.updatedAt) < cutoff,
    );
    if (expired.length === 0) return;
    await this.store.transaction((tx) => expired.forEach((record) => tx.delete(record.scheduleId)));
  }

  private dispatch(
    operation: RuntimeScheduleOperation,
    input: Record<string, unknown>,
    context: InvocationContext,
  ): Promise<unknown> {
    switch (operation) {
      case 'create':
        return this.create(input, context);
      case 'get':
        return this.get(requireId(input.scheduleId), context);
      case 'list':
        return this.listFor(input, context);
      case 'update':
        return this.update(input, context);
      case 'pause':
        return this.setState(requireId(input.scheduleId), context, 'paused');
      case 'resume':
        return this.setState(requireId(input.scheduleId), context, 'active');
      case 'cancel':
        return this.setState(requireId(input.scheduleId), context, 'cancelled');
    }
  }

  private async create(input: Record<string, unknown>, context: InvocationContext): Promise<unknown> {
    const timing = input.timing as RuntimeScheduleTiming;
    const task = input.task as RuntimeScheduledTask;
    const now = this.now();
    this.validateTask(task);
    this.validateTiming(timing, now);
    const metadata = optionalRecord(input.metadata);
    return this.store.transaction((tx) => {
      const owned = tx.list().filter((record) => owns(record, context) && LIVE_STATES.has(record.state));
      if (owned.length >= this.maxLivePerOwner) {
        throw Object.assign(new Error(`At most ${this.maxLivePerOwner} live schedules per principal and scope.`), {
          code: SCHEDULE_LIMIT,
        });
      }
      const createdAt = iso(now.getTime());
      const draft: StoredSchedule = {
        scheduleId: this.createId(),
        principalId: context.principal.id,
        ...(context.scope ? { scope: context.scope } : {}),
        state: 'active',
        timing,
        task,
        ...(metadata ? { metadata } : {}),
        createdAt,
        updatedAt: createdAt,
        fireCount: 0,
        attempts: 0,
      };
      const nextRunAt = firstRunAt(draft, now);
      if (!nextRunAt) throw invalid('The schedule has no run time before its end.');
      const record = { ...draft, nextRunAt };
      tx.put(record);
      return toSnapshot(record);
    });
  }

  private async get(scheduleId: string, context: InvocationContext): Promise<unknown> {
    const record = await this.store.get(scheduleId);
    if (!record || !owns(record, context)) throw notFound(scheduleId);
    return toSnapshot(record);
  }

  private async listFor(input: Record<string, unknown>, context: InvocationContext): Promise<unknown> {
    const state = input.state as RuntimeScheduleState | undefined;
    const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_LIST_LIMIT;
    const offset = typeof input.cursor === 'string' ? Number.parseInt(input.cursor, 10) || 0 : 0;
    const matching = (await this.store.list())
      .filter((record) => owns(record, context) && (!state || record.state === state))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.scheduleId.localeCompare(right.scheduleId));
    const page = matching.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      schedules: page.map(toSnapshot),
      ...(nextOffset < matching.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  private async update(input: Record<string, unknown>, context: InvocationContext): Promise<unknown> {
    const scheduleId = requireId(input.scheduleId);
    const now = this.now();
    if (input.task !== undefined) this.validateTask(input.task as RuntimeScheduledTask);
    if (input.timing !== undefined) this.validateTiming(input.timing as RuntimeScheduleTiming, now);
    return this.store.transaction((tx) => {
      const current = tx.get(scheduleId);
      if (!current || !owns(current, context)) throw notFound(scheduleId);
      if (TERMINAL_STATES.has(current.state)) throw invalid(`A ${current.state} schedule cannot be updated.`);
      const timing = (input.timing as RuntimeScheduleTiming | undefined) ?? current.timing;
      const metadata = input.metadata === undefined ? current.metadata : optionalRecord(input.metadata);
      const changed: StoredSchedule = {
        ...current,
        timing,
        task: (input.task as RuntimeScheduledTask | undefined) ?? current.task,
        ...(metadata ? { metadata } : {}),
        updatedAt: iso(now.getTime()),
        attempts: input.timing === undefined ? current.attempts : 0,
      };
      const nextRunAt = input.timing === undefined ? current.nextRunAt : firstRunAt(changed, now);
      if (input.timing !== undefined && !nextRunAt) throw invalid('The schedule has no run time before its end.');
      const record = { ...changed, nextRunAt };
      tx.put(record);
      return toSnapshot(record);
    });
  }

  private async setState(
    scheduleId: string,
    context: InvocationContext,
    state: Extract<RuntimeScheduleState, 'active' | 'paused' | 'cancelled'>,
  ): Promise<unknown> {
    const now = this.now();
    return this.store.transaction((tx) => {
      const current = tx.get(scheduleId);
      if (!current || !owns(current, context)) throw notFound(scheduleId);
      if (current.state === state || TERMINAL_STATES.has(current.state)) return toSnapshot(current);
      const resumed = state === 'active';
      const nextRunAt = resumed ? resumeRunAt(current, now) : current.nextRunAt;
      if (resumed && !nextRunAt) throw invalid('The schedule has no run time before its end.');
      const record: StoredSchedule = {
        ...current,
        state,
        nextRunAt: state === 'cancelled' ? undefined : nextRunAt,
        updatedAt: iso(now.getTime()),
      };
      tx.put(record);
      return toSnapshot(record);
    });
  }

  private validateTask(task: RuntimeScheduledTask): void {
    if (!this.acceptedTaskKinds.has(task.kind)) {
      throw invalid(`Task kind "${task.kind}" is not available on this host. Available: ${[...this.acceptedTaskKinds].join(', ') || 'none'}.`);
    }
    if (task.kind === AGENT_WAKE_TASK_KIND) parseAgentWakeInput(task.input);
  }

  private validateTiming(timing: RuntimeScheduleTiming, now: Date): void {
    if (timing.kind === 'once') {
      const at = Date.parse(timing.at);
      if (at < now.getTime() - this.pastToleranceMs) throw invalid('timing.at is in the past.');
      if (at > now.getTime() + this.maxFutureMs) throw invalid('timing.at is too far in the future.');
    } else if (timing.kind === 'interval') {
      if (timing.everyMs < this.minIntervalMs) {
        throw invalid(`timing.everyMs must be at least ${this.minIntervalMs}.`);
      }
    } else {
      nextCronTime(timing.expression, now, timing.timezone);
      if (timing.timezone) assertTimeZone(timing.timezone);
    }
    if (timing.kind !== 'once' && timing.endsAt && Date.parse(timing.endsAt) <= now.getTime()) {
      throw invalid('timing.endsAt is already past.');
    }
  }
}

function operationForKind(kind: string): RuntimeScheduleOperation | undefined {
  return (Object.entries(RUNTIME_SCHEDULE_EFFECT_KINDS) as [RuntimeScheduleOperation, string][]).find(
    ([, value]) => value === kind,
  )?.[0];
}

function isDue(record: StoredSchedule, at: Date): boolean {
  return (
    record.state === 'active' &&
    record.nextRunAt !== undefined &&
    Date.parse(record.nextRunAt) <= at.getTime() &&
    (!record.claim || Date.parse(record.claim.expiresAt) <= at.getTime())
  );
}

function owns(record: StoredSchedule, context: InvocationContext): boolean {
  return record.principalId === context.principal.id && sameScope(record.scope, context.scope);
}

function firstRunAt(record: StoredSchedule, now: Date): string | undefined {
  if (record.timing.kind === 'once') return record.timing.at;
  return computeNext(record, now);
}

function resumeRunAt(record: StoredSchedule, now: Date): string | undefined {
  return record.timing.kind === 'once' ? record.timing.at : computeNext(record, now);
}

/** The first slot after `after`; a recurring schedule skips slots missed while nothing ran. */
function computeNext(record: StoredSchedule, after: Date): string | undefined {
  const { timing } = record;
  if (timing.kind === 'once') return undefined;
  const startsAt = timing.startsAt ? Date.parse(timing.startsAt) : undefined;
  const from = startsAt === undefined ? after.getTime() : Math.max(after.getTime(), startsAt - 1);
  const next =
    timing.kind === 'interval'
      ? nextInterval(timing, record.createdAt, from)
      : nextCronTime(timing.expression, new Date(from), timing.timezone)?.getTime();
  if (next === undefined) return undefined;
  if (timing.endsAt && next > Date.parse(timing.endsAt)) return undefined;
  return iso(next);
}

function nextInterval(
  timing: Extract<RuntimeScheduleTiming, { kind: 'interval' }>,
  createdAt: string,
  after: number,
): number {
  const base = Date.parse(timing.startsAt ?? createdAt);
  return base + (Math.floor((after - base) / timing.everyMs) + 1) * timing.everyMs;
}

function toSnapshot(record: StoredSchedule): RuntimeScheduleSnapshot {
  return {
    scheduleId: record.scheduleId,
    state: record.state,
    timing: record.timing,
    task: record.task,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.nextRunAt ? { nextRunAt: record.nextRunAt } : {}),
    ...(record.lastRunAt ? { lastRunAt: record.lastRunAt } : {}),
    metadata: {
      ...(record.metadata ?? {}),
      fireCount: record.fireCount,
      ...(record.lastError ? { lastError: record.lastError } : {}),
    },
  };
}

function iso(millis: number): string {
  return new Date(millis).toISOString();
}

function invalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: INVALID_SCHEDULE });
}

function notFound(scheduleId: string): Error & { code: string } {
  return Object.assign(new Error(`Schedule "${scheduleId}" was not found.`), { code: SCHEDULE_NOT_FOUND });
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid('scheduleId is required.');
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TARGET_ID_CHARACTERS) {
    throw new TypeError(`agent.wake input.${label} must be a non-empty string of at most ${MAX_TARGET_ID_CHARACTERS} characters.`);
  }
  return value;
}

/** Routes each effect kind to the first handler that supports it; the schedule service and a harness handler can share one dispatcher. */
export function composeEffectHandlers(
  handlers: readonly RuntimeEffectHandler[],
  id = 'marshal.runtime.composed-effects',
): RuntimeEffectHandler | undefined {
  if (handlers.length === 0) return undefined;
  if (handlers.length === 1) return handlers[0];
  const owner = async (kind: string, context: InvocationContext): Promise<RuntimeEffectHandler | undefined> => {
    for (const handler of handlers) {
      const listed = !handler.supportedKinds || handler.supportedKinds.includes(kind);
      if (listed && (!handler.supports || (await handler.supports(kind, context)))) return handler;
    }
    return undefined;
  };
  const kinds = handlers.map((handler) => handler.supportedKinds);
  return {
    id,
    ...(kinds.every((list) => list) ? { supportedKinds: [...new Set(kinds.flatMap((list) => list ?? []))] } : {}),
    supports: async (kind, context) => (await owner(kind, context)) !== undefined,
    async handle(request, context) {
      const handler = await owner(request.kind, context);
      if (!handler) return { status: 'unsupported', reason: `No adapter handler supports effect "${request.kind}".` };
      return handler.handle(request, context);
    },
  };
}
