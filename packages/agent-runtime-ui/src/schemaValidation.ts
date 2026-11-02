import type { JsonSchema } from '@marshal/agent-runtime-core';

export class UiSchemaValidationError extends Error {
  readonly code = 'ui_schema_validation_failed';

  constructor(readonly issues: readonly string[]) {
    super(`UI schema validation failed: ${issues.join('; ')}`);
    this.name = 'UiSchemaValidationError';
  }
}

/** Dependency-free JSON Schema subset used at the UI trust boundary. */
export function assertUiSchema(value: unknown, schema: JsonSchema, label = '$'): void {
  const issues: string[] = [];
  validate(value, schema, label, issues);
  if (issues.length > 0) throw new UiSchemaValidationError(issues);
}

function validate(value: unknown, schema: JsonSchema, path: string, issues: string[]): void {
  if ('const' in schema && !same(value, schema.const)) issues.push(`${path} must equal the declared constant`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => same(value, item))) {
    issues.push(`${path} is not an allowed value`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      const nested: string[] = [];
      if (isSchema(candidate)) validate(value, candidate, path, nested);
      return nested.length === 0;
    }).length;
    if (matches !== 1) issues.push(`${path} must match exactly one schema`);
    return;
  }

  const type = schema.type;
  if (typeof type === 'string' && !matchesType(value, type)) {
    issues.push(`${path} must be ${type}`);
    return;
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push(`${path} is too short`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push(`${path} is too long`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) issues.push(`${path} has an invalid format`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${path} is below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${path} exceeds maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push(`${path} has too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) issues.push(`${path} has too many items`);
    if (isSchema(schema.items)) value.forEach((item, index) => validate(item, schema.items as JsonSchema, `${path}[${index}]`, issues));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) if (typeof key === 'string' && !(key in value)) issues.push(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (isSchema(childSchema)) validate(child, childSchema, `${path}.${key}`, issues);
      else if (schema.additionalProperties === false) issues.push(`${path}.${key} is not allowed`);
      else if (isSchema(schema.additionalProperties)) validate(child, schema.additionalProperties, `${path}.${key}`, issues);
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isRecord(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
