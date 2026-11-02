import {
  RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION,
  RUNTIME_EXTENSION_MODULE_FORMAT,
  type RuntimeExtensionManifest,
} from './contracts.js';
import { normalizeRuntimeExtensionConfiguration } from './configuration.js';

const IDENTITY_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9@._+-]+$/;
const WINDOWS_RESERVED_BASENAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function validateRuntimeExtensionManifest(value: unknown): RuntimeExtensionManifest {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    'schemaVersion',
    'identity',
    'displayName',
    'version',
    'entrypoint',
    'moduleFormat', 'installation', 'activationOrder', 'contracts', 'provides', 'dependencies',
    'replacements', 'configuration', 'docs', 'resources', 'examples',
    'appServices', 'appServicesSnippet', 'agentGuidance', 'contributes',
  ].includes(key))) {
    throw new TypeError('Runtime extension manifest must be a strict object.');
  }
  if (value.schemaVersion !== RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError(
      `Runtime extension manifest schemaVersion must be ${RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION}.`,
    );
  }
  const identity = requireRuntimeExtensionIdentity(value.identity);
  const displayName = value.displayName === undefined ? undefined : requireDisplayName(value.displayName);
  const version = requireRuntimeExtensionVersion(value.version);
  const entrypoint = requireRuntimeExtensionEntrypoint(value.entrypoint);
  if (value.moduleFormat !== RUNTIME_EXTENSION_MODULE_FORMAT) {
    throw new TypeError(
      `Runtime extension moduleFormat must be "${RUNTIME_EXTENSION_MODULE_FORMAT}".`,
    );
  }
  const activationOrder = value.activationOrder;
  if (activationOrder !== undefined &&
    (typeof activationOrder !== 'number' || !Number.isInteger(activationOrder) ||
      activationOrder < -1_000_000 || activationOrder > 1_000_000)) {
    throw new TypeError('Runtime extension activationOrder is invalid.');
  }
  const installation = value.installation === undefined
    ? undefined
    : normalizeInstallation(value.installation);
  const configuration = value.configuration === undefined
    ? undefined
    : normalizeConfigurationMetadata(value.configuration);
  const contracts = value.contracts === undefined ? undefined : normalizeContracts(value.contracts);
  const provides = value.provides === undefined ? undefined : normalizeProvides(value.provides);
  const dependencies = value.dependencies === undefined ? undefined : normalizeDependencies(value.dependencies);
  const replacements = value.replacements === undefined ? undefined : normalizeReplacements(value.replacements);
  const docs = value.docs === undefined ? undefined : normalizeMetadataValue(value.docs, 'Runtime extension docs');
  const resources = value.resources === undefined ? undefined : normalizeMetadataValue(value.resources, 'Runtime extension resources');
  const examples = value.examples === undefined ? undefined : normalizeMetadataValue(value.examples, 'Runtime extension examples');
  const appServices = value.appServices === undefined
    ? undefined
    : normalizeMetadataValue(value.appServices, 'Runtime extension AppServices metadata');
  const appServicesSnippet = value.appServicesSnippet === undefined
    ? undefined
    : requireMetadataString(value.appServicesSnippet, 'Runtime extension AppServices snippet');
  const agentGuidance = value.agentGuidance === undefined
    ? undefined
    : normalizeAgentGuidance(value.agentGuidance);
  const contributes = value.contributes === undefined
    ? undefined
    : normalizeContributions(value.contributes);
  return Object.freeze({
    schemaVersion: RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION,
    identity,
    ...(displayName === undefined ? {} : { displayName }),
    version,
    entrypoint,
    moduleFormat: RUNTIME_EXTENSION_MODULE_FORMAT,
    ...(installation ? { installation } : {}),
    ...(activationOrder === undefined ? {} : { activationOrder }),
    ...(configuration ? { configuration } : {}),
    ...(contracts ? { contracts } : {}),
    ...(provides ? { provides } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(replacements ? { replacements } : {}),
    ...(docs !== undefined ? { docs } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(examples !== undefined ? { examples } : {}),
    ...(appServices !== undefined ? { appServices } : {}),
    ...(appServicesSnippet !== undefined ? { appServicesSnippet } : {}),
    ...(agentGuidance ? { agentGuidance } : {}),
    ...(contributes ? { contributes } : {}),
  });
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value !== value.trim() || value !== value.normalize('NFC')) {
    throw new TypeError('Runtime extension displayName is invalid.');
  }
  return value;
}

const AGENT_GUIDANCE_FIELD_LIMITS = Object.freeze({
  purpose: 300,
  when: 300,
  recipe: 700,
  boundaries: 300,
} as const);
const AGENT_GUIDANCE_TOTAL_LIMIT = 1_500;
// Newlines, carriage returns, and tabs are legitimate in multiline guidance;
// every other C0/C1 control character is rejected.
// eslint-disable-next-line no-control-regex
const AGENT_GUIDANCE_FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function normalizeAgentGuidance(
  value: unknown,
): NonNullable<RuntimeExtensionManifest['agentGuidance']> {
  const keys = Object.keys(AGENT_GUIDANCE_FIELD_LIMITS) as ReadonlyArray<
    keyof typeof AGENT_GUIDANCE_FIELD_LIMITS
  >;
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key as never))) {
    throw new TypeError('Runtime extension agentGuidance must be a strict object of purpose/when/recipe/boundaries.');
  }
  const guidance: Record<string, string> = {};
  for (const key of keys) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !field.trim()) {
      throw new TypeError(`Runtime extension agentGuidance ${key} must be a non-empty string.`);
    }
    if (field.length > AGENT_GUIDANCE_FIELD_LIMITS[key]) {
      throw new TypeError(
        `Runtime extension agentGuidance ${key} exceeds ${AGENT_GUIDANCE_FIELD_LIMITS[key]} characters.`,
      );
    }
    if (AGENT_GUIDANCE_FORBIDDEN_CONTROLS.test(field)) {
      throw new TypeError(
        `Runtime extension agentGuidance ${key} contains a forbidden control character.`,
      );
    }
    guidance[key] = field;
  }
  if (Object.keys(guidance).length === 0) {
    throw new TypeError('Runtime extension agentGuidance must declare at least one field.');
  }
  if (JSON.stringify(guidance).length > AGENT_GUIDANCE_TOTAL_LIMIT) {
    throw new TypeError(
      `Runtime extension agentGuidance exceeds ${AGENT_GUIDANCE_TOTAL_LIMIT} serialized characters.`,
    );
  }
  return Object.freeze(guidance);
}

function normalizeInstallation(
  value: unknown,
): NonNullable<RuntimeExtensionManifest['installation']> {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !['script', 'packageManager'].includes(key))) {
    throw new TypeError('Runtime extension installation metadata is invalid.');
  }
  if (
    typeof value.script !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value.script)
  ) {
    throw new TypeError('Runtime extension installation script is invalid.');
  }
  if (
    value.packageManager !== undefined
    && !['npm', 'pnpm', 'yarn', 'bun'].includes(String(value.packageManager))
  ) {
    throw new TypeError('Runtime extension installation packageManager is invalid.');
  }
  return Object.freeze({
    script: value.script,
    ...(value.packageManager === undefined
      ? {}
      : { packageManager: value.packageManager as NonNullable<RuntimeExtensionManifest['installation']>['packageManager'] }),
  });
}

function normalizeMetadataValue(
  value: unknown,
  label: string,
): import('./contracts.js').RuntimeExtensionJsonValue {
  if (!isJsonValue(value)) throw new TypeError(`${label} metadata must be JSON-compatible.`);
  return value;
}

function requireMetadataString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 1_048_576) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function normalizeConfigurationMetadata(value: unknown): RuntimeExtensionManifest['configuration'] {
  if (!isRecord(value) || Object.keys(value).some((key) => !['schema', 'defaults'].includes(key))) {
    throw new TypeError('Runtime extension configuration metadata is invalid.');
  }
  const schema = value.schema === undefined ? undefined : normalizeConfigurationSchema(value.schema);
  const defaults = value.defaults === undefined ? undefined : normalizeRuntimeExtensionConfiguration(value.defaults);
  return Object.freeze({ ...(schema ? { schema } : {}), ...(defaults ? { defaults } : {}) });
}

function normalizeContracts(value: unknown): readonly import('./contracts.js').RuntimeExtensionContract[] {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('Runtime extension contracts are invalid.');
  return Object.freeze(value.map((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) =>
      !['id', 'shape', 'version', 'type', 'docs', 'example', 'resource'].includes(key))
      || typeof item.id !== 'string' || !item.id.trim() || typeof item.version !== 'string'
      || !EXACT_SEMVER_PATTERN.test(item.version) || typeof item.type !== 'string' || !item.type.trim()
      || typeof item.docs !== 'string' || !item.docs.trim()
      || (item.example !== undefined && !isJsonValue(item.example))
      || (item.resource !== undefined && (typeof item.resource !== 'string' || !item.resource.trim()))) {
      throw new TypeError('Runtime extension contract is invalid.');
    }
    if (!['object', 'array', 'string', 'number', 'boolean', 'null'].includes(item.shape as string)) {
      throw new TypeError('Runtime extension contract shape is invalid.');
    }
    return Object.freeze({
      id: item.id,
      shape: item.shape,
      version: item.version,
      type: item.type,
      docs: item.docs,
      ...(item.example === undefined ? {} : { example: item.example }),
      ...(item.resource === undefined ? {} : { resource: item.resource }),
    }) as import('./contracts.js').RuntimeExtensionContract;
  }));
}

function normalizeProvides(value: unknown): NonNullable<RuntimeExtensionManifest['provides']> {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'services')
    || (value.services !== undefined && !Array.isArray(value.services))) {
    throw new TypeError('Runtime extension providers are invalid.');
  }
  const services = value.services?.map((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => !['id', 'version', 'declaration', 'publicMethods'].includes(key))
      || typeof item.id !== 'string' || !item.id.trim() || typeof item.version !== 'string'
      || !EXACT_SEMVER_PATTERN.test(item.version)
      || (item.declaration !== undefined && (typeof item.declaration !== 'string' || item.declaration.length > 1_048_576))
      || !Array.isArray(item.publicMethods)) {
      throw new TypeError('Runtime extension service provider is invalid.');
    }
    const publicMethods = item.publicMethods.map((method) => {
      if (!isRecord(method) || Object.keys(method).some((key) => !['name', 'input', 'output'].includes(key))
        || typeof method.name !== 'string' || !method.name.trim()
        || (method.input !== undefined && typeof method.input !== 'string')
        || (method.output !== undefined && typeof method.output !== 'string')) {
        throw new TypeError('Runtime extension RPC method is invalid.');
      }
      return Object.freeze({
        name: method.name,
        ...(method.input === undefined ? {} : { input: method.input }),
        ...(method.output === undefined ? {} : { output: method.output }),
      });
    });
    return Object.freeze({
      id: item.id,
      version: item.version,
      ...(item.declaration === undefined ? {} : { declaration: item.declaration }),
      publicMethods: Object.freeze(publicMethods),
    });
  });
  return Object.freeze(services === undefined ? {} : { services: Object.freeze(services) });
}

function normalizeDependencies(value: unknown): NonNullable<RuntimeExtensionManifest['dependencies']> {
  if (!isRecord(value) || Object.keys(value).some((key) => !['extensions', 'services'].includes(key))) {
    throw new TypeError('Runtime extension dependencies are invalid.');
  }
  function normalize<TAllowProvider extends boolean>(
    items: unknown,
    allowProvider: TAllowProvider,
  ): readonly (
    TAllowProvider extends true
      ? import('./contracts.js').RuntimeExtensionServiceDependency
      : import('./contracts.js').RuntimeExtensionDependency
  )[] | undefined {
    if (items === undefined) return undefined;
    if (!Array.isArray(items)) throw new TypeError('Runtime extension dependencies are invalid.');
    const normalized = items.map((item) => {
      if (!isRecord(item) || Object.keys(item).some((key) =>
        !['id', 'version', ...(allowProvider ? ['provider'] : [])].includes(key))
        || typeof item.id !== 'string' || !item.id.trim()
        || (item.version !== undefined && (typeof item.version !== 'string' || !EXACT_SEMVER_PATTERN.test(item.version)))
        || (allowProvider && item.provider !== undefined
          && (typeof item.provider !== 'string' || !item.provider.trim()))) {
        throw new TypeError('Runtime extension dependency is invalid.');
      }
      const provider = allowProvider && typeof item.provider === 'string'
        ? item.provider
        : undefined;
      return Object.freeze({
        id: item.id,
        ...(item.version === undefined ? {} : { version: item.version }),
        ...(provider === undefined ? {} : { provider }),
      });
    });
    return Object.freeze(normalized) as readonly (
      TAllowProvider extends true
        ? import('./contracts.js').RuntimeExtensionServiceDependency
        : import('./contracts.js').RuntimeExtensionDependency
    )[];
  }
  const extensions = normalize(value.extensions, false);
  const services = normalize(value.services, true);
  return Object.freeze({ ...(extensions ? { extensions } : {}), ...(services ? { services } : {}) });
}

function normalizeReplacements(value: unknown): readonly import('./contracts.js').RuntimeExtensionReplacement[] {
  if (!Array.isArray(value)) throw new TypeError('Runtime extension replacements are invalid.');
  return Object.freeze(value.map((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => !['id', 'target', 'version'].includes(key))
      || typeof item.id !== 'string' || !item.id.trim() || typeof item.target !== 'string' || !item.target.trim()
      || (item.version !== undefined && (typeof item.version !== 'string' || !EXACT_SEMVER_PATTERN.test(item.version)))) {
      throw new TypeError('Runtime extension replacement is invalid.');
    }
    return Object.freeze({
      id: item.id,
      target: item.target,
      ...(item.version === undefined ? {} : { version: item.version }),
    });
  }));
}

function normalizeConfigurationSchema(value: unknown): import('./contracts.js').RuntimeExtensionConfigurationSchema {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !['type', 'properties', 'required', 'additionalProperties'].includes(key))
    || value.type !== 'object'
    || (value.properties !== undefined && !isJsonValue(value.properties))
    || (value.required !== undefined && (!Array.isArray(value.required)
      || value.required.some((item) => typeof item !== 'string' || !item.trim())))
    || (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean')) {
    throw new TypeError('Runtime extension configuration schema is invalid.');
  }
  return Object.freeze({
    type: 'object' as const,
    ...(value.properties === undefined ? {} : {
      properties: value.properties as Readonly<Record<string, import('./contracts.js').RuntimeExtensionJsonValue>>,
    }),
    ...(value.required === undefined ? {} : { required: Object.freeze([...value.required]) }),
    ...(value.additionalProperties === undefined ? {} : { additionalProperties: value.additionalProperties }),
  });
}

function isJsonValue(value: unknown): value is import('./contracts.js').RuntimeExtensionJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function normalizeContributions(value: unknown): NonNullable<RuntimeExtensionManifest['contributes']> {
  if (!isRecord(value)) throw new TypeError('Runtime extension contributions metadata is invalid.');
  const result: Record<string, readonly string[]> = {};
  for (const key of ['services', 'capabilities', 'events', 'ui', 'catalog']) {
    const items = value[key];
    if (items === undefined) continue;
    if (!Array.isArray(items) || items.length > 128 ||
      items.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 256)) {
      throw new TypeError('Runtime extension contributions metadata is invalid.');
    }
    result[key] = Object.freeze([...items]);
  }
  if (Object.keys(value).some((key) => !['services', 'capabilities', 'events', 'ui', 'catalog'].includes(key))) {
    throw new TypeError('Runtime extension contributions metadata is invalid.');
  }
  return Object.freeze(result) as NonNullable<RuntimeExtensionManifest['contributes']>;
}


export function requireRuntimeExtensionIdentity(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > 214
    || value !== value.trim()
    || value !== value.normalize('NFC')
    || !IDENTITY_PATTERN.test(value)
  ) {
    throw new TypeError('Runtime extension identity must be a canonical package identity.');
  }
  return value;
}

export function requireRuntimeExtensionVersion(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > 96
    || value !== value.trim()
    || !EXACT_SEMVER_PATTERN.test(value)
  ) {
    throw new TypeError('Runtime extension version must be an exact semantic version.');
  }
  return value;
}

export function requireRuntimeExtensionEntrypoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError('Runtime extension entrypoint must be a bounded relative path.');
  }
  if (
    value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((segment) => {
      const basename = segment.split('.')[0]?.toUpperCase() ?? '';
      return (
        !segment
        || segment === '.'
        || segment === '..'
        || segment.endsWith('.')
        || segment.endsWith(' ')
        || segment.length > 120
        || !PATH_SEGMENT_PATTERN.test(segment)
        || WINDOWS_RESERVED_BASENAMES.has(basename)
      );
    })
    || !value.endsWith('.cjs')
  ) {
    throw new TypeError(
      'Runtime extension entrypoint must be a portable relative .cjs path.',
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
