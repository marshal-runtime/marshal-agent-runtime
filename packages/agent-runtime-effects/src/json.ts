import { createHash } from 'node:crypto';
import type { RuntimeScope } from '@marshal/agent-runtime-core';

export function cloneJson<T>(value: T, label: string, maxBytes: number): T {
  const serialized = stringifyJson(value, label);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) {
    throw codedError('VALUE_TOO_LARGE', `${label} exceeds ${maxBytes} bytes.`);
  }
  return JSON.parse(serialized) as T;
}

export function stringifyJson(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(`${label} must be JSON-serializable.`);
    }
    return serialized;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw codedError(
      'NOT_SERIALIZABLE',
      `${label} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function storageKey(parts: unknown): string {
  return createHash('sha256').update(stableJson(parts)).digest('hex');
}

export function sameScope(
  left: RuntimeScope | undefined,
  right: RuntimeScope | undefined,
): boolean {
  return stableJson(left ?? {}) === stableJson(right ?? {});
}

export function requireKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw codedError(
      'INVALID_IDEMPOTENCY_KEY',
      `${label} must be 1-256 URL-safe identifier characters.`,
    );
  }
  return value;
}

export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
