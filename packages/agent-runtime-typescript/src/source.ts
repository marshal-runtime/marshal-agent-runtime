import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  TypeScriptModuleSourceIdentity,
  TypeScriptModuleSourceReceipt,
  TypeScriptSourceProvenance,
} from './types.js';

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export interface InlineTypeScriptSourceReference {
  readonly kind: 'inline';
  readonly source: string;
  readonly filename?: string;
  readonly export?: string;
}

export interface WorkspaceTypeScriptSourceReference {
  readonly kind: 'workspace_file';
  readonly path: string;
  readonly export?: string;
}

export interface ArtifactTypeScriptSourceReference {
  readonly kind: 'artifact';
  readonly path: string;
  readonly scope?: 'workspace' | 'project' | 'session';
  readonly export?: string;
}

export type TypeScriptModuleSourceReference =
  | InlineTypeScriptSourceReference
  | WorkspaceTypeScriptSourceReference
  | ArtifactTypeScriptSourceReference;

export interface ArtifactSourceReadResult {
  readonly content: string;
  readonly uri?: string;
  readonly provenance?: readonly TypeScriptSourceProvenance[];
}

export type ArtifactSourceReader = (
  reference: ArtifactTypeScriptSourceReference,
) => Promise<ArtifactSourceReadResult>;

export interface TypeScriptSourceResolverOptions {
  readonly workspaceRoot: string;
  readonly maxSourceBytes?: number;
  readonly readArtifact?: ArtifactSourceReader;
}

export interface ResolvedTypeScriptModuleSource {
  readonly source: string;
  readonly filename: string;
  readonly entrypoint?: string;
  readonly identity: TypeScriptModuleSourceIdentity;
  readonly receipt: TypeScriptModuleSourceReceipt;
}

/** Resolve editable source while keeping filesystem and artifact policy outside the executor. */
export async function resolveTypeScriptModuleSource(
  reference: TypeScriptModuleSourceReference,
  options: TypeScriptSourceResolverOptions,
): Promise<ResolvedTypeScriptModuleSource> {
  const maxSourceBytes = positiveInteger(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES);
  if (reference.kind === 'inline') {
    const source = requireSource(reference.source, maxSourceBytes);
    const filename = safeInlineFilename(reference.filename);
    return resolved(source, filename, reference.export, {
      kind: 'inline',
      identifier: filename,
    });
  }

  if (reference.kind === 'workspace_file') {
    const workspaceRoot = await fs.realpath(path.resolve(options.workspaceRoot));
    const logicalPath = requireLogicalPath(reference.path, 'workspace module path');
    const candidate = path.resolve(workspaceRoot, logicalPath);
    assertContained(workspaceRoot, candidate, 'Workspace module path escaped the workspace.');
    await rejectSymbolicLinkSegments(workspaceRoot, candidate);
    const real = await fs.realpath(candidate);
    assertContained(workspaceRoot, real, 'Workspace module escaped through a symbolic link.');
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw codedError('SOURCE_NOT_FILE', 'Workspace module is not a file.');
    assertSourceExtension(real);
    if (stat.size > maxSourceBytes) {
      throw codedError('SOURCE_TOO_LARGE', `Workspace module exceeds ${maxSourceBytes} bytes.`);
    }
    const source = requireSource(await fs.readFile(real, 'utf8'), maxSourceBytes);
    const portablePath = path.relative(workspaceRoot, real).split(path.sep).join('/');
    return resolved(source, real, reference.export, {
      kind: 'workspace_file',
      identifier: portablePath,
      uri: pathToFileURL(real).href,
    });
  }

  if (!options.readArtifact) {
    throw codedError('ARTIFACT_READER_UNAVAILABLE', 'No artifact source reader is configured.');
  }
  const logicalPath = requireLogicalPath(reference.path, 'artifact module path');
  assertSourceExtension(logicalPath);
  const artifact = await options.readArtifact({ ...reference, path: logicalPath });
  const source = requireSource(artifact.content, maxSourceBytes);
  return resolved(
    source,
    `artifact://${reference.scope ?? 'session'}/${logicalPath}`,
    reference.export,
    {
      kind: 'artifact',
      identifier: `${reference.scope ?? 'session'}:${logicalPath}`,
      uri: artifact.uri,
      provenance: artifact.provenance,
    },
  );
}

function resolved(
  source: string,
  filename: string,
  entrypoint: string | undefined,
  identity: TypeScriptModuleSourceIdentity,
): ResolvedTypeScriptModuleSource {
  const bytes = Buffer.from(source, 'utf8');
  return {
    source,
    filename,
    entrypoint: validateEntrypoint(entrypoint),
    identity,
    receipt: {
      ...identity,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sizeBytes: bytes.length,
    },
  };
}

function requireSource(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw codedError('SOURCE_REQUIRED', 'A non-empty source string is required.');
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw codedError('SOURCE_TOO_LARGE', `Module source exceeds ${maxBytes} bytes.`);
  }
  return value;
}

function safeInlineFilename(value: string | undefined): string {
  if (value === undefined) return 'inline-module.ts';
  if (!value.trim() || value.includes('\0') || path.isAbsolute(value)) {
    throw codedError('INVALID_SOURCE_PATH', 'Inline filename must be a non-empty relative path.');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw codedError('INVALID_SOURCE_PATH', 'Inline filename cannot contain parent traversal.');
  }
  assertSourceExtension(normalized);
  return normalized;
}

function requireLogicalPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    path.isAbsolute(value)
  ) {
    throw codedError('INVALID_SOURCE_PATH', `${label} must be a non-empty relative path.`);
  }
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw codedError('INVALID_SOURCE_PATH', `${label} contains an invalid path segment.`);
  }
  return normalized;
}

function assertSourceExtension(value: string): void {
  if (!SOURCE_EXTENSIONS.has(path.extname(value).toLowerCase())) {
    throw codedError('INVALID_SOURCE_EXTENSION', 'Module source must be TypeScript or JavaScript.');
  }
}

async function rejectSymbolicLinkSegments(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw codedError('SYMLINK_SOURCE_DENIED', 'Symbolic links are not allowed in module paths.');
    }
  }
}

function assertContained(root: string, target: string, message: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw codedError('SOURCE_OUTSIDE_WORKSPACE', message);
  }
}

function validateEntrypoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) {
    throw codedError('INVALID_ENTRYPOINT', 'Module export must be a JavaScript identifier.');
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
