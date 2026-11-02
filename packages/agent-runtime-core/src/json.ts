import type { RuntimeJsonValue } from './events.js';

const MAX_RUNTIME_EVENT_JSON_DEPTH = 32;
const MAX_RUNTIME_EVENT_JSON_ENTRIES = 10_000;

export function cloneRuntimeJson(value: RuntimeJsonValue): RuntimeJsonValue {
  return cloneRuntimeJsonValue(value, 0, { entries: 0 }, new Set());
}

function cloneRuntimeJsonValue(
  value: RuntimeJsonValue,
  depth: number,
  state: { entries: number },
  seen: Set<object>,
): RuntimeJsonValue {
  if (depth > MAX_RUNTIME_EVENT_JSON_DEPTH) {
    throw new RangeError('Runtime event payload exceeds maximum depth.');
  }
  if (++state.entries > MAX_RUNTIME_EVENT_JSON_ENTRIES) {
    throw new RangeError('Runtime event payload exceeds maximum size.');
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Runtime event payload numbers must be finite.');
    }
    return value;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Runtime event payload must not contain symbol properties.');
  }
  if (seen.has(value)) {
    throw new TypeError('Runtime event payload must be acyclic JSON.');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_RUNTIME_EVENT_JSON_ENTRIES) {
      throw new RangeError('Runtime event payload array is too large.');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        throw new TypeError('Runtime event arrays must contain only indexed values.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('Runtime event payload must not contain accessors.');
      }
    }
    const result: RuntimeJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) {
        throw new TypeError('Runtime event payload arrays must not contain sparse holes.');
      }
      result[index] = cloneRuntimeJsonValue(
        descriptor.value as RuntimeJsonValue,
        depth + 1,
        state,
        seen,
      );
    }
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Runtime event payload must contain plain JSON objects.');
  }
  const result: Record<string, RuntimeJsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new TypeError('Runtime event payload must not contain symbol properties.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError('Runtime event payload must not contain accessors.');
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneRuntimeJsonValue(
        descriptor.value as RuntimeJsonValue,
        depth + 1,
        state,
        seen,
      ),
      writable: true,
    });
  }
  seen.delete(value);
  return result;
}
