import type { Disposable, MaybePromise } from './contracts.js';
import { cloneRuntimeJson } from './json.js';

export type RuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeJsonValue[]
  | { readonly [key: string]: RuntimeJsonValue };

export type RuntimeEventMap = Record<string, RuntimeJsonValue>;

export interface RuntimeEventEnvelope<
  TMap extends RuntimeEventMap = RuntimeEventMap,
  TType extends keyof TMap & string = keyof TMap & string,
> {
  readonly streamId: string;
  readonly eventId: string;
  readonly position: number;
  readonly type: TType;
  readonly occurredAt: string;
  readonly payload: TMap[TType];
}

export type RuntimeEventInput<
  TMap extends RuntimeEventMap,
  TType extends keyof TMap & string = keyof TMap & string,
> = Omit<RuntimeEventEnvelope<TMap, TType>, 'position'> & {
  readonly position?: number;
};

export type RuntimeEventListener<
  TMap extends RuntimeEventMap,
  TType extends keyof TMap & string = keyof TMap & string,
> = (event: RuntimeEventEnvelope<TMap, TType>) => MaybePromise<void>;

export interface RuntimeEventPublisher<
  TMap extends RuntimeEventMap = RuntimeEventMap,
> {
  publish<TType extends keyof TMap & string>(
    event: RuntimeEventInput<TMap, TType>,
  ): Promise<RuntimeEventEnvelope<TMap, TType>>;
}

export interface RuntimeEventBusOptions<TMap extends RuntimeEventMap> {
  readonly journal: import('./journal.js').RuntimeEventJournal<TMap>;
  readonly onListenerError?: (
    error: unknown,
    event: RuntimeEventEnvelope<TMap>,
  ) => MaybePromise<void>;
}

const MAX_RUNTIME_EVENT_TEXT_LENGTH = 1_024;
const MAX_RUNTIME_EVENT_JSON_DEPTH = 32;
const MAX_RUNTIME_EVENT_JSON_ENTRIES = 10_000;
const MAX_RUNTIME_EVENT_JSON_STRING_LENGTH = 65_536;

function assertEventText(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RUNTIME_EVENT_TEXT_LENGTH
  ) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${MAX_RUNTIME_EVENT_TEXT_LENGTH} characters.`,
    );
  }
}

function validateJson(
  value: RuntimeJsonValue,
  depth: number,
  state: { entries: number },
  seen: Set<object>,
): void {
  if (depth > MAX_RUNTIME_EVENT_JSON_DEPTH) {
    throw new RangeError('Runtime event payload exceeds maximum depth.');
  }
  if (++state.entries > MAX_RUNTIME_EVENT_JSON_ENTRIES) {
    throw new RangeError('Runtime event payload exceeds maximum size.');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Runtime event payload numbers must be finite.');
  }
  if (
    typeof value === 'string' &&
    value.length > MAX_RUNTIME_EVENT_JSON_STRING_LENGTH
  ) {
    throw new RangeError('Runtime event payload string is too long.');
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('Runtime event payload must be acyclic JSON.');
    }
    seen.add(value);
    for (const item of value) {
      validateJson(item, depth + 1, state, seen);
    }
    seen.delete(value);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Runtime event payload must contain plain JSON objects.');
    }
    if (seen.has(value)) {
      throw new TypeError('Runtime event payload must be acyclic JSON.');
    }
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (key.length > MAX_RUNTIME_EVENT_TEXT_LENGTH) {
        throw new RangeError('Runtime event payload has an invalid object key.');
      }
      validateJson(item, depth + 1, state, seen);
    }
    seen.delete(value);
    return;
  }
  if (
    value !== null &&
    typeof value !== 'boolean' &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    throw new TypeError('Runtime event payload must contain JSON values.');
  }
}

function validateEventInput(
  event: RuntimeEventInput<RuntimeEventMap>,
): void {
  assertEventText(event.streamId, 'streamId');
  assertEventText(event.eventId, 'eventId');
  assertEventText(event.type, 'type');
  assertEventText(event.occurredAt, 'occurredAt');
  if (
    event.position !== undefined &&
    (!Number.isInteger(event.position) || event.position < 1)
  ) {
    throw new RangeError('Runtime event position must be a positive integer.');
  }
  validateJson(event.payload, 0, { entries: 0 }, new Set());
}

export class RuntimeEventBus<TMap extends RuntimeEventMap = RuntimeEventMap>
  implements RuntimeEventPublisher<TMap>
{
  private readonly listeners = new Map<
    string | '*',
    Set<RuntimeEventListener<TMap>>
  >();

  constructor(private readonly options: RuntimeEventBusOptions<TMap>) {}

  subscribe<TType extends keyof TMap & string>(
    type: TType,
    listener: RuntimeEventListener<TMap, TType>,
  ): Disposable;
  subscribe(type: '*', listener: RuntimeEventListener<TMap>): Disposable;
  subscribe(type: string, listener: RuntimeEventListener<TMap>): Disposable {
    assertEventText(type, 'event subscription type');
    if (typeof listener !== 'function') {
      throw new TypeError('Runtime event listener must be a function.');
    }
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        listeners?.delete(listener);
        if (listeners?.size === 0) this.listeners.delete(type);
      },
    };
  }

  async publish<TType extends keyof TMap & string>(
    input: RuntimeEventInput<TMap, TType>,
  ): Promise<RuntimeEventEnvelope<TMap, TType>> {
    const safeInput = cloneEventInput(input);
    validateEventInput(safeInput as RuntimeEventInput<RuntimeEventMap>);
    let event: RuntimeEventEnvelope<TMap, TType>;
    event = await this.options.journal.append(safeInput);

    const listeners = [
      ...(this.listeners.get(event.type) ?? []),
      ...(this.listeners.get('*') ?? []),
    ];
    await Promise.all(
      listeners.map(async (listener) => {
        try {
          await listener(event);
        } catch (error) {
          try {
            await this.options.onListenerError?.(error, event);
          } catch {
            // Listener error reporting is observational.
          }
        }
      }),
    );
    return event;
  }
}

export const createRuntimeEventBus = <TMap extends RuntimeEventMap>(
  options: RuntimeEventBusOptions<TMap>,
): RuntimeEventBus<TMap> => new RuntimeEventBus(options);

export function freezeJson(value: RuntimeJsonValue): void {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      freezeJson(item);
    }
    Object.freeze(value);
  }
}

function cloneEventInput<
  TMap extends RuntimeEventMap,
  TType extends keyof TMap & string,
>(input: RuntimeEventInput<TMap, TType>): RuntimeEventInput<TMap, TType> {
  const allowed = new Set(['streamId', 'eventId', 'position', 'type', 'occurredAt', 'payload']);
  for (const key of Reflect.ownKeys(input as object)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError('Runtime event input contains unexpected properties.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input as object, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError('Runtime event input must not contain accessors.');
    }
  }

  const source = input as RuntimeEventInput<TMap, TType>;
  const base = {
    streamId: source.streamId,
    eventId: source.eventId,
    type: source.type,
    occurredAt: source.occurredAt,
    payload: cloneRuntimeJson(source.payload) as TMap[TType],
  };
  return source.position === undefined
    ? base
    : { ...base, position: source.position };
}
