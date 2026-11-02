import { createHash } from 'node:crypto';
import type {
  RuntimeExecutionCorrelation,
  RuntimeExecutionCorrelationName,
  RuntimeReceiptCorrelationContext,
} from './contracts.js';

export const RUNTIME_CORRELATION_MAX_COUNT = 3;
export const RUNTIME_CORRELATION_MAX_RAW_STRING_LENGTH = 512;
export const RUNTIME_CORRELATION_MAX_SOURCE_LENGTH = 16_384;

const correlationContexts = new WeakMap<
  object,
  readonly RuntimeExecutionCorrelation[]
>();

export function createRuntimeExecutionCorrelation(
  name: RuntimeExecutionCorrelationName,
  value: string | number,
): RuntimeExecutionCorrelation {
  const authority = name === 'mcpRequestId'
    ? 'transport-correlation'
    : 'untrusted-correlation';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${name} correlation must be a safe integer.`);
    }
    return Object.freeze({ name, authority, type: 'number', value });
  }
  if (value.length <= RUNTIME_CORRELATION_MAX_RAW_STRING_LENGTH) {
    return Object.freeze({ name, authority, type: 'string', value });
  }
  if (value.length > RUNTIME_CORRELATION_MAX_SOURCE_LENGTH) {
    throw new RangeError(
      `${name} correlation must be at most ${RUNTIME_CORRELATION_MAX_SOURCE_LENGTH} characters.`,
    );
  }
  return Object.freeze({
    name,
    authority,
    type: 'sha256',
    algorithm: 'sha256',
    digest: createHash('sha256')
      .update(`marshal-runtime:correlation:${name}:v1\0`, 'utf8')
      .update(value, 'utf8')
      .digest('hex'),
    originalType: 'string',
    length: value.length,
  });
}

export function createRuntimeReceiptCorrelationContext(
  correlations: readonly RuntimeExecutionCorrelation[],
): RuntimeReceiptCorrelationContext | undefined {
  const normalized = normalizeRuntimeExecutionCorrelations(correlations);
  if (!normalized) return undefined;
  const context = Object.freeze({});
  correlationContexts.set(context, normalized);
  return context as RuntimeReceiptCorrelationContext;
}

export function normalizeRuntimeExecutionCorrelations(
  value: unknown,
): readonly RuntimeExecutionCorrelation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > RUNTIME_CORRELATION_MAX_COUNT) {
    throw new TypeError(
      `Receipt correlations must contain 1 through ${RUNTIME_CORRELATION_MAX_COUNT} records.`,
    );
  }
  const names = new Set<RuntimeExecutionCorrelationName>();
  const normalized = value.map((entry, index) =>
    normalizeCorrelation(entry, `correlations[${index}]`));
  for (const correlation of normalized) {
    if (names.has(correlation.name)) {
      throw new TypeError(`Receipt correlations contain duplicate ${correlation.name}.`);
    }
    names.add(correlation.name);
  }
  return Object.freeze(normalized);
}

export function resolveRuntimeReceiptCorrelations(
  context: RuntimeReceiptCorrelationContext | undefined,
): readonly RuntimeExecutionCorrelation[] | undefined {
  if (!context || typeof context !== 'object') return undefined;
  return correlationContexts.get(context);
}

function normalizeCorrelation(
  value: unknown,
  label: string,
): RuntimeExecutionCorrelation {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  const name = correlationName(value.name, `${label}.name`);
  const authority = name === 'mcpRequestId'
    ? 'transport-correlation'
    : 'untrusted-correlation';
  if (value.authority !== authority) {
    throw new TypeError(`${label}.authority is invalid for ${name}.`);
  }
  if (value.type === 'number') {
    assertExactKeys(value, ['name', 'authority', 'type', 'value'], label);
    if (typeof value.value !== 'number' || !Number.isSafeInteger(value.value)) {
      throw new TypeError(`${label}.value must be a safe integer.`);
    }
    return Object.freeze({ name, authority, type: 'number', value: value.value });
  }
  if (value.type === 'string') {
    assertExactKeys(value, ['name', 'authority', 'type', 'value'], label);
    if (
      typeof value.value !== 'string' ||
      value.value.length > RUNTIME_CORRELATION_MAX_RAW_STRING_LENGTH
    ) {
      throw new TypeError(
        `${label}.value must be a string of at most ${RUNTIME_CORRELATION_MAX_RAW_STRING_LENGTH} characters.`,
      );
    }
    return Object.freeze({ name, authority, type: 'string', value: value.value });
  }
  if (value.type === 'sha256') {
    assertExactKeys(
      value,
      ['name', 'authority', 'type', 'algorithm', 'digest', 'originalType', 'length'],
      label,
    );
    if (
      value.algorithm !== 'sha256' ||
      value.originalType !== 'string' ||
      typeof value.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.length !== 'number' ||
      !Number.isSafeInteger(value.length) ||
      value.length <= RUNTIME_CORRELATION_MAX_RAW_STRING_LENGTH ||
      value.length > RUNTIME_CORRELATION_MAX_SOURCE_LENGTH
    ) {
      throw new TypeError(`${label} is not a valid SHA-256 correlation record.`);
    }
    return Object.freeze({
      name,
      authority,
      type: 'sha256',
      algorithm: 'sha256',
      digest: value.digest,
      originalType: 'string',
      length: value.length,
    });
  }
  throw new TypeError(`${label}.type is invalid.`);
}

function correlationName(
  value: unknown,
  label: string,
): RuntimeExecutionCorrelationName {
  if (
    value === 'mcpRequestId' ||
    value === 'codexToolUseId' ||
    value === 'callerRequestId'
  ) {
    return value;
  }
  throw new TypeError(`${label} is invalid.`);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw new TypeError(`${label} contains undeclared properties.`);
  }
  if (keys.some((key) => !(key in value))) {
    throw new TypeError(`${label} is missing required properties.`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
