import type { JsonValue } from './types.js';

export function cloneJson(value: unknown, label: string): JsonValue {
  if (value === undefined) {
    throw new TypeError(`${label} must be JSON-serializable; received undefined.`);
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      `${label} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (serialized === undefined) {
    throw new TypeError(`${label} must be JSON-serializable.`);
  }

  return JSON.parse(serialized) as JsonValue;
}
