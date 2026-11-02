import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { codexAdapterDiagnosticRoot } from './runtimePaths.js';

const DIAGNOSTIC_VERSION = 1;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const LOG_FILE_PATTERN = /^adapter-process-\d+-\d+\.jsonl$/;
const SAFE_ERROR_CODES = new Set([
  'EACCES',
  'EADDRINUSE',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EIO',
  'EMFILE',
  'ENOENT',
  'ENOMEM',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
]);

export type CodexAdapterDiagnosticEvent =
  | 'process_start'
  | 'server_ready'
  | 'shutdown_started'
  | 'shutdown_complete'
  | 'shutdown_failed'
  | 'top_level_error'
  | 'uncaught_exception'
  | 'process_exit';

export interface CodexAdapterDiagnostics {
  readonly filePath: string;
  record(event: CodexAdapterDiagnosticEvent, details?: Readonly<Record<string, unknown>>): void;
}

interface CreateDiagnosticsOptions {
  rootPath?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  now?: () => Date;
  uptime?: () => number;
  pid?: number;
}

/**
 * A deliberately metadata-only process journal. It never records argv, cwd,
 * environment variables, tool inputs, error messages, or stacks.
 */
export function createCodexAdapterDiagnostics(
  options: CreateDiagnosticsOptions = {},
): CodexAdapterDiagnostics {
  const rootPath = options.rootPath ?? codexAdapterDiagnosticRoot();
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
  const maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const now = options.now ?? (() => new Date());
  const uptime = options.uptime ?? (() => process.uptime());
  const pid = options.pid ?? process.pid;
  const startedAt = now().getTime();
  const filePath = join(rootPath, `adapter-process-${pid}-${startedAt}.jsonl`);

  try {
    mkdirSync(rootPath, { recursive: true, mode: 0o700 });
    pruneOldDiagnostics(rootPath, maxFiles - 1);
  } catch {
    // Diagnostics must never take down the MCP adapter.
  }

  return {
    filePath,
    record(event, details = {}) {
      try {
        const record = {
          version: DIAGNOSTIC_VERSION,
          timestamp: now().toISOString(),
          event,
          pid,
          uptimeMs: Math.max(0, Math.round(uptime() * 1000)),
          ...safeDetails(details),
        };
        const line = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(line, 'utf8') > maxFileBytes) return;
        let currentBytes = 0;
        try {
          currentBytes = statSync(filePath).size;
        } catch {
          // The first append creates the file.
        }
        if (currentBytes + Buffer.byteLength(line, 'utf8') > maxFileBytes) return;
        appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // Best-effort observability cannot change runtime behavior.
      }
    },
  };
}

/** Install observers that preserve Node's normal fatal-exception semantics. */
export function installCodexAdapterProcessDiagnostics(
  diagnostics: CodexAdapterDiagnostics,
): () => void {
  const onFatal = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    diagnostics.record('uncaught_exception', {
      origin,
      ...safeErrorIdentity(error),
    });
  };
  const onExit = (exitCode: number): void => {
    diagnostics.record('process_exit', { exitCode });
  };
  process.on('uncaughtExceptionMonitor', onFatal);
  process.once('exit', onExit);
  return () => {
    process.off('uncaughtExceptionMonitor', onFatal);
    process.off('exit', onExit);
  };
}

export function safeErrorIdentity(error: unknown): Readonly<Record<string, unknown>> {
  const name = error instanceof Error ? boundedIdentifier(error.name, 'Error') : typeof error;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: name,
    ...(code ? { errorCode: code } : {}),
    messageBytes: Buffer.byteLength(message, 'utf8'),
    errorFingerprint: createHash('sha256')
      .update(`${name}\0${code ?? ''}\0${message}`)
      .digest('hex'),
  };
}

function safeDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^(?:reason|origin|exitCode|errorName|errorCode|messageBytes|errorFingerprint)$/.test(key)) {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    if (typeof value === 'string') result[key] = boundedIdentifier(value, 'unknown');
  }
  return result;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' && SAFE_ERROR_CODES.has(value) ? value : undefined;
}

function boundedIdentifier(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 96);
  return normalized || fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function pruneOldDiagnostics(rootPath: string, keepExisting: number): void {
  const files = readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      modified: statSync(join(rootPath, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
  for (const stale of files.slice(Math.max(0, keepExisting))) {
    try {
      unlinkSync(join(rootPath, stale.name));
    } catch {
      // A concurrent adapter can already have pruned it.
    }
  }
}
