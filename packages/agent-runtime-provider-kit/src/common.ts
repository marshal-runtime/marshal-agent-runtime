import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationContext,
} from '@marshal/agent-runtime-core';

export const PROTOCOL_VERSION = '1.0.0' as const;

export interface ProviderReceipt {
  readonly id: string;
  readonly providerId: string;
  readonly capability: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly inputDigest: string;
  readonly completedAt: string;
}

export function assertRecord(value: unknown, label = 'input'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string {
  const value = record[key];
  if (typeof value !== 'string' || (!options.allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${key} must be a non-empty string.`);
  }
  const maxLength = options.maxLength ?? 100_000;
  if (value.length > maxLength) {
    throw new RangeError(`${key} exceeds the ${maxLength} character limit.`);
  }
  return value;
}

export function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maxLength = 100_000,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new TypeError(`${key} must be a string no longer than ${maxLength} characters.`);
  }
  return value;
}

export function optionalBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
  return value;
}

export function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

export function digestInput(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function receipt(
  providerId: string,
  capability: string,
  input: unknown,
  context: InvocationContext,
): ProviderReceipt {
  return {
    id: randomUUID(),
    providerId,
    capability,
    scope: Object.fromEntries(
      Object.entries(context.scope ?? {}).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string'),
    ),
    inputDigest: digestInput(input),
    completedAt: new Date().toISOString(),
  };
}

export function result<T>(
  output: T,
  providerId: string,
  capability: string,
  input: unknown,
  context: InvocationContext,
  extras: Omit<CapabilityInvocationResult<T>, 'output' | 'receipt'> = {},
): CapabilityInvocationResult<T> {
  return {
    output,
    ...extras,
    receipt: receipt(providerId, capability, input, context),
  };
}

export function createProvider(
  id: string,
  descriptors: readonly CapabilityDescriptor[],
  invoke: CapabilityProvider['invoke'],
): CapabilityProvider {
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    id,
    version: '0.1.0',
    list: () => descriptors,
    get: (name) => byName.get(name),
    invoke(name, input, context) {
      if (!byName.has(name)) throw new Error(`Unknown capability: ${name}`);
      return invoke(name, input, context);
    },
  };
}

export function assertLogicalPath(value: string, label = 'path'): string {
  if (value.includes('\0') || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new Error(`${label} must be a relative logical path.`);
  }
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} contains an invalid path segment.`);
  }
  return segments.join(path.sep);
}

export function hashedScopeSegment(kind: string, value: string): string {
  const digest = createHash('sha256').update(`${kind}\0${value}`).digest('hex').slice(0, 24);
  return `${kind}-${digest}`;
}

export function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
