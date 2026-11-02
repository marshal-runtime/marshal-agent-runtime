import type { JsonSchema } from './contracts.js';

const MAX_ISSUES = 20;
const MAX_ISSUE_LENGTH = 240;

export class RuntimeSchemaValidationError extends Error {
  readonly code = 'capability_output_schema_mismatch';

  constructor(readonly issues: readonly string[]) {
    super(`Capability output did not match its declared schema: ${issues.join('; ')}`);
    this.name = 'RuntimeSchemaValidationError';
  }
}

/** Validate a JSON-compatible value against the bounded schema subset used by runtime capabilities. */
export function assertRuntimeOutputSchema(
  value: unknown,
  schema: JsonSchema,
  label = 'result.output',
): void {
  const issues: string[] = [];
  validate(value, schema, schema, label, issues);
  if (issues.length > 0) throw new RuntimeSchemaValidationError(issues);
}

function validate(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  issues: string[],
): void {
  if (issues.length >= MAX_ISSUES) return;
  const resolved = resolveReference(schema, root, path, issues);
  if (!resolved) return;

  if (Array.isArray(resolved.allOf)) {
    for (const candidate of resolved.allOf) {
      if (isSchema(candidate)) validate(value, candidate, root, path, issues);
    }
  }
  if (Array.isArray(resolved.anyOf)) {
    const matches = resolved.anyOf.some((candidate) => candidateMatches(value, candidate, root, path));
    if (!matches) addIssue(issues, `${path} must match at least one declared schema`);
    return;
  }
  if (Array.isArray(resolved.oneOf)) {
    const matches = resolved.oneOf.filter((candidate) => candidateMatches(value, candidate, root, path)).length;
    if (matches !== 1) addIssue(issues, `${path} must match exactly one declared schema`);
    return;
  }
  if ('const' in resolved && !same(value, resolved.const)) {
    addIssue(issues, `${path} must equal the declared constant`);
  }
  if (Array.isArray(resolved.enum) && !resolved.enum.some((item) => same(value, item))) {
    addIssue(issues, `${path} is not an allowed value`);
  }

  const declaredTypes = typeof resolved.type === 'string'
    ? [resolved.type]
    : Array.isArray(resolved.type)
      ? resolved.type.filter((type): type is string => typeof type === 'string')
      : [];
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => matchesType(value, type))) {
    addIssue(issues, `${path} must be ${declaredTypes.join(' or ')}`);
    return;
  }
  if (typeof value === 'string') {
    if (typeof resolved.minLength === 'number' && value.length < resolved.minLength) addIssue(issues, `${path} is too short`);
    if (typeof resolved.maxLength === 'number' && value.length > resolved.maxLength) addIssue(issues, `${path} is too long`);
    if (typeof resolved.pattern === 'string' && !new RegExp(resolved.pattern).test(value)) addIssue(issues, `${path} has an invalid format`);
  }
  if (typeof value === 'number') {
    if (typeof resolved.minimum === 'number' && value < resolved.minimum) addIssue(issues, `${path} is below minimum`);
    if (typeof resolved.maximum === 'number' && value > resolved.maximum) addIssue(issues, `${path} exceeds maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof resolved.minItems === 'number' && value.length < resolved.minItems) addIssue(issues, `${path} has too few items`);
    if (typeof resolved.maxItems === 'number' && value.length > resolved.maxItems) addIssue(issues, `${path} has too many items`);
    if (resolved.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      addIssue(issues, `${path} must contain unique items`);
    }
    if (isSchema(resolved.items)) {
      value.forEach((item, index) => validate(item, resolved.items as JsonSchema, root, `${path}[${index}]`, issues));
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(resolved.properties) ? resolved.properties : {};
    const required = Array.isArray(resolved.required) ? resolved.required : [];
    if (typeof resolved.maxProperties === 'number' && Object.keys(value).length > resolved.maxProperties) {
      addIssue(issues, `${path} has too many properties`);
    }
    for (const key of required) {
      if (typeof key === 'string' && value[key] === undefined) addIssue(issues, `${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      // JSON object serialization omits undefined-valued optional properties.
      if (child === undefined) continue;
      const childSchema = properties[key];
      if (isSchema(childSchema)) validate(child, childSchema, root, `${path}.${key}`, issues);
      else if (resolved.additionalProperties === false) addIssue(issues, `${path}.${key} is not allowed`);
      else if (isSchema(resolved.additionalProperties)) {
        validate(child, resolved.additionalProperties, root, `${path}.${key}`, issues);
      }
    }
  }
}

function candidateMatches(
  value: unknown,
  candidate: unknown,
  root: JsonSchema,
  path: string,
): boolean {
  if (!isSchema(candidate)) return false;
  const nested: string[] = [];
  validate(value, candidate, root, path, nested);
  return nested.length === 0;
}

function resolveReference(
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  issues: string[],
): JsonSchema | undefined {
  if (typeof schema.$ref !== 'string') return schema;
  if (!schema.$ref.startsWith('#/')) {
    addIssue(issues, `${path} uses an unsupported non-local schema reference`);
    return undefined;
  }
  let current: unknown = root;
  for (const raw of schema.$ref.slice(2).split('/')) {
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isRecord(current) || !(segment in current)) {
      addIssue(issues, `${path} references an unknown schema definition`);
      return undefined;
    }
    current = current[segment];
  }
  if (!isSchema(current)) {
    addIssue(issues, `${path} references an invalid schema definition`);
    return undefined;
  }
  return current;
}

function addIssue(issues: string[], issue: string): void {
  if (issues.length >= MAX_ISSUES) return;
  issues.push(issue.slice(0, MAX_ISSUE_LENGTH));
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
