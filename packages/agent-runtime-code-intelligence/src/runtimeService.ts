import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  createRuntimeCompositionServiceDescriptor,
  type RuntimeCompositionServiceDescriptor,
  type RuntimeServiceContainer,
} from '@marshal/agent-runtime-composer';
import type {
  CapabilityProvider,
  InvocationContext,
  RuntimeHarnessIdentity,
  RuntimePrincipal,
} from '@marshal/agent-runtime-core';
import { BrainNotConfiguredIndex } from './brainNotConfigured.js';
import type { KnowledgeIndex, RebuildableKnowledgeIndex } from './knowledge.js';
import { createKnowledgeIndexProvider } from './knowledge.js';

const MAX_WORKSPACE_IDENTITY_CACHE_ENTRIES = 64;
const WORKSPACE_IDENTITY_CACHE_TTL_MS = 30_000;
const REPOSITORY_ID_ENV = 'MARSHAL_RUNTIME_REPOSITORY_ID';
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

export interface RuntimeCodeIntelligencePaths {
  readonly runtimeDataRoot: string;
  readonly runtimeProjectionRoot: string;
  readonly workspaceDataRoot: string;
  readonly repositoryCommonId: string;
  readonly worktreeId: string;
  readonly gitCommonDirectoryId?: string;
  readonly projectProjectionRoot: string;
  readonly profileRoot: string;
  readonly profileDataRoot: string;
  readonly profileProjectionRoot: string;
}

export interface RuntimeCodeIntelligenceWorkspaceIdentity {
  readonly canonicalWorkspacePath: string;
  readonly repositoryCommonId: string;
  readonly worktreeId: string;
  readonly gitCommonDirectoryId?: string;
}


export interface RuntimeCodeIntelligenceService extends KnowledgeIndex {
  forContext(context: InvocationContext): RuntimeCodeIntelligenceWorkspace;
  paths(context?: InvocationContext): RuntimeCodeIntelligencePaths;
  workspaceIndex(context?: InvocationContext): RebuildableKnowledgeIndex;
  requestIndex(request: RuntimeCodeIntelligenceIndexRequest): RuntimeCodeIntelligenceIndexLease;
}

export interface RuntimeCodeIntelligenceWorkspace extends KnowledgeIndex {
  paths(): RuntimeCodeIntelligencePaths;
  workspaceIndex(): RebuildableKnowledgeIndex;
}

export interface RuntimeCodeIntelligenceIndexRequest {
  readonly ownerId: string;
  readonly projectRoot: string;
  readonly projectionRoot: string;
  readonly dataRoot: string;
  readonly profileId: string;
  readonly projectId: string;
  readonly federate?: boolean;
}

export interface RuntimeCodeIntelligenceIndexLease {
  readonly index: RebuildableKnowledgeIndex;
  dispose(): Promise<void>;
}

const IMMEDIATE_SWEEP_MAX_BYTES = 1024 * 1024 * 1024;


const intelligenceContract = {
  name: '@marshal/agent-runtime-code-intelligence:service',
  version: '1',
  methods: [
    { name: 'search', version: '1' },
    { name: 'context', version: '1' },
    { name: 'impact', version: '1' },
    { name: 'detectChanges', version: '1' },
    { name: 'status', version: '1' },
    { name: 'upsertDocument', version: '1' },
    { name: 'removeDocument', version: '1' },
    { name: 'mutateDocuments', version: '1' },
    { name: 'forContext', version: '1' },
    { name: 'paths', version: '1' },
    { name: 'workspaceIndex', version: '1' },
    { name: 'requestIndex', version: '1' },
  ],
} as const;

export const RUNTIME_CODE_INTELLIGENCE_SERVICE:
RuntimeCompositionServiceDescriptor<RuntimeCodeIntelligenceService> =
  createRuntimeCompositionServiceDescriptor(
    '@marshal/agent-runtime-code-intelligence:service',
    intelligenceContract,
    'codeIntelligence',
  );


export interface RuntimeCodeIntelligenceSourceOptions {
  readonly workspaceDataRoot?: string;
  readonly runtimeDataRoot?: string;
  readonly projectProjectionRoot?: string;
  readonly profileDataRoot?: string;
  readonly profileProjectionRoot?: string;
  readonly runtimeCodeRoot?: string;
}

export interface CreateRuntimeCodeIntelligenceBundleOptions
  extends RuntimeCodeIntelligenceSourceOptions {
  readonly runtimePackageRoots?: readonly string[];
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly stateRoot: string;
  readonly protectedLifecycleResultRoot: string;
  readonly principal: RuntimePrincipal;
  readonly identity: RuntimeHarnessIdentity;
  readonly services: RuntimeServiceContainer;
}

export interface RuntimeCodeIntelligenceBundle {
  readonly service: RuntimeCodeIntelligenceService;
  start(): void;
  dispose(): Promise<void>;
}

export interface CreateRuntimeCodeIntelligenceProvidersOptions {
  readonly services: RuntimeServiceContainer;
  readonly excludedProviderIds?: ReadonlySet<string>;
}

export function createRuntimeCodeIntelligencePaths(
  options: Pick<
    CreateRuntimeCodeIntelligenceBundleOptions,
    | 'workspacePath'
    | 'stateRoot'
    | 'protectedLifecycleResultRoot'
    | 'identity'
    | 'projectId'
    | 'workspaceDataRoot'
    | 'runtimeDataRoot'
    | 'projectProjectionRoot'
    | 'profileDataRoot'
    | 'profileProjectionRoot'
  >,
): RuntimeCodeIntelligencePaths {
  const workspacePath = requireAbsolute(options.workspacePath, 'workspacePath');
  const stateRoot = requireAbsolute(options.stateRoot, 'stateRoot');
  const protectedRoot = requireAbsolute(
    options.protectedLifecycleResultRoot,
    'protectedLifecycleResultRoot',
  );
  const profileIdentity = runtimeProfileIdentity(options.identity);
  const profileKey = createHash('sha256').update(profileIdentity).digest('hex').slice(0, 24);
  const profileRoot = path.join(protectedRoot, 'marshal-memory', profileKey);
  const projectId = boundedIdentifier(options.projectId, 'projectId');
  const runtimeDataRoot = options.runtimeDataRoot
    ? requireAbsolute(options.runtimeDataRoot, 'runtimeDataRoot')
    : path.join(stateRoot, 'code-intelligence');
  const workspaceIdentity = resolveRuntimeCodeIntelligenceWorkspaceIdentity(workspacePath);
  return Object.freeze({
    runtimeDataRoot,
    runtimeProjectionRoot: path.join(runtimeDataRoot, 'runtime-projections'),
    workspaceDataRoot: options.workspaceDataRoot
      ? requireAbsolute(options.workspaceDataRoot, 'workspaceDataRoot')
      : workspaceRepositoryDataRoot(profileRoot, workspaceIdentity.repositoryCommonId),
    repositoryCommonId: workspaceIdentity.repositoryCommonId,
    worktreeId: workspaceIdentity.worktreeId,
    ...(workspaceIdentity.gitCommonDirectoryId
      ? { gitCommonDirectoryId: workspaceIdentity.gitCommonDirectoryId }
      : {}),
    projectProjectionRoot: options.projectProjectionRoot
      ? requireAbsolute(options.projectProjectionRoot, 'projectProjectionRoot')
      : projectProjectionDataRoot(profileRoot, projectId),
    profileRoot,
    profileDataRoot: options.profileDataRoot
      ? requireAbsolute(options.profileDataRoot, 'profileDataRoot')
      : path.join(profileRoot, 'quillstone'),
    profileProjectionRoot: options.profileProjectionRoot
      ? requireAbsolute(options.profileProjectionRoot, 'profileProjectionRoot')
      : path.join(profileRoot, 'profile-projections'),
  });
}


/**
 * The default code-intelligence service keeps only the workspace's identity and storage paths.
 * It stores nothing and indexes nothing: knowledge calls answer "Brain not configured" until a
 * Brain extension supplies the knowledge tools.
 */
export function createRuntimeCodeIntelligenceBundle(
  options: CreateRuntimeCodeIntelligenceBundleOptions,
): RuntimeCodeIntelligenceBundle {
  const projectId = boundedIdentifier(options.projectId, 'projectId');
  boundedIdentifier(options.workspaceId, 'workspaceId');
  const paths = createRuntimeCodeIntelligencePaths({ ...options, projectId });
  const index = new BrainNotConfiguredIndex();
  const workspace: RuntimeCodeIntelligenceWorkspace = {
    paths: () => paths,
    workspaceIndex: () => index,
    search: index.search.bind(index),
    context: index.context.bind(index),
    impact: index.impact.bind(index),
    detectChanges: index.detectChanges.bind(index),
    upsertDocument: index.upsertDocument.bind(index),
    removeDocument: index.removeDocument.bind(index),
    status: index.status.bind(index),
  };
  const service: RuntimeCodeIntelligenceService = {
    ...workspace,
    forContext: () => workspace,
    paths: () => paths,
    workspaceIndex: () => index,
    requestIndex: () => ({ index, dispose: async () => undefined }),
  };
  return { service, start() {}, async dispose() {} };
}

export function createRuntimeCodeIntelligenceProviders(
  options: CreateRuntimeCodeIntelligenceProvidersOptions,
): readonly CapabilityProvider[] {
  const providerId = 'marshal.brain-not-configured';
  if (options.excludedProviderIds?.has(providerId)) return [];
  const provider = createKnowledgeIndexProvider(new BrainNotConfiguredIndex(), providerId);
  return [{
    id: provider.id,
    ...(provider.version === undefined ? {} : { version: provider.version }),
    fallback: true,
    list: (context) => provider.list(context),
    ...(provider.get ? { get: (name, context) => provider.get!(name, context) } : {}),
    invoke: (name, input, context) => provider.invoke(name, input, context),
  }];
}

function boundedIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw new Error(`${name} must be a non-empty string of at most 1024 characters.`);
  }
  return value.trim();
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function requireAbsolute(value: string, name: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute.`);
  return path.resolve(value);
}

function configuredRepositoryIdDigest(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[REPOSITORY_ID_ENV]?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (!REPOSITORY_ID_PATTERN.test(value)) {
    throw new TypeError(`${REPOSITORY_ID_ENV} must be 1-128 characters of letters, digits, '.', '_', '-' or '/'.`);
  }
  return createHash('sha256').update(`repository-id:${value}`, 'utf8').digest('hex');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function resolveRuntimeCodeIntelligenceWorkspaceIdentity(
  workspacePath: string,
): RuntimeCodeIntelligenceWorkspaceIdentity {
  const requestedPath = requireAbsolute(workspacePath, 'workspacePath');
  const cacheKey = normalizePath(requestedPath);
  const cached = workspaceIdentityCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached.expiresAt > Date.now()) {
      workspaceIdentityCache.delete(cacheKey);
      workspaceIdentityCache.set(cacheKey, cached);
      return cached.identity;
    }
    workspaceIdentityCache.delete(cacheKey);
  }
  const canonicalRequestedPath = canonicalIdentityPath(requestedPath);
  const gitTopLevel = gitIdentityOutput(canonicalRequestedPath, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
  ]);
  if (gitTopLevel === undefined) {
    const fallbackDigest = identityPathDigest(canonicalRequestedPath);
    return Object.freeze({
      canonicalWorkspacePath: canonicalRequestedPath,
      repositoryCommonId: `directory-${fallbackDigest.slice(0, 24)}`,
      worktreeId: `workspace-${fallbackDigest.slice(0, 24)}`,
    });
  }
  const canonicalWorkspacePath = canonicalIdentityPath(gitTopLevel);
  const commonDirectory = gitIdentityOutput(canonicalWorkspacePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (commonDirectory === undefined || !path.isAbsolute(commonDirectory)) {
    throw new Error('Git did not return an absolute common directory.');
  }
  const commonDirectoryDigest =
    configuredRepositoryIdDigest() ?? identityPathDigest(canonicalIdentityPath(commonDirectory));
  const identity = Object.freeze({
    canonicalWorkspacePath,
    repositoryCommonId: `git-${commonDirectoryDigest.slice(0, 24)}`,
    worktreeId: `worktree-${identityPathDigest(canonicalWorkspacePath).slice(0, 24)}`,
    gitCommonDirectoryId: `git-common-${commonDirectoryDigest.slice(0, 24)}`,
  });
  workspaceIdentityCache.set(cacheKey, {
    expiresAt: Date.now() + WORKSPACE_IDENTITY_CACHE_TTL_MS,
    identity,
  });
  while (workspaceIdentityCache.size > MAX_WORKSPACE_IDENTITY_CACHE_ENTRIES) {
    const oldest = workspaceIdentityCache.keys().next().value;
    if (oldest === undefined) break;
    workspaceIdentityCache.delete(oldest);
  }
  return identity;
}

function runtimeProfileIdentity(identity: RuntimeHarnessIdentity): string {
  return identity.profileId
    ?? identity.userId
    ?? identity.installationId
    ?? `${identity.harnessId}:default`;
}

function workspaceRepositoryDataRoot(profileRoot: string, repositoryCommonId: string): string {
  return path.join(profileRoot, 'code-intelligence', 'repositories', repositoryCommonId);
}

function projectProjectionDataRoot(profileRoot: string, projectId: string): string {
  return path.join(
    profileRoot,
    'project-projections',
    identityValueDigest(projectId).slice(0, 24),
  );
}

interface WorkspaceIdentityCacheEntry {
  readonly expiresAt: number;
  readonly identity: RuntimeCodeIntelligenceWorkspaceIdentity;
}

const workspaceIdentityCache =
  new Map<string, WorkspaceIdentityCacheEntry>();

function canonicalIdentityPath(value: string): string {
  try {
    return realpathSync.native(path.resolve(value));
  } catch (error) {
    if (isMissingPathError(error)) return path.resolve(value);
    throw error;
  }
}

function gitIdentityOutput(cwd: string, argumentsList: readonly string[]): string | undefined {
  try {
    const output = execFileSync('git', ['-C', cwd, ...argumentsList], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length === 0 ? undefined : output;
  } catch (error) {
    if (isGitCommandFailure(error)) return undefined;
    throw error;
  }
}

function isGitCommandFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = Reflect.get(error, 'status');
  const code = Reflect.get(error, 'code');
  return typeof status === 'number' || code === 'ENOENT';
}

function isMissingPathError(
  error: unknown,
): error is NodeJS.ErrnoException & { readonly code: 'ENOENT' | 'ENOTDIR' } {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function identityPathDigest(value: string): string {
  return createHash('sha256').update(normalizePath(value), 'utf8').digest('hex');
}

function identityValueDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
