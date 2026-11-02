import {
  type RuntimeServiceBinding,
  type RuntimeServiceBindingHandle,
  type RuntimeServiceContainer,
  type RuntimeServiceDecorator,
  type RuntimeServiceToken,
} from './services.js';

export type RuntimePresetValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimePresetValue[]
  | RuntimePresetObject;
export type RuntimePresetObject = { readonly [key: string]: RuntimePresetValue };
export type RuntimePresetEnvironmentParser =
  | 'string'
  | 'boolean'
  | 'integer'
  | 'number'
  | 'json';

export interface RuntimePresetEnvironmentMapping {
  readonly variable: string;
  readonly path: string;
  readonly parser: RuntimePresetEnvironmentParser;
}

export interface RuntimePresetServiceEntry<T = unknown> {
  readonly id: string;
  readonly order?: number;
  readonly kind?: 'bind' | 'bindMany' | 'replace' | 'decorate';
  readonly operation?: 'bind' | 'bindMany' | 'replace' | 'decorate';
  readonly token: RuntimeServiceToken<T>;
  readonly binding?: RuntimeServiceBinding<T>;
  readonly decorator?: RuntimeServiceDecorator<T>;
}

export interface RuntimeCompositionPreset {
  readonly id: string;
  readonly extends?: readonly string[];
  readonly configuration?: RuntimePresetObject;
  readonly services?: readonly RuntimePresetServiceEntry[];
  readonly environment?: readonly RuntimePresetEnvironmentMapping[];
}

export interface RuntimeCompositionPresetRequest {
  readonly presets?: readonly string[];
  readonly defaults?: RuntimePresetObject;
  readonly environment?: Readonly<Record<string, string>>;
  readonly overrides?: RuntimePresetObject;
}

export interface ResolvedRuntimeCompositionPreset {
  readonly configuration: RuntimePresetObject;
  readonly services: readonly RuntimePresetServiceEntry[];
}

const MAX_ID = 128;
const MAX_DEPTH = 32;
const MAX_ENTRIES = 10_000;
const MAX_INPUT = 1_000_000;

function fail(message: string): never {
  throw new TypeError(`Invalid runtime composition preset: ${message}`);
}

function boundedText(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID) {
    fail(`${label} must be non-empty and at most ${MAX_ID} characters`);
  }
  return value;
}

function copyFreeze(
  value: RuntimePresetValue,
  depth = 0,
  state = { entries: 0, seen: new Set<object>() },
): RuntimePresetValue {
  if (++state.entries > MAX_ENTRIES || depth > MAX_DEPTH) fail('configuration is too large or deeply nested');
  if (typeof value === 'number' && !Number.isFinite(value)) fail('configuration contains a non-finite number');
  if (typeof value === 'string' && value.length > MAX_INPUT) fail('configuration contains an oversized string');
  if (Array.isArray(value)) {
    if (value.length > MAX_ENTRIES) fail('configuration array is too large');
    if (state.seen.has(value)) fail('configuration must be acyclic');
    state.seen.add(value);
    const result: RuntimePresetValue[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        fail('configuration arrays must contain only indexed values');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) fail('configuration must not contain accessors');
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) fail('configuration arrays must not contain sparse holes');
      result[index] = copyFreeze(descriptor.value as RuntimePresetValue, depth + 1, state);
    }
    state.seen.delete(value);
    return Object.freeze(result);
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('configuration must contain plain JSON objects');
    }
    if (state.seen.has(value)) fail('configuration must be acyclic');
    state.seen.add(value);
    const result: Record<string, RuntimePresetValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('configuration must not contain symbol properties');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) fail('configuration must not contain accessors');
      const item = descriptor.value as RuntimePresetValue;
      boundedText(key, 'configuration key');
      result[key] = copyFreeze(item, depth + 1, state);
    }
    state.seen.delete(value);
    return Object.freeze(result);
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) {
    fail('configuration must contain JSON-compatible values');
  }
  return value;
}

function merge(base: RuntimePresetObject, incoming: RuntimePresetObject): RuntimePresetObject {
  const result: Record<string, RuntimePresetValue> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const prior = result[key];
    result[key] =
      prior !== null &&
      typeof prior === 'object' &&
      !Array.isArray(prior) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
        ? merge(prior as RuntimePresetObject, value as RuntimePresetObject)
        : value;
  }
  return result;
}

function pathParts(path: string): string[] {
  boundedText(path, 'path');
  const parts = path.split('.');
  if (parts.some((part) => !part || part === '__proto__' || part === 'constructor' || part === 'prototype')) {
    fail(`invalid path "${path}"`);
  }
  return parts;
}

function setPath(root: RuntimePresetObject, path: string, value: RuntimePresetValue): RuntimePresetObject {
  const parts = pathParts(path);
  const mutable = (input: RuntimePresetValue): RuntimePresetValue => {
    if (Array.isArray(input)) return input.map(mutable);
    if (input !== null && typeof input === 'object') {
      const output: Record<string, RuntimePresetValue> = {};
      for (const [key, child] of Object.entries(input)) output[key] = mutable(child);
      return output;
    }
    return input;
  };
  const copied = mutable(root);
  const mutableResult = copied as RuntimePresetObject;
  let cursor: Record<string, RuntimePresetValue> = mutableResult as Record<string, RuntimePresetValue>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const existing = cursor[part];
    if (existing !== undefined && (existing === null || typeof existing !== 'object' || Array.isArray(existing))) {
      fail(`path "${path}" traverses a non-object`);
    }
    if (existing === undefined) cursor[part] = {};
    cursor = cursor[part] as Record<string, RuntimePresetValue>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return mutableResult;
}

function parseEnvironment(raw: string, parser: RuntimePresetEnvironmentParser): RuntimePresetValue {
  if (typeof raw !== 'string') fail('environment values must be strings');
  switch (parser) {
    case 'string': return raw;
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      break;
    case 'integer': {
      if (!/^[+-]?\d+$/.test(raw)) break;
      const n = Number(raw);
      if (Number.isSafeInteger(n)) return n;
      break;
    }
    case 'number': {
      const n = Number(raw);
      if (raw.trim() !== '' && Number.isFinite(n)) return n;
      break;
    }
    case 'json':
      try {
        return copyFreeze(JSON.parse(raw));
      } catch {
        break;
      }
  }
  fail(`cannot parse environment value as ${parser}`);
}

function validateEntry<T>(
  entry: RuntimePresetServiceEntry<T>,
): RuntimePresetServiceEntry<T> {
  boundedText(entry.id, 'service entry id');
  if (!entry.token || typeof entry.token !== 'symbol') fail(`service entry "${entry.id}" has an invalid token`);
  const kind = entry.kind ?? entry.operation;
  if (!kind || (entry.kind !== undefined && entry.operation !== undefined && entry.kind !== entry.operation)) {
    fail(`service entry "${entry.id}" has no valid operation`);
  }
  switch (kind) {
    case 'bind':
    case 'bindMany':
    case 'replace':
    case 'decorate':
      break;
    default:
      fail(`service entry "${entry.id}" has an invalid operation`);
  }
  if (kind === 'decorate') {
    if (typeof entry.decorator !== 'function' || entry.binding !== undefined) fail(`invalid decorator entry "${entry.id}"`);
  } else if (typeof entry.binding !== 'object' || entry.binding === null || entry.decorator !== undefined) {
    fail(`invalid binding entry "${entry.id}"`);
  }
  if (entry.order !== undefined && !Number.isFinite(entry.order)) fail(`entry "${entry.id}" has a non-finite order`);
  return Object.freeze({ ...entry, kind, operation: kind });
}

export function createRuntimePresetBind<T>(
  id: string, token: RuntimeServiceToken<T>, binding: RuntimeServiceBinding<T>, order?: number,
): RuntimePresetServiceEntry<T> {
  return validateEntry({ id, token, binding, kind: 'bind', operation: 'bind', ...(order === undefined ? {} : { order }) });
}
export function createRuntimePresetBindMany<T>(
  id: string, token: RuntimeServiceToken<T>, binding: RuntimeServiceBinding<T>, order?: number,
): RuntimePresetServiceEntry<T> {
  return validateEntry({ id, token, binding, kind: 'bindMany', operation: 'bindMany', ...(order === undefined ? {} : { order }) });
}
export function createRuntimePresetReplace<T>(
  id: string, token: RuntimeServiceToken<T>, binding: RuntimeServiceBinding<T>, order?: number,
): RuntimePresetServiceEntry<T> {
  return validateEntry({ id, token, binding, kind: 'replace', operation: 'replace', ...(order === undefined ? {} : { order }) });
}
export function createRuntimePresetDecorator<T>(
  id: string, token: RuntimeServiceToken<T>, decorator: RuntimeServiceDecorator<T>, order?: number,
): RuntimePresetServiceEntry<T> {
  return validateEntry({ id, token, decorator, kind: 'decorate', operation: 'decorate', ...(order === undefined ? {} : { order }) });
}

function inheritedPresets(
  id: string,
  catalog: Readonly<Record<string, RuntimeCompositionPreset>>,
  selectedIds: ReadonlySet<string>,
  inherited: RuntimeCompositionPreset[],
  inheritedIds: Set<string>,
  visiting: Set<string>,
  expandedIds: Set<string>,
  depth = 0,
): void {
  boundedText(id, 'preset reference');
  if (depth > MAX_DEPTH) fail('inheritance exceeds maximum depth');
  const preset = Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : undefined;
  if (!preset) fail(`unknown preset "${id}"`);
  if (visiting.has(id)) fail(`inheritance cycle at "${id}"`);
  if (expandedIds.has(id)) return;
  visiting.add(id);
  if ((preset.extends?.length ?? 0) > MAX_ENTRIES) fail(`preset "${id}" has too many parents`);
  for (const parent of preset.extends ?? []) {
    inheritedPresets(
      parent,
      catalog,
      selectedIds,
      inherited,
      inheritedIds,
      visiting,
      expandedIds,
      depth + 1,
    );
    if (!selectedIds.has(parent) && !inheritedIds.has(parent)) {
      inheritedIds.add(parent);
      inherited.push(catalog[parent]!);
    }
  }
  visiting.delete(id);
  expandedIds.add(id);
}

export function resolveRuntimeCompositionPreset(
  catalog: Readonly<Record<string, RuntimeCompositionPreset>>,
  request: RuntimeCompositionPresetRequest = {},
): ResolvedRuntimeCompositionPreset {
  const selected = request.presets ?? [];
  if (selected.length > MAX_ENTRIES) fail('too many selected presets');
  const selectedIds = new Set<string>();
  const selectedPresets: RuntimeCompositionPreset[] = [];
  for (const id of selected) {
    boundedText(id, 'preset reference');
    if (selectedIds.has(id)) continue;
    const preset = Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : undefined;
    if (!preset) fail(`unknown preset "${id}"`);
    selectedIds.add(id);
    selectedPresets.push(preset);
  }
  const inherited: RuntimeCompositionPreset[] = [];
  const inheritedIds = new Set<string>();
  const expandedIds = new Set<string>();
  for (const id of selectedIds) {
    inheritedPresets(
      id,
      catalog,
      selectedIds,
      inherited,
      inheritedIds,
      new Set(),
      expandedIds,
    );
  }
  const chain = [...inherited, ...selectedPresets];
  if (chain.length > MAX_ENTRIES) fail('resolved preset chain is too large');
  let configuration = copyFreeze(request.defaults ?? {}) as RuntimePresetObject;
  const services: RuntimePresetServiceEntry[] = [];
  const environmentMappings: RuntimePresetEnvironmentMapping[] = [];
  const mappings = new Set<string>();
  const ids = new Set<string>();
  const primaries = new Set<symbol>();
  for (const preset of chain) {
    boundedText(preset.id, 'preset id');
    configuration = merge(configuration, copyFreeze(preset.configuration ?? {}) as RuntimePresetObject);
    for (const mapping of preset.environment ?? []) {
      boundedText(mapping.variable, 'environment variable');
      pathParts(mapping.path);
      if (!['string', 'boolean', 'integer', 'number', 'json'].includes(mapping.parser)) {
        fail(`environment mapping "${mapping.variable}" has an invalid parser`);
      }
      if (mappings.has(mapping.variable)) fail(`duplicate environment mapping "${mapping.variable}"`);
      mappings.add(mapping.variable);
      environmentMappings.push(mapping);
      if (environmentMappings.length > MAX_ENTRIES) fail('too many environment mappings');
    }
    for (const entry of preset.services ?? []) {
      const checked = validateEntry(entry);
      if (ids.has(checked.id)) fail(`duplicate service entry id "${checked.id}"`);
      const operation = checked.kind!;
      if ((operation === 'replace' || operation === 'decorate') && !primaries.has(checked.token)) {
        fail(`service entry "${checked.id}" targets an unresolved primary`);
      }
      if (operation === 'bind' || operation === 'replace') primaries.add(checked.token);
      ids.add(checked.id); services.push(checked);
      if (services.length > MAX_ENTRIES) fail('too many service entries');
    }
  }
  for (const mapping of environmentMappings) {
    const raw = request.environment?.[mapping.variable];
    if (raw === undefined) continue;
    if (raw.length > MAX_INPUT) {
      fail(`environment value "${mapping.variable}" exceeds size limit`);
    }
    configuration = setPath(
      configuration,
      mapping.path,
      parseEnvironment(raw, mapping.parser),
    );
  }
  configuration = merge(configuration, copyFreeze(request.overrides ?? {}) as RuntimePresetObject);
  if (JSON.stringify(configuration).length > MAX_INPUT) fail('input exceeds size limit');
  return Object.freeze({ configuration: copyFreeze(configuration) as RuntimePresetObject, services: Object.freeze(services) });
}

export async function applyRuntimeCompositionPreset(
  container: RuntimeServiceContainer,
  resolved: ResolvedRuntimeCompositionPreset,
): Promise<RuntimeServiceBindingHandle> {
  const handles: RuntimeServiceBindingHandle[] = [];
  try {
    for (const entry of resolved.services) {
      const operation = entry.kind ?? entry.operation;
      let handle: RuntimeServiceBindingHandle;
      switch (operation) {
        case 'decorate':
          handle = await container.decorate(entry.token, entry.decorator!);
          break;
        case 'bind':
          handle = await container.bind(entry.token, entry.binding!);
          break;
        case 'bindMany': {
          const binding = entry.order === undefined
            ? entry.binding!
            : { ...entry.binding!, order: entry.order };
          handle = await container.bindMany(entry.token, binding);
          break;
        }
        case 'replace':
          handle = await container.replace(entry.token, entry.binding!);
          break;
        default:
          fail(`service entry "${entry.id}" has an invalid operation`);
      }
      handles.push(handle);
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const handle of [...handles].reverse()) {
      try {
        await handle.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Failed to apply and roll back a runtime composition preset.',
      );
    }
    throw error;
  }
  let disposed = false;
  return {
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      let first: unknown;
      for (const handle of handles.reverse()) {
        try { await handle.dispose(); } catch (error) { if (first === undefined) first = error; }
      }
      if (first !== undefined) throw first;
    },
  };
}
