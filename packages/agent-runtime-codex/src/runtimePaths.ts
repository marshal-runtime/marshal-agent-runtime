import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export function codexUiStateRoot(): string {
  return configuredAbsolutePath(
    'MARSHAL_RUNTIME_UI_STATE_ROOT',
    join(homedir(), '.marshal', 'codex', 'ui-state'),
  );
}

export function codexUiAuthorityKeyPath(): string {
  return configuredAbsolutePath(
    'MARSHAL_RUNTIME_UI_AUTH_KEY',
    join(homedir(), '.marshal', 'codex', 'keys', 'ui-record-hmac-v1.key'),
  );
}

export function codexProtectedLifecycleResultRoot(): string {
  return configuredAbsolutePath(
    'MARSHAL_RUNTIME_PROTECTED_LIFECYCLE_ROOT',
    join(homedir(), '.marshal', 'codex', 'protected-lifecycle-results'),
  );
}

export function codexTranscriptSpoolRoot(): string {
  return configuredAbsolutePath(
    'MARSHAL_RUNTIME_TRANSCRIPT_SPOOL_ROOT',
    join(homedir(), '.marshal', 'codex', 'transcripts'),
  );
}

/** Profile-local, workspace-independent root for bounded adapter process diagnostics. */
export function codexAdapterDiagnosticRoot(): string {
  return configuredAbsolutePath(
    'MARSHAL_RUNTIME_DIAGNOSTIC_ROOT',
    join(homedir(), '.marshal', 'codex', 'diagnostics'),
  );
}

export function codexRuntimeExtensionRoot(): string {
  return configuredAbsolutePath(
    'MARSHAL_RUNTIME_EXTENSION_ROOT',
    join(homedir(), '.marshal', 'codex', 'extensions'),
  );
}

export function codexExtensionAutopilotStatePath(): string {
  return configuredAbsolutePath(
    'MARSHAL_RUNTIME_EXTENSION_AUTOPILOT_STATE',
    join(homedir(), '.marshal', 'codex', 'extension-autopilot.json'),
  );
}

export function codexRuntimeExtensionRoots(): readonly string[] {
  return uniquePaths([
    codexRuntimeExtensionRoot(),
    ...configuredAbsolutePaths('MARSHAL_RUNTIME_EXTENSION_DISCOVERY_ROOTS'),
  ]);
}

function configuredAbsolutePath(name: string, fallback: string): string {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  if (!isAbsolute(configured)) throw new Error(`${name} must be an absolute path.`);
  return resolve(configured);
}

function configuredAbsolutePaths(name: string): readonly string[] {
  const configured = process.env[name]?.trim();
  if (!configured) return [];
  return configured.split(delimiter).map((value) => {
    const candidate = value.trim();
    if (!candidate || !isAbsolute(candidate)) {
      throw new Error(`${name} must contain only absolute paths.`);
    }
    return resolve(candidate);
  });
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
