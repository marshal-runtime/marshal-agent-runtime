import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
  RUNTIME_EXTENSION_STATE_SCHEMA_VERSION,
  type RuntimeExtensionStateStore,
  type RuntimeExtensionStoredRecord,
} from './contracts.js';
import { normalizeRuntimeExtensionConfiguration } from './configuration.js';
import {
  requireRuntimeExtensionIdentity,
  requireRuntimeExtensionVersion,
} from './manifest.js';

export type RuntimeExtensionStateErrorCode =
  | 'READ_FAILED'
  | 'INVALID_STATE'
  | 'WRITE_FAILED';

const STATE_ERROR_MESSAGES: Readonly<Record<RuntimeExtensionStateErrorCode, string>> = {
  READ_FAILED: 'The runtime extension state could not be read.',
  INVALID_STATE: 'The runtime extension state is invalid.',
  WRITE_FAILED: 'The runtime extension state could not be written.',
};
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class RuntimeExtensionStateError extends Error {
  constructor(
    readonly code: RuntimeExtensionStateErrorCode,
    cause?: unknown,
  ) {
    super(STATE_ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = 'RuntimeExtensionStateError';
  }
}

/** One JSON file containing the extension manager's canonical installed state. */
export class JsonFileRuntimeExtensionStateStore implements RuntimeExtensionStateStore {
  readonly filePath: string;

  constructor(filePath: string) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > 32_768) {
      throw new TypeError('Runtime extension state file path is invalid.');
    }
    this.filePath = path.resolve(filePath);
  }

  async load(): Promise<readonly RuntimeExtensionStoredRecord[]> {
    let source: string;
    try {
      source = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return Object.freeze([]);
      throw new RuntimeExtensionStateError('READ_FAILED', error);
    }
    try {
      return validateState(JSON.parse(source) as unknown);
    } catch (error) {
      if (error instanceof RuntimeExtensionStateError) throw error;
      throw new RuntimeExtensionStateError('INVALID_STATE', error);
    }
  }

  async save(records: readonly RuntimeExtensionStoredRecord[]): Promise<void> {
    let state: {
      readonly schemaVersion: typeof RUNTIME_EXTENSION_STATE_SCHEMA_VERSION;
      readonly extensions: readonly RuntimeExtensionStoredRecord[];
    };
    try {
      const extensions = validateRuntimeExtensionStoredRecords(records);
      state = {
        schemaVersion: RUNTIME_EXTENSION_STATE_SCHEMA_VERSION,
        extensions,
      };
    } catch (error) {
      throw new RuntimeExtensionStateError('INVALID_STATE', error);
    }

    const temporaryPath = `${this.filePath}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'w',
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      throw new RuntimeExtensionStateError('WRITE_FAILED', error);
    }
  }
}

function validateState(value: unknown): readonly RuntimeExtensionStoredRecord[] {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'extensions')
    || value.schemaVersion !== RUNTIME_EXTENSION_STATE_SCHEMA_VERSION
    || !Array.isArray(value.extensions)
  ) {
    throw new RuntimeExtensionStateError('INVALID_STATE');
  }
  return validateRuntimeExtensionStoredRecords(value.extensions);
}

export function validateRuntimeExtensionStoredRecords(
  value: unknown,
): readonly RuntimeExtensionStoredRecord[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new TypeError('Runtime extension state contains too many extensions.');
  }
  const records = value.map(validateRecord);
  if (new Set(records.map(({ identity }) => identity)).size !== records.length) {
    throw new TypeError('Runtime extension state contains duplicate identities.');
  }
  return Object.freeze(
    records.sort((left, right) => left.identity.localeCompare(right.identity)),
  );
}

function validateRecord(value: unknown): RuntimeExtensionStoredRecord {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) =>
      !['identity', 'version', 'request', 'configuration', 'providerOverrides', 'contractBindings', 'status'].includes(key))
    || !isRecord(value.request)
    || Object.keys(value.request).some((key) => key !== 'packageRoot' && key !== 'integrity')
    || typeof value.request.packageRoot !== 'string'
    || !value.request.packageRoot
    || !isRecord(value.request.integrity)
    || value.request.integrity.algorithm !== 'sha256'
    || value.request.integrity.domain !== RUNTIME_EXTENSION_INTEGRITY_DOMAIN
    || typeof value.request.integrity.value !== 'string'
    || !SHA256_PATTERN.test(value.request.integrity.value)
    || (value.status !== 'enabled' && value.status !== 'disabled')
  ) {
    throw new TypeError('Runtime extension state record is invalid.');
  }
  return Object.freeze({
    identity: requireRuntimeExtensionIdentity(value.identity),
    version: requireRuntimeExtensionVersion(value.version),
    request: Object.freeze({
      packageRoot: value.request.packageRoot,
      integrity: Object.freeze({
        algorithm: 'sha256' as const,
        domain: RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
        value: value.request.integrity.value,
      }),
    }),
    ...(value.configuration === undefined
      ? {}
      : { configuration: normalizeRuntimeExtensionConfiguration(value.configuration) }),
    ...(value.providerOverrides === undefined
      ? {} : { providerOverrides: normalizeProviderOverrides(value.providerOverrides) }),
    ...(value.contractBindings === undefined
      ? {} : { contractBindings: normalizeProviderOverrides(value.contractBindings) }),
    status: value.status,
  });
}

function normalizeProviderOverrides(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length > 1024
    || Object.entries(value).some(([key, provider]) =>
      !key || key.length > 256 || typeof provider !== 'string'
      || !provider.trim() || provider.length > 256)) {
    throw new TypeError('Runtime extension provider overrides are invalid.');
  }
  return Object.freeze({ ...value }) as Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
  );
}
