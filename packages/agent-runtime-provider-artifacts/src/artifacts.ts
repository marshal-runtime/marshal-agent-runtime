import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CapabilityDescriptor, CapabilityProvider, InvocationContext } from '@marshal/agent-runtime-core';
import {
  PROTOCOL_VERSION,
  assertLogicalPath,
  assertRecord,
  boundedInteger,
  createProvider,
  hashedScopeSegment,
  isContained,
  optionalBoolean,
  optionalString,
  requireString,
  result,
} from '@marshal/agent-runtime-provider-kit';

export type ArtifactScopeLevel = 'workspace' | 'project' | 'session';

export interface ArtifactProviderOptions {
  readonly rootDirectory: string;
  readonly maxArtifactBytes?: number;
  readonly maxListResults?: number;
  readonly providerId?: string;
  /**
   * Explicit compatibility policy for the pre-1.0 unowned `workspaces/`
   * namespace. Disabled by default. Legacy data is available only to the
   * nominated principal; migration happens incrementally as files are read or
   * listed.
   */
  readonly legacyAccess?: {
    readonly mode: 'disabled' | 'read-only' | 'migrate-on-read';
    readonly ownerPrincipalId?: string;
    /** Defaults to `agent` for compatibility with pre-1.0 adapters. */
    readonly ownerPrincipalKind?: string;
  };
}

interface ResolvedArtifactScope {
  readonly root: string;
  readonly level: ArtifactScopeLevel;
  readonly directory: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly legacyDirectory: string;
}

function artifactDescriptors(
  maxArtifactBytes: number,
  maxListResults: number,
): readonly CapabilityDescriptor[] {
  const scopeSchema = {
    type: 'object',
    properties: {
      principalId: { type: 'string' },
      workspaceId: { type: 'string' },
      projectId: { type: 'string' },
      sessionId: { type: 'string' },
    },
    required: ['principalId', 'workspaceId'],
    additionalProperties: false,
  } as const;
  const artifactSummarySchema = {
    type: 'object',
    properties: {
      path: { type: 'string', maxLength: 1_024 },
      sizeBytes: { type: 'integer', minimum: 0, maximum: maxArtifactBytes },
      modifiedAt: { type: 'string', maxLength: 64 },
    },
    required: ['path', 'sizeBytes', 'modifiedAt'],
    additionalProperties: false,
  } as const;
  return [
  {
    protocolVersion: PROTOCOL_VERSION,
    name: 'artifacts.write',
    version: '1.0.0',
    description: 'Write a durable artifact inside the caller workspace, project, or session scope.',
    tags: ['artifacts', 'storage', 'durable'],
    permissions: [{ permission: 'artifacts.write', scope: 'runtime', risk: 'medium' }],
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        contentBase64: { type: 'string' },
        scope: { enum: ['workspace', 'project', 'session'] },
        mediaType: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 1_024 },
        sizeBytes: { type: 'integer', minimum: 0, maximum: maxArtifactBytes },
        mediaType: { type: 'string', maxLength: 255 },
        scope: scopeSchema,
      },
      required: ['path', 'sizeBytes', 'scope'],
      additionalProperties: false,
    },
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    name: 'artifacts.read',
    version: '1.0.0',
    description: 'Read a durable artifact from the caller workspace, project, or session scope.',
    tags: ['artifacts', 'storage', 'read'],
    permissions: [{ permission: 'artifacts.read', scope: 'runtime', risk: 'low' }],
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        scope: { enum: ['workspace', 'project', 'session'] },
        encoding: { enum: ['utf8', 'base64'] },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 1_024 },
        content: { type: 'string', maxLength: Math.ceil(maxArtifactBytes * 4 / 3) + 4 },
        encoding: { enum: ['utf8', 'base64'] },
        sizeBytes: { type: 'integer', minimum: 0, maximum: maxArtifactBytes },
        scope: scopeSchema,
      },
      required: ['path', 'content', 'encoding', 'sizeBytes', 'scope'],
      additionalProperties: false,
    },
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    name: 'artifacts.list',
    version: '1.0.0',
    description: 'List durable artifacts in the caller workspace, project, or session scope.',
    tags: ['artifacts', 'storage', 'list'],
    permissions: [{ permission: 'artifacts.read', scope: 'runtime', risk: 'low' }],
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string' },
        scope: { enum: ['workspace', 'project', 'session'] },
        limit: { type: 'integer', minimum: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        artifacts: { type: 'array', maxItems: maxListResults, items: artifactSummarySchema },
        scope: scopeSchema,
      },
      required: ['artifacts', 'scope'],
      additionalProperties: false,
    },
  },
  ];
}

export function createArtifactProvider(options: ArtifactProviderOptions): CapabilityProvider {
  if (!path.isAbsolute(options.rootDirectory)) {
    throw new Error('Artifact rootDirectory must be absolute.');
  }
  const providerId = options.providerId ?? 'marshal.artifacts';
  const maxArtifactBytes = options.maxArtifactBytes ?? 32 * 1024 * 1024;
  const maxListResults = options.maxListResults ?? 1_000;
  if (maxArtifactBytes < 1 || maxListResults < 1) throw new Error('Artifact limits must be positive.');
  const rootPromise = initializeRoot(options.rootDirectory);
  const legacyAccess = normalizeLegacyAccess(options.legacyAccess);
  const descriptors = artifactDescriptors(maxArtifactBytes, maxListResults);

  return createProvider(providerId, descriptors, async (name, rawInput, context) => {
    const input = assertRecord(rawInput ?? {});
    const scope = await resolveScope(rootPromise, context, parseScopeLevel(input.scope));
    switch (name) {
      case 'artifacts.write': {
        const logicalPath = assertLogicalPath(requireString(input, 'path', { maxLength: 1_024 }));
        const content = decodeContent(input, maxArtifactBytes);
        const target = await prepareTarget(scope.directory, logicalPath);
        const overwrite = optionalBoolean(input, 'overwrite') ?? false;
        await atomicWrite(target, content, overwrite, scope.directory);
        const stat = await fs.stat(target);
        const mediaType = optionalString(input, 'mediaType', 255);
        return result(
          {
            path: logicalPath.replace(/\\/g, '/'),
            sizeBytes: stat.size,
            ...(mediaType === undefined ? {} : { mediaType }),
            scope: scope.ids,
          },
          providerId,
          name,
          rawInput,
          context,
          {
            artifacts: [{
              id: `${scope.level}:${logicalPath.replace(/\\/g, '/')}`,
              kind: 'file',
              uri: pathToPortableFileUri(target),
              mediaType,
              metadata: { sizeBytes: stat.size, scope: scope.ids },
            }],
          },
        );
      }
      case 'artifacts.read': {
        const logicalPath = assertLogicalPath(requireString(input, 'path', { maxLength: 1_024 }));
        const target = await resolveArtifactReadTarget(scope, logicalPath, context, legacyAccess);
        const stat = await fs.stat(target);
        if (stat.size > maxArtifactBytes) {
          throw new Error(`Artifact exceeds the ${maxArtifactBytes} byte read limit.`);
        }
        const data = await fs.readFile(target);
        const encoding = input.encoding === undefined ? 'utf8' : requireString(input, 'encoding', { maxLength: 16 });
        if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('encoding must be utf8 or base64.');
        return result(
          {
            path: logicalPath.replace(/\\/g, '/'),
            content: data.toString(encoding),
            encoding,
            sizeBytes: stat.size,
            scope: scope.ids,
          },
          providerId,
          name,
          rawInput,
          context,
          { provenance: [{ source: providerId, uri: pathToPortableFileUri(target), trust: 'authoritative' }] },
        );
      }
      case 'artifacts.list': {
        const requestedLimit = boundedInteger(input.limit, 100, 1, maxListResults, 'limit');
        const prefixValue = optionalString(input, 'prefix', 1_024);
        const prefix = prefixValue ? assertLogicalPath(prefixValue, 'prefix') : '';
        const start = prefix
          ? await resolveOptionalExisting(scope.directory, prefix, undefined, true)
          : scope.directory;
        let files = start
          ? await listFiles(scope.directory, start, requestedLimit)
          : [];
        let legacyStart: string | undefined;
        if (legacyAllowed(context, legacyAccess)) {
          legacyStart = prefix
            ? await resolveOptionalExisting(scope.legacyDirectory, prefix, undefined, true)
            : await resolveOptionalDirectory(scope.root, scope.legacyDirectory);
          if (legacyStart) {
            const legacyFiles = await listFiles(scope.legacyDirectory, legacyStart, requestedLimit);
            if (legacyAccess.mode === 'migrate-on-read') {
              for (const artifact of legacyFiles) {
                await migrateLegacyFile(scope, artifact.path);
              }
              const migratedStart = prefix
                ? await resolveOptionalExisting(scope.directory, prefix, undefined, true)
                : scope.directory;
              files = migratedStart
                ? await listFiles(scope.directory, migratedStart, requestedLimit)
                : [];
            } else {
              const merged = new Map(legacyFiles.map((artifact) => [artifact.path, artifact]));
              for (const artifact of files) merged.set(artifact.path, artifact);
              files = [...merged.values()]
                .sort((left, right) => left.path.localeCompare(right.path))
                .slice(0, requestedLimit);
            }
          }
        }
        if (prefix && !start && !legacyStart) {
          await resolveExisting(scope.directory, prefix, undefined, true);
        }
        return result({ artifacts: files, scope: scope.ids }, providerId, name, rawInput, context);
      }
      default:
        throw new Error(`Unsupported artifact capability: ${name}`);
    }
  });
}

async function initializeRoot(configuredRoot: string): Promise<string> {
  await fs.mkdir(configuredRoot, { recursive: true });
  return fs.realpath(configuredRoot);
}

function parseScopeLevel(value: unknown): ArtifactScopeLevel {
  if (value === undefined) return 'session';
  if (value === 'workspace' || value === 'project' || value === 'session') return value;
  throw new Error('scope must be workspace, project, or session.');
}

async function resolveScope(
  rootPromise: Promise<string>,
  context: InvocationContext,
  level: ArtifactScopeLevel,
): Promise<ResolvedArtifactScope> {
  const root = await rootPromise;
  const principalId = context.principal.id.trim();
  if (!principalId) throw new Error('A stable principal id is required for artifact access.');
  const workspaceId = context.scope?.workspaceId;
  if (!workspaceId) throw new Error('A workspaceId is required for artifact access.');
  const ids: Record<string, string> = { principalId, workspaceId };
  const scopeSegments = ['workspaces', hashedScopeSegment('workspace', workspaceId)];
  if (level === 'project' || level === 'session') {
    const projectId = context.scope?.projectId;
    if (!projectId) throw new Error(`A projectId is required for ${level}-scoped artifacts.`);
    ids.projectId = projectId;
    scopeSegments.push('projects', hashedScopeSegment('project', projectId));
  }
  if (level === 'session') {
    const sessionId = context.scope?.sessionId;
    if (!sessionId) throw new Error('A sessionId is required for session-scoped artifacts.');
    ids.sessionId = sessionId;
    scopeSegments.push('sessions', hashedScopeSegment('session', sessionId));
  }
  const ownerSegment = hashedScopeSegment(
    'principal',
    `${context.principal.kind}:${principalId}`,
  );
  const directory = path.join(root, 'principals', ownerSegment, ...scopeSegments);
  const legacyDirectory = path.join(root, ...scopeSegments);
  await ensureDirectory(root, directory);
  return { root, level, directory, ids, legacyDirectory };
}

interface NormalizedLegacyAccess {
  readonly mode: 'disabled' | 'read-only' | 'migrate-on-read';
  readonly ownerPrincipalId: string;
  readonly ownerPrincipalKind: string;
}

function normalizeLegacyAccess(
  configured: ArtifactProviderOptions['legacyAccess'],
): NormalizedLegacyAccess {
  const mode = configured?.mode ?? 'disabled';
  const ownerPrincipalId = configured?.ownerPrincipalId?.trim() ?? '';
  const ownerPrincipalKind = configured?.ownerPrincipalKind?.trim() || 'agent';
  if (mode !== 'disabled' && !ownerPrincipalId) {
    throw new Error('legacyAccess.ownerPrincipalId is required when legacy artifact access is enabled.');
  }
  return { mode, ownerPrincipalId, ownerPrincipalKind };
}

function legacyAllowed(
  context: InvocationContext,
  policy: NormalizedLegacyAccess,
): boolean {
  return policy.mode !== 'disabled'
    && context.principal.kind === policy.ownerPrincipalKind
    && context.principal.id === policy.ownerPrincipalId;
}

async function resolveArtifactReadTarget(
  scope: ResolvedArtifactScope,
  logicalPath: string,
  context: InvocationContext,
  legacyAccess: NormalizedLegacyAccess,
): Promise<string> {
  const owned = await resolveOptionalExisting(scope.directory, logicalPath, 'file');
  if (owned) return owned;
  if (!legacyAllowed(context, legacyAccess)) {
    return resolveExisting(scope.directory, logicalPath, 'file');
  }
  const legacy = await resolveExisting(scope.legacyDirectory, logicalPath, 'file');
  if (legacyAccess.mode === 'read-only') return legacy;
  await migrateLegacyFile(scope, logicalPath);
  return resolveExisting(scope.directory, logicalPath, 'file');
}

async function migrateLegacyFile(
  scope: ResolvedArtifactScope,
  logicalPath: string,
): Promise<void> {
  const legacy = await resolveOptionalExisting(scope.legacyDirectory, logicalPath, 'file');
  if (!legacy) return;
  const target = await prepareTarget(scope.directory, logicalPath);
  try {
    await fs.copyFile(legacy, target, fsConstants.COPYFILE_EXCL);
    await fs.chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await fs.unlink(legacy).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function decodeContent(input: Readonly<Record<string, unknown>>, maxBytes: number): Buffer {
  const text = input.content;
  const base64 = input.contentBase64;
  if ((typeof text === 'string') === (typeof base64 === 'string')) {
    throw new Error('Exactly one of content or contentBase64 must be supplied.');
  }
  if (text !== undefined && typeof text !== 'string') throw new TypeError('content must be a string.');
  if (base64 !== undefined && typeof base64 !== 'string') throw new TypeError('contentBase64 must be a string.');
  if (typeof base64 === 'string' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('contentBase64 is not valid canonical base64.');
  }
  const buffer = Buffer.from((text ?? base64) as string, text !== undefined ? 'utf8' : 'base64');
  if (buffer.length > maxBytes) throw new Error(`Artifact exceeds the ${maxBytes} byte write limit.`);
  return buffer;
}

async function ensureDirectory(root: string, directory: string): Promise<void> {
  if (!isContained(root, directory)) throw new Error('Resolved directory escaped the artifact root.');
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const existing = await fs.lstat(current);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`Artifact directory component is not a real directory: ${segment}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await fs.mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        // Another invocation may have created this shared scope component
        // after our lstat. Revalidate the winner rather than treating the
        // expected first-write race as a failure or trusting its file type.
        const existing = await fs.lstat(current);
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          throw new Error(`Artifact directory component is not a real directory: ${segment}`);
        }
      }
    }
    const real = await fs.realpath(current);
    if (!isContained(root, real)) throw new Error('Artifact directory escaped through a symbolic link.');
  }
}

async function prepareTarget(scopeRoot: string, logicalPath: string): Promise<string> {
  const target = path.join(scopeRoot, logicalPath);
  if (!isContained(scopeRoot, target)) throw new Error('Artifact path escaped its scope.');
  await ensureDirectory(scopeRoot, path.dirname(target));
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Artifact target is not a regular file.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

async function resolveExisting(
  scopeRoot: string,
  logicalPath: string,
  expected?: 'file' | 'directory',
  allowEither = false,
): Promise<string> {
  const target = path.join(scopeRoot, logicalPath);
  if (!isContained(scopeRoot, target)) throw new Error('Artifact path escaped its scope.');
  const relative = path.relative(scopeRoot, target);
  let current = scopeRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in artifact paths.');
  }
  const stat = await fs.lstat(target);
  if (!allowEither && expected === 'file' && !stat.isFile()) throw new Error('Artifact is not a file.');
  if (!allowEither && expected === 'directory' && !stat.isDirectory()) throw new Error('Artifact is not a directory.');
  const real = await fs.realpath(target);
  if (!isContained(scopeRoot, real)) throw new Error('Artifact escaped its scope.');
  return real;
}

async function resolveOptionalExisting(
  scopeRoot: string,
  logicalPath: string,
  expected?: 'file' | 'directory',
  allowEither = false,
): Promise<string | undefined> {
  try {
    return await resolveExisting(scopeRoot, logicalPath, expected, allowEither);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function resolveOptionalDirectory(root: string, directory: string): Promise<string | undefined> {
  try {
    if (!isContained(root, directory)) throw new Error('Legacy artifact scope escaped the artifact root.');
    const relative = path.relative(root, directory);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Legacy artifact scope contains a symbolic link or non-directory component.');
      }
    }
    const canonical = await fs.realpath(directory);
    if (!isContained(root, canonical)) throw new Error('Legacy artifact scope escaped the artifact root.');
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWrite(target: string, content: Buffer, overwrite: boolean, scopeRoot: string): Promise<void> {
  const temp = path.join(path.dirname(target), `.runtime-write-${randomUUID()}.tmp`);
  if (!isContained(scopeRoot, temp)) throw new Error('Temporary artifact path escaped its scope.');
  await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    if (!overwrite) {
      try {
        // A hard link is an atomic create-if-absent operation on the same
        // filesystem, avoiding the lstat/rename overwrite race.
        await fs.link(temp, target);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Artifact already exists; set overwrite to true to replace it.');
        }
        throw error;
      }
    }
    try {
      await fs.rename(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!overwrite || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
      const existing = await fs.lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Artifact target is not a regular file.');
      await fs.unlink(target);
      await fs.rename(temp, target);
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function listFiles(scopeRoot: string, start: string, limit: number): Promise<Array<{ path: string; sizeBytes: number; modifiedAt: string }>> {
  const startStat = await fs.lstat(start);
  if (startStat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in artifact paths.');
  if (startStat.isFile()) {
    return [{
      path: path.relative(scopeRoot, start).split(path.sep).join('/'),
      sizeBytes: startStat.size,
      modifiedAt: startStat.mtime.toISOString(),
    }];
  }
  const found: Array<{ path: string; sizeBytes: number; modifiedAt: string }> = [];
  const pending = [start];
  while (pending.length > 0 && found.length < limit) {
    const directory = pending.shift()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(candidate);
      if (stat.isFile()) {
        found.push({
          path: path.relative(scopeRoot, candidate).split(path.sep).join('/'),
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
        if (found.length >= limit) break;
      }
    }
  }
  return found;
}

function pathToPortableFileUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}
