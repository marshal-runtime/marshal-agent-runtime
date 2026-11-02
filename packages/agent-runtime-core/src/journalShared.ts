import {
  freezeJson,
  type RuntimeEventEnvelope,
  type RuntimeEventInput,
  type RuntimeEventMap,
  type RuntimeJsonValue,
} from './events.js';
import { cloneRuntimeJson } from './json.js';

export const MAX_TEXT_LENGTH = 1_024;
export const MAX_PATH_LENGTH = 4_096;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_ENTRIES = 10_000;
export const MAX_JSON_STRING_LENGTH = 65_536;
export const MAX_READ_LIMIT = 10_000;

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function assertText(
  value: string,
  name: string,
  maximum = MAX_TEXT_LENGTH,
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new TypeError(
      `${name} must be a non-empty string of at most ${maximum} characters.`,
    );
  }
}

export function assertPosition(
  value: number,
  name: string,
  allowZero: boolean,
): void {
  if (
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    !Number.isSafeInteger(value)
  ) {
    throw new RangeError(`${name} has an invalid position.`);
  }
}

export function validateJson(
  value: RuntimeJsonValue,
  depth: number,
  state: { entries: number },
  seen: Set<object>,
): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new RangeError('Runtime event payload exceeds maximum depth.');
  }
  if (++state.entries > MAX_JSON_ENTRIES) {
    throw new RangeError('Runtime event payload exceeds maximum size.');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Runtime event payload numbers must be finite.');
  }
  if (typeof value === 'string' && value.length > MAX_JSON_STRING_LENGTH) {
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
      if (key.length > MAX_TEXT_LENGTH) {
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

export function validateEvent(
  event: RuntimeEventInput<RuntimeEventMap>,
): void {
  const allowed = new Set(['streamId', 'eventId', 'position', 'type', 'occurredAt', 'payload']);
  for (const key of Reflect.ownKeys(event as object)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError('Runtime event input contains unexpected properties.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(event as object, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError('Runtime event input must not contain accessors.');
    }
  }
  assertText(event.streamId, 'streamId');
  assertText(event.eventId, 'eventId');
  assertText(event.type, 'type');
  assertText(event.occurredAt, 'occurredAt');
  if (event.position !== undefined) {
    assertPosition(event.position, 'Runtime event', false);
  }
  validateJson(event.payload, 0, { entries: 0 }, new Set());
}

export function stableJson(value: RuntimeJsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(
            (value as Readonly<Record<string, RuntimeJsonValue>>)[key]!,
          )}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameEvent(
  existing: RuntimeEventEnvelope,
  input: RuntimeEventInput<RuntimeEventMap>,
): boolean {
  return (
    existing.streamId === input.streamId &&
    existing.eventId === input.eventId &&
    existing.type === input.type &&
    existing.occurredAt === input.occurredAt &&
    stableJson(existing.payload) === stableJson(input.payload) &&
    (input.position === undefined || input.position === existing.position)
  );
}

export function createEnvelope<
  TMap extends RuntimeEventMap,
  TType extends keyof TMap & string,
>(
  input: RuntimeEventInput<TMap, TType>,
  position: number,
): RuntimeEventEnvelope<TMap, TType> {
  const payload = cloneRuntimeJson(input.payload as RuntimeJsonValue);
  freezeJson(payload);
  return Object.freeze({ ...input, payload, position }) as RuntimeEventEnvelope<TMap, TType>;
}

export function validateRead(
  streamId: string,
  afterPosition: number,
  limit: number,
  throughPosition?: number,
): void {
  assertText(streamId, 'streamId');
  assertPosition(afterPosition, 'Runtime event read cursor', true);
  if (
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > MAX_READ_LIMIT
  ) {
    throw new RangeError(
      `Runtime event read limit must be between 1 and ${MAX_READ_LIMIT}.`,
    );
  }
  if (throughPosition !== undefined) {
    assertPosition(
      throughPosition,
      'Runtime event read upper bound',
      true,
    );
  }
}

export function createExclusiveQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
