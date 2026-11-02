import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import {
  RUNTIME_EXTENSION_MANIFEST_FILENAME,
  validateRuntimeExtensionManifest,
  type RuntimeExtensionManifest,
  type RuntimeExtensionPackageManager,
} from '@marshal/agent-runtime-extensions';

const MAX_METADATA_BYTES = 128 * 1024;
const DEFAULT_MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;

export type RuntimeNativeExtensionInstallationPhase =
  | 'validating'
  | 'running-script'
  | 'completed';

export interface RuntimeNativeExtensionInstallationEvent {
  readonly phase: RuntimeNativeExtensionInstallationPhase;
  readonly packageRoot: string;
  readonly packageManager?: RuntimeExtensionPackageManager;
  readonly script?: string;
}

export interface RuntimeNativeExtensionPackageManagerCommand {
  readonly executable: string;
  readonly prefixArguments?: readonly string[];
}

export interface RuntimeNativeExtensionInstallationOptions {
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly maxCapturedOutputBytes?: number;
  /** Host override for bundled package managers and deterministic tests. */
  readonly commands?: Partial<
    Readonly<Record<RuntimeExtensionPackageManager, RuntimeNativeExtensionPackageManagerCommand>>
  >;
  readonly onEvent?: (event: RuntimeNativeExtensionInstallationEvent) => void;
}

export interface RuntimeNativeExtensionInstallationPlan {
  readonly packageRoot: string;
  readonly manifest: RuntimeExtensionManifest;
  readonly packageManager: RuntimeExtensionPackageManager;
  readonly script: string;
  readonly command: RuntimeNativeExtensionPackageManagerCommand & {
    readonly arguments: readonly string[];
  };
}

export interface RuntimeNativeExtensionInstallationResult {
  readonly packageRoot: string;
  readonly manifest: RuntimeExtensionManifest;
  readonly packageManager: RuntimeExtensionPackageManager;
  readonly script: string;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export class RuntimeNativeExtensionInstallationError extends Error {
  readonly code:
    | 'INSTALLATION_NOT_DECLARED'
    | 'PACKAGE_MANAGER_UNAVAILABLE'
    | 'INSTALLATION_CANCELLED'
    | 'INSTALLATION_FAILED';
  readonly result?: RuntimeNativeExtensionInstallationResult;

  constructor(
    code: RuntimeNativeExtensionInstallationError['code'],
    message: string,
    options: { readonly cause?: unknown; readonly result?: RuntimeNativeExtensionInstallationResult } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RuntimeNativeExtensionInstallationError';
    this.code = code;
    this.result = options.result;
  }
}

/**
 * Runs a manifest-declared package script as trusted repository code. This is
 * an explicit preparation step; it does not calculate integrity or install the
 * resulting package into a lifecycle manager.
 */
export async function inspectRuntimeNativeExtensionInstallation(
  packageRoot: string,
  options: Pick<RuntimeNativeExtensionInstallationOptions, 'commands' | 'signal'> = {},
): Promise<RuntimeNativeExtensionInstallationPlan> {
  throwIfAborted(options.signal);
  const canonicalRoot = await requireCanonicalPackageRoot(packageRoot);
  return inspectCanonicalInstallation(canonicalRoot, options.commands);
}

export async function runRuntimeNativeExtensionInstallation(
  packageRoot: string,
  options: RuntimeNativeExtensionInstallationOptions = {},
): Promise<RuntimeNativeExtensionInstallationResult> {
  throwIfAborted(options.signal);
  const canonicalRoot = await requireCanonicalPackageRoot(packageRoot);
  options.onEvent?.({ phase: 'validating', packageRoot: canonicalRoot });
  const plan = await inspectCanonicalInstallation(canonicalRoot, options.commands);
  const { manifest, packageManager, script, command } = plan;
  const maxCapturedOutputBytes = normalizeOutputBound(options.maxCapturedOutputBytes);
  options.onEvent?.({
    phase: 'running-script',
    packageRoot: canonicalRoot,
    packageManager,
    script,
  });
  const startedAt = performance.now();
  const execution = await executePackageScript({
    command,
    packageManager,
    script,
    packageRoot: canonicalRoot,
    maxCapturedOutputBytes,
    signal: options.signal,
    environment: options.environment,
  });
  const result: RuntimeNativeExtensionInstallationResult = Object.freeze({
    packageRoot: canonicalRoot,
    manifest,
    packageManager,
    script,
    durationMs: performance.now() - startedAt,
    stdout: execution.stdout,
    stderr: execution.stderr,
    outputTruncated: execution.outputTruncated,
  });
  if (execution.cancelled) {
    throw new RuntimeNativeExtensionInstallationError(
      'INSTALLATION_CANCELLED',
      'Runtime extension installation was cancelled.',
      { result },
    );
  }
  if (execution.exitCode !== 0) {
    throw new RuntimeNativeExtensionInstallationError(
      'INSTALLATION_FAILED',
      `Runtime extension installation script failed with exit code ${execution.exitCode ?? 'unknown'}.`,
      { result },
    );
  }
  options.onEvent?.({
    phase: 'completed',
    packageRoot: canonicalRoot,
    packageManager,
    script,
  });
  return result;
}

async function inspectCanonicalInstallation(
  canonicalRoot: string,
  commands: RuntimeNativeExtensionInstallationOptions['commands'],
): Promise<RuntimeNativeExtensionInstallationPlan> {
  const [manifest, packageMetadata] = await Promise.all([
    readManifest(canonicalRoot),
    readPackageMetadata(canonicalRoot),
  ]);
  const installation = manifest.installation;
  if (!installation) {
    throw new RuntimeNativeExtensionInstallationError(
      'INSTALLATION_NOT_DECLARED',
      'Runtime extension manifest does not declare an installation script.',
    );
  }
  const packageManager = installation.packageManager
    ?? await detectPackageManager(canonicalRoot, packageMetadata);
  const command = commands?.[packageManager]
    ?? defaultPackageManagerCommand(packageManager);
  if (!command.executable.trim()) {
    throw new RuntimeNativeExtensionInstallationError(
      'PACKAGE_MANAGER_UNAVAILABLE',
      `Runtime extension package manager is unavailable: ${packageManager}.`,
    );
  }
  return Object.freeze({
    packageRoot: canonicalRoot,
    manifest,
    packageManager,
    script: installation.script,
    command: Object.freeze({
      executable: command.executable,
      ...(command.prefixArguments
        ? { prefixArguments: Object.freeze([...command.prefixArguments]) }
        : {}),
      arguments: Object.freeze([
        ...(command.prefixArguments ?? []),
        'run',
        installation.script,
      ]),
    }),
  });
}

async function requireCanonicalPackageRoot(packageRoot: string): Promise<string> {
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) {
    throw new TypeError('Runtime extension installation packageRoot must be absolute.');
  }
  const resolved = path.resolve(packageRoot);
  const stat = await lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError('Runtime extension installation packageRoot must be a real directory.');
  }
  const canonical = await realpath(resolved);
  if (!samePath(resolved, canonical)) {
    throw new TypeError('Runtime extension installation packageRoot cannot traverse a symbolic link.');
  }
  return canonical;
}

async function readManifest(packageRoot: string): Promise<RuntimeExtensionManifest> {
  const manifestPath = path.join(packageRoot, RUNTIME_EXTENSION_MANIFEST_FILENAME);
  const source = await readBoundedRegularFile(manifestPath, 'Runtime extension manifest');
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new TypeError('Runtime extension manifest must contain valid JSON.', { cause: error });
  }
  return validateRuntimeExtensionManifest(value);
}

async function readPackageMetadata(packageRoot: string): Promise<unknown> {
  const source = await readBoundedRegularFile(
    path.join(packageRoot, 'package.json'),
    'Runtime extension package metadata',
  );
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new TypeError('Runtime extension package metadata must contain valid JSON.', {
      cause: error,
    });
  }
}

async function readBoundedRegularFile(filePath: string, label: string): Promise<string> {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_METADATA_BYTES) {
    throw new TypeError(`${label} must be a bounded regular file.`);
  }
  return readFile(filePath, 'utf8');
}

async function detectPackageManager(
  packageRoot: string,
  packageMetadata: unknown,
): Promise<RuntimeExtensionPackageManager> {
  if (isRecord(packageMetadata) && typeof packageMetadata.packageManager === 'string') {
    const declared = packageMetadata.packageManager.split('@', 1)[0];
    if (isPackageManager(declared)) return declared;
  }
  const lockfiles = [
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['bun', 'bun.lock'],
    ['bun', 'bun.lockb'],
    ['npm', 'package-lock.json'],
    ['npm', 'npm-shrinkwrap.json'],
  ] as const;
  for (const [manager, fileName] of lockfiles) {
    try {
      const stat = await lstat(path.join(packageRoot, fileName));
      if (!stat.isSymbolicLink() && stat.isFile()) return manager;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
  return 'npm';
}

function defaultPackageManagerCommand(
  packageManager: RuntimeExtensionPackageManager,
): RuntimeNativeExtensionPackageManagerCommand {
  return {
    executable: process.platform === 'win32' ? `${packageManager}.cmd` : packageManager,
  };
}

async function executePackageScript(options: {
  readonly command: RuntimeNativeExtensionPackageManagerCommand;
  readonly packageManager: RuntimeExtensionPackageManager;
  readonly script: string;
  readonly packageRoot: string;
  readonly maxCapturedOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<{
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}> {
  throwIfAborted(options.signal);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  const child = spawn(
    options.command.executable,
    [...(options.command.prefixArguments ?? []), 'run', options.script],
    {
      cwd: options.packageRoot,
      env: { ...process.env, ...options.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout.on('data', (chunk: Buffer) => {
    const captured = captureChunk(chunk, options.maxCapturedOutputBytes - stdoutBytes);
    stdout.push(captured.value);
    stdoutBytes += captured.value.byteLength;
    outputTruncated ||= captured.truncated;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const captured = captureChunk(chunk, options.maxCapturedOutputBytes - stderrBytes);
    stderr.push(captured.value);
    stderrBytes += captured.value.byteLength;
    outputTruncated ||= captured.truncated;
  });
  let cancelled = false;
  const abort = () => {
    cancelled = true;
    child.kill();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', (error) => {
        reject(new RuntimeNativeExtensionInstallationError(
          'PACKAGE_MANAGER_UNAVAILABLE',
          `Runtime extension package manager could not be started: ${options.packageManager}.`,
          { cause: error },
        ));
      });
      child.once('close', resolve);
    });
    return {
      exitCode,
      cancelled,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      outputTruncated,
    };
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

function captureChunk(
  chunk: Buffer,
  remaining: number,
): { readonly value: Buffer; readonly truncated: boolean } {
  if (remaining <= 0) return { value: Buffer.alloc(0), truncated: chunk.byteLength > 0 };
  if (chunk.byteLength <= remaining) return { value: chunk, truncated: false };
  return { value: chunk.subarray(0, remaining), truncated: true };
}

function normalizeOutputBound(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CAPTURED_OUTPUT_BYTES;
  if (!Number.isInteger(value) || value < 0 || value > 16 * 1024 * 1024) {
    throw new TypeError(
      'Runtime extension installation maxCapturedOutputBytes must be an integer from 0 to 16777216.',
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new RuntimeNativeExtensionInstallationError(
    'INSTALLATION_CANCELLED',
    'Runtime extension installation was cancelled.',
  );
}

function isPackageManager(value: string): value is RuntimeExtensionPackageManager {
  return value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && Reflect.get(error, 'code') === 'ENOENT';
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}
