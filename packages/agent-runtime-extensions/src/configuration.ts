import type {
  RuntimeExtensionConfiguration,
  RuntimeExtensionJsonValue,
  RuntimeExtensionConfigurationSchema,
} from './contracts.js';

const MAX_CONFIGURATION_DEPTH = 16;
const MAX_CONFIGURATION_NODES = 4_096;
const MAX_CONFIGURATION_KEYS = 1_024;
const MAX_CONFIGURATION_STRING_LENGTH = 1_048_576;

export function normalizeRuntimeExtensionConfiguration(
  value: unknown,
  label = 'Runtime extension configuration',
): RuntimeExtensionConfiguration {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  const state = { nodes: 0 };
  return normalizeObject(value, label, 0, state);
}

export function resolveRuntimeExtensionConfiguration(
  defaults: RuntimeExtensionConfiguration | undefined,
  configured: RuntimeExtensionConfiguration | undefined,
): RuntimeExtensionConfiguration {
  return normalizeRuntimeExtensionConfiguration({
    ...(defaults ?? {}),
    ...(configured ?? {}),
  });
}

export function validateRuntimeExtensionConfiguration(
  configuration: RuntimeExtensionConfiguration,
  schema: RuntimeExtensionConfigurationSchema | undefined,
): void {
  if (!schema) return;
  validateValue(configuration, schema, 'Runtime extension configuration');
}

function validateValue(
  value: unknown,
  schema: unknown,
  label: string,
): void {
  if (!isRecord(schema)) return;
  const type = schema.type;
  if (typeof type === 'string' && !matchesSchemaType(value, type)) {
    throw new TypeError(`${label} must be a ${type}.`);
  }
  if (Array.isArray(schema.required) && isRecord(value)) {
    for (const key of schema.required) {
      if (typeof key === 'string' && !(key in value)) {
        throw new TypeError(`${label}.${key} is required.`);
      }
    }
  }
  if (!isRecord(value)) return;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties?.[key];
    if (propertySchema === undefined) {
      if (schema.additionalProperties === false) {
        throw new TypeError(`${label}.${key} is not allowed.`);
      }
      continue;
    }
    validateValue(item, propertySchema, `${label}.${key}`);
  }
}

function matchesSchemaType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function normalizeObject(
  value: Record<string, unknown>,
  label: string,
  depth: number,
  state: { nodes: number },
): Readonly<Record<string, RuntimeExtensionJsonValue>> {
  assertDepth(depth, label);
  const entries = Object.entries(value);
  if (entries.length > MAX_CONFIGURATION_KEYS) {
    throw new TypeError(`${label} contains too many keys.`);
  }
  const normalized: Record<string, RuntimeExtensionJsonValue> = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 256) {
      throw new TypeError(`${label} contains an invalid key.`);
    }
    normalized[key] = normalizeValue(item, `${label}.${key}`, depth + 1, state);
  }
  return Object.freeze(normalized);
}

function normalizeValue(
  value: unknown,
  label: string,
  depth: number,
  state: { nodes: number },
): RuntimeExtensionJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_CONFIGURATION_NODES) {
    throw new TypeError(`${label} exceeds the configuration size limit.`);
  }
  assertDepth(depth, label);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_CONFIGURATION_STRING_LENGTH) {
      throw new TypeError(`${label} exceeds the string length limit.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONFIGURATION_KEYS) {
      throw new TypeError(`${label} contains too many items.`);
    }
    return Object.freeze(
      value.map((item, index) => normalizeValue(item, `${label}[${index}]`, depth + 1, state)),
    );
  }
  if (isRecord(value)) return normalizeObject(value, label, depth, state);
  throw new TypeError(`${label} must contain only JSON values.`);
}

function assertDepth(depth: number, label: string): void {
  if (depth > MAX_CONFIGURATION_DEPTH) {
    throw new TypeError(`${label} exceeds the configuration depth limit.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
