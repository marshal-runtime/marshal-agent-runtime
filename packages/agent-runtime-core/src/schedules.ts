/** Portable schedule shapes. A harness adapter owns the actual clock and task registration. */
export type RuntimeScheduleTiming =
  | { readonly kind: 'once'; readonly at: string }
  | {
      readonly kind: 'interval';
      readonly everyMs: number;
      readonly startsAt?: string;
      readonly endsAt?: string;
    }
  | {
      readonly kind: 'cron';
      readonly expression: string;
      readonly timezone?: string;
      readonly startsAt?: string;
      readonly endsAt?: string;
    };

/** Adapter-owned task kind and JSON input. It never contains an executable closure. */
export interface RuntimeScheduledTask<TInput = unknown> {
  readonly kind: string;
  readonly input?: TInput;
}

export type RuntimeScheduleState =
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Normalized shape adapters should return from schedule effect operations. */
export interface RuntimeScheduleSnapshot<TInput = unknown> {
  readonly scheduleId: string;
  readonly state: RuntimeScheduleState;
  readonly timing: RuntimeScheduleTiming;
  readonly task: RuntimeScheduledTask<TInput>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type RuntimeScheduleOperation =
  | 'create'
  | 'get'
  | 'list'
  | 'update'
  | 'pause'
  | 'resume'
  | 'cancel';

/** Fixed effect kinds used by detachable adapters that implement scheduling. */
export const RUNTIME_SCHEDULE_EFFECT_KINDS = {
  create: 'runtime.schedule.create',
  get: 'runtime.schedule.get',
  list: 'runtime.schedule.list',
  update: 'runtime.schedule.update',
  pause: 'runtime.schedule.pause',
  resume: 'runtime.schedule.resume',
  cancel: 'runtime.schedule.cancel',
} as const satisfies Readonly<Record<RuntimeScheduleOperation, string>>;
