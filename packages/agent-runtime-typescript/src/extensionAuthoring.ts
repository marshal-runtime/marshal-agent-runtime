import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { builtinModules } from 'node:module';
import type {
  CapabilityDescriptor,
  CapabilityPermissionRequirement,
  InvocationContext,
  RuntimeCatalogEntry,
  RuntimeCatalogProvider,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeResourceContent,
  RuntimeResourceDescriptor,
  RuntimeScopedResourcePort,
} from '@marshal/agent-runtime-composer';
import {
  computeRuntimeExtensionIntegrity,
  type RuntimeExtensionManifest,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionInstallOptions,
  type RuntimeExtensionLifecycleService,
  type RuntimeExtensionOperationOptions,
  type RuntimeExtensionRecord,
  type RuntimeExtensionUiApplication,
  type RuntimeExtensionUiPlacement,
  type RuntimeExtensionPackageMetadata,
  RUNTIME_EXTENSION_MANIFEST_FILENAME,
  RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION,
  RUNTIME_EXTENSION_MODULE_FORMAT,
  validateRuntimeExtensionManifest,
  requireRuntimeExtensionIdentity,
  requireRuntimeExtensionVersion,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  type RuntimeExtensionCatalogSource,
} from '@marshal/agent-runtime-extensions';
import type { RuntimeServiceAccessor } from '@marshal/agent-runtime-composer';
import {
  compileInlineModule,
  type CompileInlineModuleResult,
} from './compiler.js';
import { cloneJson } from './json.js';
import {
  resolveTypeScriptModuleSource,
  type ArtifactSourceReader,
  type ResolvedTypeScriptModuleSource,
  type TypeScriptModuleSourceReference,
  type TypeScriptSourceResolverOptions,
} from './source.js';
import type {
  TypeScriptExecutionDiagnostic,
  TypeScriptModuleSourceIdentity,
  TypeScriptModuleSourceReceipt,
  TypeScriptModuleSourceKind,
  TypeScriptSourceProvenance,
} from './types.js';

const AUTHORING_PROTOCOL_VERSION = '1.0.0' as const;
const AUTHORING_PROVIDER_ID = 'marshal.typescript.extension.authoring';
const AUTHORING_SIDEcar_FILENAME = 'marshal-extension-authoring.json';
const AUTHORING_PACKAGE_FILENAME = 'package.json';
const AUTHORING_ENTRYPOINT = 'dist/index.cjs';
const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DRAFTS = 128;
const DEFAULT_MAX_CANDIDATES = 128;

const BUILTINS = new Set(
  builtinModules.map((name) => (name.startsWith('node:') ? name.slice(5) : name)),
);

export interface TypeScriptExtensionImportPolicy {
  readonly packages?: readonly string[];
  readonly builtins?: readonly string[];
}

export interface TypeScriptExtensionDeclaredContributions {
  readonly capabilityProviders?: readonly CapabilityDescriptor[];
  readonly catalogEntries?: readonly RuntimeCatalogEntry[];
  readonly resourceDescriptors?: readonly RuntimeResourceDescriptor[];
  readonly uiApplications?: readonly RuntimeExtensionUiApplication[];
  readonly uiPlacements?: readonly RuntimeExtensionUiPlacement[];
}

export interface TypeScriptExtensionDraftInput {
  readonly schemaVersion: 1;
  readonly draft: TypeScriptExtensionDraftPayload;
}

export interface TypeScriptExtensionDraftPatch {
  readonly schemaVersion: 1;
  readonly draft: TypeScriptExtensionDraftPatchPayload;
}

export interface TypeScriptExtensionDraftPayload {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly identity: string;
  readonly version: string;
  readonly source: TypeScriptModuleSourceReference;
  readonly provenance?: readonly TypeScriptSourceProvenance[];
  readonly imports?: TypeScriptExtensionImportPolicy;
  readonly permissions?: readonly CapabilityPermissionRequirement[];
  readonly contributions?: TypeScriptExtensionDeclaredContributions;
}

export interface TypeScriptExtensionDraftPatchPayload {
  readonly draftId: string;
  readonly identity?: string;
  readonly version?: string;
  readonly source?: TypeScriptModuleSourceReference;
  readonly provenance?: readonly TypeScriptSourceProvenance[];
  readonly imports?: TypeScriptExtensionImportPolicy;
  readonly permissions?: readonly CapabilityPermissionRequirement[];
  readonly contributions?: TypeScriptExtensionDeclaredContributions;
}

export interface TypeScriptExtensionDraftOwner {
  readonly principalId: string;
  readonly principalKind: string;
  readonly harnessId?: string;
  readonly installationId?: string;
  readonly profileId?: string;
  readonly userId?: string;
  readonly agentId?: string;
}

export interface TypeScriptExtensionDraftScope {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
}

export interface TypeScriptExtensionDraftSummary {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly identity: string;
  readonly version: string;
  readonly owner: TypeScriptExtensionDraftOwner;
  readonly scope: TypeScriptExtensionDraftScope;
  readonly revision: number;
  readonly source: {
    readonly kind: TypeScriptModuleSourceKind;
    readonly identifier: string;
    readonly uri?: string;
  };
  readonly imports: Required<TypeScriptExtensionImportPolicy>;
  readonly permissions: readonly CapabilityPermissionRequirement[];
  readonly contributions: TypeScriptExtensionDeclaredContributions;
  readonly resource: RuntimeResourceDescriptor;
}

export interface TypeScriptExtensionCandidateSummary {
  readonly schemaVersion: 1;
  readonly candidateDigest: string;
  readonly draftId: string;
  readonly identity: string;
  readonly version: string;
  readonly owner: TypeScriptExtensionDraftOwner;
  readonly scope: TypeScriptExtensionDraftScope;
  readonly packageRoot: string;
  readonly resource: RuntimeResourceDescriptor;
  readonly integrity: RuntimeExtensionInstallRequest['integrity'];
  readonly materializationStatus: 'created' | 'reused';
  readonly manifest: RuntimeExtensionManifest;
  readonly packageMetadata: RuntimeExtensionPackageMetadata;
  readonly source: TypeScriptModuleSourceReceipt;
  readonly compiler: {
    readonly codeDigest: string;
    readonly diagnostics: readonly TypeScriptExecutionDiagnostic[];
    readonly requiredBuiltins: readonly string[];
    readonly importedPackages: readonly string[];
    readonly localFiles: readonly { path: string; contentDigest: string; sizeBytes: number }[];
  };
  readonly sidecar: TypeScriptExtensionAuthoringSidecar;
}

export interface TypeScriptExtensionAuthoringSidecar {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly owner: TypeScriptExtensionDraftOwner;
  readonly scope: TypeScriptExtensionDraftScope;
  readonly revision: number;
  readonly source: TypeScriptModuleSourceReceipt;
  readonly provenance: readonly TypeScriptSourceProvenance[];
  readonly imports: Required<TypeScriptExtensionImportPolicy>;
  readonly permissions: readonly CapabilityPermissionRequirement[];
  readonly contributions: TypeScriptExtensionDeclaredContributions;
  readonly compilation: {
    readonly codeDigest: string;
    readonly diagnostics: readonly TypeScriptExecutionDiagnostic[];
    readonly requiredBuiltins: readonly string[];
    readonly importedPackages: readonly string[];
    readonly localFiles: readonly { path: string; contentDigest: string; sizeBytes: number }[];
  };
}

export interface TypeScriptExtensionAuthoringOptions
  extends Omit<TypeScriptSourceResolverOptions, 'workspaceRoot' | 'readArtifact'> {
  readonly workspaceRoot: string;
  readonly storageRoot: string;
  readonly workingDirectory?: string;
  readonly readArtifact?: ArtifactSourceReader;
  /** Existing runtime accessor; lifecycle is resolved for every mutation. */
  readonly services: RuntimeServiceAccessor;
  readonly maxDrafts?: number;
  readonly maxCandidates?: number;
}

export interface TypeScriptExtensionAuthoringServiceBundle {
  readonly provider: import('@marshal/agent-runtime-core').CapabilityProvider;
  readonly catalog: RuntimeCatalogProvider;
  readonly catalogSource: RuntimeExtensionCatalogSource;
  readonly resources: RuntimeScopedResourcePort;
  readonly dispose: () => Promise<void>;
}

type NormalizedDraftPayload = Omit<
  TypeScriptExtensionDraftPayload,
  'provenance' | 'imports' | 'permissions' | 'contributions'
> & {
  readonly provenance: readonly TypeScriptSourceProvenance[];
  readonly imports: Required<TypeScriptExtensionImportPolicy>;
  readonly permissions: readonly CapabilityPermissionRequirement[];
  readonly contributions: TypeScriptExtensionDeclaredContributions;
};

type NormalizedDraftPatchPayload = {
  readonly draftId: string;
  readonly identity?: string;
  readonly version?: string;
  readonly source?: TypeScriptModuleSourceReference;
  readonly provenance?: readonly TypeScriptSourceProvenance[];
  readonly imports?: Required<TypeScriptExtensionImportPolicy>;
  readonly permissions?: readonly CapabilityPermissionRequirement[];
  readonly contributions?: TypeScriptExtensionDeclaredContributions;
};

export class TypeScriptExtensionAuthoringError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'INVALID_DRAFT'
      | 'OWNER_MISMATCH'
      | 'SCOPE_MISMATCH'
      | 'NOT_FOUND'
      | 'ALREADY_EXISTS'
      | 'MATERIALIZATION_FAILED'
      | 'LIFECYCLE_UNAVAILABLE'
      | 'ACTIVATION_FAILED'
      | 'LIFECYCLE_FAILED'
      | 'RESOURCE_NOT_FOUND'
      | 'CANCELLED',
    cause?: unknown,
  ) {
    super(authoringErrorMessage(code), cause === undefined ? undefined : { cause });
    this.name = 'TypeScriptExtensionAuthoringError';
  }
}

interface DraftRecord {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly identity: string;
  readonly version: string;
  readonly owner: TypeScriptExtensionDraftOwner;
  readonly scope: TypeScriptExtensionDraftScope;
  readonly revision: number;
  readonly source: TypeScriptModuleSourceReference;
  readonly sourceIdentity: TypeScriptModuleSourceIdentity;
  readonly provenance: readonly TypeScriptSourceProvenance[];
  readonly imports: Required<TypeScriptExtensionImportPolicy>;
  readonly permissions: readonly CapabilityPermissionRequirement[];
  readonly contributions: TypeScriptExtensionDeclaredContributions;
  readonly resource: RuntimeResourceDescriptor;
  readonly sourceUri?: string;
  readonly materializedCandidateDigest?: string;
}

interface CandidateRecord extends TypeScriptExtensionCandidateSummary {
  readonly schemaVersion: 1;
  readonly request: RuntimeExtensionInstallRequest;
}

interface AuthoringInternalState {
  readonly draft: DraftRecord;
  readonly candidate?: CandidateRecord;
}

interface InstalledCandidateRelationship {
  readonly key: string;
  readonly candidateDigest: string;
}

const OPERATION_NAMES = [
  'typescript.extension.draft.create',
  'typescript.extension.draft.update',
  'typescript.extension.draft.get',
  'typescript.extension.draft.list',
  'typescript.extension.candidate.materialize',
  'typescript.extension.candidate.get',
  'typescript.extension.candidate.list',
  'typescript.extension.candidate.install',
  'typescript.extension.candidate.replace',
  'typescript.extension.candidate.remove',
] as const;

export class TypeScriptExtensionAuthoringService {
  readonly provider: import('@marshal/agent-runtime-core').CapabilityProvider;
  readonly catalog: RuntimeCatalogProvider;
  readonly catalogSource: RuntimeExtensionCatalogSource;
  readonly resources: RuntimeScopedResourcePort;
  private readonly options: Readonly<TypeScriptExtensionAuthoringOptions>;
  private readonly drafts = new Map<string, AuthoringInternalState>();
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly installedCandidates = new Map<string, string>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;

  constructor(options: TypeScriptExtensionAuthoringOptions) {
    this.options = Object.freeze({
      ...options,
      workspaceRoot: path.resolve(options.workspaceRoot),
      storageRoot: path.resolve(options.storageRoot),
      workingDirectory: path.resolve(options.workingDirectory ?? options.workspaceRoot),
      maxSourceBytes: positiveInteger(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES),
      maxDrafts: positiveInteger(options.maxDrafts, DEFAULT_MAX_DRAFTS),
      maxCandidates: positiveInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES),
    });
    const provider: import('@marshal/agent-runtime-core').CapabilityProvider = {
      id: AUTHORING_PROVIDER_ID,
      version: AUTHORING_PROTOCOL_VERSION,
      list: async (context) => this.listCapabilities(context),
      get: async (name, context) => this.getCapability(name, context),
      invoke: async (name, input, context) => ({
        output: await this.invoke(name as (typeof OPERATION_NAMES)[number], input, context),
      }),
    };
    const catalog: RuntimeCatalogProvider = {
      id: `${AUTHORING_PROVIDER_ID}.catalog`,
      list: async (context) => this.listCatalogEntries(context),
      get: async (id, context) => this.getCatalogEntry(id, context),
    };
    const catalogSource: RuntimeExtensionCatalogSource = {
      id: `${AUTHORING_PROVIDER_ID}.source`,
      label: 'Authored TypeScript extensions',
      order: 100,
      list: async (context, signal) => {
        await this.ensureLoaded();
        assertNotCancelled(context);
        const candidates = [...this.candidates.values()].filter((candidate) =>
          scopeOwnerMatches(candidate.owner, candidate.scope, context),
        );
        if (signal?.aborted) throw new TypeScriptExtensionAuthoringError('CANCELLED');
        return candidates.map((candidate) => ({
          id: candidate.candidateDigest,
          identity: candidate.identity,
          version: candidate.version,
          origin: 'authored-typescript' as const,
          title: `${candidate.identity}@${candidate.version}`,
          description: 'Agent-authored TypeScript extension candidate.',
          tags: ['typescript', 'authored'],
          metadata: {
            candidateDigest: candidate.candidateDigest,
            owner: candidate.owner,
            scope: candidate.scope,
          },
          request: candidate.request,
        }));
      },
    };
    const resources: RuntimeScopedResourcePort = {
      listResources: async (context) => this.listResources(context),
      readResource: async (uri, context) => this.readResource(uri, context),
    };
    this.provider = Object.freeze(provider);
    this.catalog = Object.freeze(catalog);
    this.catalogSource = Object.freeze(catalogSource);
    this.resources = Object.freeze(resources);
  }

  async createDraft(
    input: TypeScriptExtensionDraftInput,
    context: InvocationContext,
  ): Promise<TypeScriptExtensionDraftSummary> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    const normalized = this.normalizeDraftInput(input);
    const owner = ownerFrom(context);
    const scope = scopeFrom(context);
    const key = draftKey(owner, scope, normalized.draftId);
    if (this.drafts.has(key)) throw new TypeScriptExtensionAuthoringError('ALREADY_EXISTS');
    if (this.drafts.size >= this.options.maxDrafts!) {
      throw new TypeScriptExtensionAuthoringError('ALREADY_EXISTS');
    }
    const record: DraftRecord = {
      schemaVersion: 1,
      draftId: normalized.draftId,
      identity: normalized.identity,
      version: normalized.version,
      owner,
      scope,
      revision: 1,
      source: normalized.source,
      sourceIdentity: sourceIdentityFor(normalized.source),
      provenance: normalizeProvenance(normalized.provenance),
      imports: normalizeImports(normalized.imports),
      permissions: normalizePermissions(normalized.permissions),
      contributions: normalizeContributions(normalized.contributions),
      sourceUri: sourceUriFor(normalized.source),
      resource: draftResourceDescriptor(owner, scope, normalized.draftId),
    };
    this.drafts.set(key, { draft: record });
    await this.persist();
    return this.summarizeDraft(record);
  }

  async updateDraft(
    input: TypeScriptExtensionDraftPatch,
    context: InvocationContext,
  ): Promise<TypeScriptExtensionDraftSummary> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    const normalized = this.normalizeDraftPatch(input);
    const owner = ownerFrom(context);
    const scope = scopeFrom(context);
    const key = draftKey(owner, scope, normalized.draftId);
    const state = this.drafts.get(key);
    if (!state) throw new TypeScriptExtensionAuthoringError('NOT_FOUND');
    const draft = state.draft;
    const next: DraftRecord = {
      ...draft,
      revision: draft.revision + 1,
      identity: normalized.identity ?? draft.identity,
      version: normalized.version ?? draft.version,
      source: normalized.source ?? draft.source,
      sourceIdentity: normalized.source ? sourceIdentityFor(normalized.source) : draft.sourceIdentity,
      provenance: normalized.provenance === undefined ? draft.provenance : normalizeProvenance(normalized.provenance),
      imports: normalized.imports === undefined ? draft.imports : normalizeImports(normalized.imports),
      permissions: normalized.permissions === undefined ? draft.permissions : normalizePermissions(normalized.permissions),
      contributions: normalized.contributions === undefined
        ? draft.contributions
        : normalizeContributions(normalized.contributions),
      sourceUri: normalized.source ? sourceUriFor(normalized.source) : draft.sourceUri,
      resource: draftResourceDescriptor(owner, scope, normalized.draftId),
      materializedCandidateDigest: undefined,
    };
    this.drafts.set(key, { draft: next, candidate: state.candidate });
    await this.persist();
    return this.summarizeDraft(next);
  }

  async getDraft(input: { readonly schemaVersion: 1; readonly draftId: string }, context: InvocationContext): Promise<TypeScriptExtensionDraftSummary> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    const record = this.requireDraft(input.draftId, context);
    return this.summarizeDraft(record.draft);
  }

  async listDrafts(context: InvocationContext): Promise<readonly TypeScriptExtensionDraftSummary[]> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    return [...this.drafts.values()]
      .map((entry) => entry.draft)
      .filter((draft) => scopeOwnerMatches(draft.owner, draft.scope, context))
      .sort((left, right) => left.draftId.localeCompare(right.draftId))
      .map((draft) => this.summarizeDraft(draft));
  }

  async materializeCandidate(
    input: { readonly schemaVersion: 1; readonly draftId: string },
    context: InvocationContext,
  ): Promise<TypeScriptExtensionCandidateSummary> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    const record = this.requireDraft(input.draftId, context);
    const existing = record.draft.materializedCandidateDigest
      ? this.candidates.get(record.draft.materializedCandidateDigest)
      : undefined;
    if (existing) return this.summarizeCandidate(existing, 'reused');
    const candidate = await this.materialize(record.draft, context);
    this.drafts.set(draftKey(record.draft.owner, record.draft.scope, record.draft.draftId), {
      draft: {
        ...record.draft,
        materializedCandidateDigest: candidate.candidateDigest,
      },
      candidate,
    });
    this.candidates.set(candidate.candidateDigest, candidate);
    await this.persist();
    return this.summarizeCandidate(candidate);
  }

  async getCandidate(
    input: { readonly schemaVersion: 1; readonly candidateDigest: string },
    context: InvocationContext,
  ): Promise<TypeScriptExtensionCandidateSummary> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    const candidate = this.requireCandidate(input.candidateDigest, context);
    return this.summarizeCandidate(candidate);
  }

  async listCandidates(context: InvocationContext): Promise<readonly TypeScriptExtensionCandidateSummary[]> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    return [...this.candidates.values()]
      .filter((candidate) => scopeOwnerMatches(candidate.owner, candidate.scope, context))
      .sort((left, right) => left.candidateDigest.localeCompare(right.candidateDigest))
      .map((candidate) => this.summarizeCandidate(candidate));
  }

  async installCandidate(
    input: { readonly schemaVersion: 1; readonly candidateDigest: string },
    context: InvocationContext,
  ): Promise<RuntimeExtensionRecord> {
    await this.ensureLoaded();
    return this.lifecycleCall('install', input.candidateDigest, context);
  }

  async replaceCandidate(
    input: { readonly schemaVersion: 1; readonly candidateDigest: string },
    context: InvocationContext,
  ): Promise<RuntimeExtensionRecord> {
    await this.ensureLoaded();
    return this.lifecycleCall('replace', input.candidateDigest, context);
  }

  async removeCandidate(
    input: { readonly schemaVersion: 1; readonly candidateDigest: string },
    context: InvocationContext,
  ): Promise<void> {
    await this.ensureLoaded();
    await this.lifecycleCall('remove', input.candidateDigest, context);
  }

  async dispose(): Promise<void> {
    this.drafts.clear();
    this.candidates.clear();
    this.installedCandidates.clear();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        await fs.mkdir(this.options.storageRoot, { recursive: true });
        const statePath = path.join(this.options.storageRoot, 'authoring-state.json');
        try {
          const parsed: unknown = JSON.parse(await fs.readFile(statePath, 'utf8'));
          if (!isRecord(parsed) || !Array.isArray(parsed.drafts) || !Array.isArray(parsed.candidates)) {
            throw new Error('Invalid TypeScript authoring state.');
          }
          for (const value of parsed.drafts) {
            if (!isRecord(value) || !isRecord(value.draft)) continue;
            const draft = value.draft as unknown as DraftRecord;
            const candidate = isRecord(value.candidate)
              ? value.candidate as unknown as CandidateRecord : undefined;
            this.drafts.set(draftKey(draft.owner, draft.scope, draft.draftId), {
              draft,
              ...(candidate ? { candidate } : {}),
            });
          }
          for (const value of parsed.candidates) {
            if (isRecord(value) && typeof value.candidateDigest === 'string') {
              this.candidates.set(value.candidateDigest, value as unknown as CandidateRecord);
            }
          }
          if (Array.isArray(parsed.installedCandidates)) {
            for (const value of parsed.installedCandidates) {
              if (!isRecord(value) || typeof value.key !== 'string' || typeof value.candidateDigest !== 'string') {
                continue;
              }
              if (this.candidates.has(value.candidateDigest)) {
                this.installedCandidates.set(value.key, value.candidateDigest);
              }
            }
          }
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error;
        }
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  private async persist(): Promise<void> {
    const statePath = path.join(this.options.storageRoot, 'authoring-state.json');
    const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(this.options.storageRoot, { recursive: true });
    await fs.writeFile(
      temporary,
      `${stableJson({
        schemaVersion: 1,
        drafts: [...this.drafts.values()],
        candidates: [...this.candidates.values()],
        installedCandidates: [...this.installedCandidates.entries()]
          .map(([key, candidateDigest]): InstalledCandidateRelationship => ({ key, candidateDigest })),
      })}\n`,
      'utf8',
    );
    await fs.rename(temporary, statePath);
  }

  private async invoke(
    name: (typeof OPERATION_NAMES)[number],
    input: unknown,
    context: InvocationContext,
  ): Promise<unknown> {
    switch (name) {
      case 'typescript.extension.draft.create':
        return this.createDraft(this.requireInput(input, 'draft.create'), context);
      case 'typescript.extension.draft.update':
        return this.updateDraft(this.requirePatchInput(input), context);
      case 'typescript.extension.draft.get':
        return this.getDraft(this.requireDraftLookup(input), context);
      case 'typescript.extension.draft.list':
        return { drafts: await this.listDrafts(context) };
      case 'typescript.extension.candidate.materialize':
        return this.materializeCandidate(this.requireDraftLookup(input), context);
      case 'typescript.extension.candidate.get':
        return this.getCandidate(this.requireCandidateLookup(input), context);
      case 'typescript.extension.candidate.list':
        return { candidates: await this.listCandidates(context) };
      case 'typescript.extension.candidate.install':
        return { record: await this.installCandidate(this.requireCandidateLookup(input), context) };
      case 'typescript.extension.candidate.replace':
        return { record: await this.replaceCandidate(this.requireCandidateLookup(input), context) };
      case 'typescript.extension.candidate.remove':
        await this.removeCandidate(this.requireCandidateLookup(input), context);
        return { removed: true };
    }
    throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
  }

  private async materialize(
    draft: DraftRecord,
    context: InvocationContext,
  ): Promise<CandidateRecord> {
    await fs.mkdir(this.options.storageRoot, { recursive: true });
    const resolved = await this.resolveSource(draft);
    const compilation = await this.compileDraftSource(draft, resolved);
    const { packageJsonText, manifestText, sidecarText, sidecar } = this.buildMaterialization(
      draft,
      resolved,
      compilation,
    );
    const candidateDigest = digestMaterialization(
      packageJsonText,
      manifestText,
      compilation.code,
      sidecarText,
    );
    const packageRoot = candidatePackageRoot(this.options.storageRoot, candidateDigest);
    if (this.candidates.size >= this.options.maxCandidates! && !this.candidates.has(candidateDigest)) {
      throw new TypeScriptExtensionAuthoringError('ALREADY_EXISTS');
    }
    const candidate = await this.writeCandidate(
      packageRoot,
      draft,
      resolved,
      compilation,
      packageJsonText,
      manifestText,
      sidecarText,
      sidecar,
      candidateDigest,
    );
    return candidate;
  }

  private async writeCandidate(
    packageRoot: string,
    draft: DraftRecord,
    resolved: ResolvedTypeScriptModuleSource,
    compilation: CompileInlineModuleResult,
    packageJsonText: string,
    manifestText: string,
    sidecarText: string,
    sidecar: TypeScriptExtensionAuthoringSidecar,
    candidateDigest: string,
  ): Promise<CandidateRecord> {
    let created = false;
    await fs.mkdir(this.options.storageRoot, { recursive: true });
    let exists = false;
    try {
      await fs.access(packageRoot);
      exists = true;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    if (!exists) {
      created = true;
      const staging = await fs.mkdtemp(path.join(this.options.storageRoot, 'staging-'));
      const distRoot = path.join(staging, 'dist');
      await fs.mkdir(distRoot, { recursive: true });
      await writeUtf8(path.join(staging, AUTHORING_PACKAGE_FILENAME), `${packageJsonText}\n`);
      await writeUtf8(path.join(staging, RUNTIME_EXTENSION_MANIFEST_FILENAME), `${manifestText}\n`);
      await writeUtf8(path.join(distRoot, path.basename(AUTHORING_ENTRYPOINT)), compilation.code);
      await writeUtf8(path.join(staging, AUTHORING_SIDEcar_FILENAME), `${sidecarText}\n`);
      await fs.rename(staging, packageRoot);
    }
    const integrity = computeRuntimeExtensionIntegrity(packageRoot);
    const request: RuntimeExtensionInstallRequest = {
      packageRoot,
      integrity,
    };
    const manifest = validateRuntimeExtensionManifest(JSON.parse(manifestText));
    const packageMetadata: RuntimeExtensionPackageMetadata = {
      manifest,
      integrity,
      canonicalRoot: path.resolve(packageRoot),
      fileCount: 4,
      totalBytes: Buffer.byteLength(packageJsonText, 'utf8')
        + Buffer.byteLength(manifestText, 'utf8')
        + Buffer.byteLength(compilation.code, 'utf8')
        + Buffer.byteLength(sidecarText, 'utf8')
        + 4,
    };
    return {
      schemaVersion: 1,
      candidateDigest,
      draftId: draft.draftId,
      identity: draft.identity,
      version: draft.version,
      owner: draft.owner,
      scope: draft.scope,
      packageRoot,
      resource: candidateResourceDescriptor(candidateDigest, draft.identity, draft.version),
      integrity,
      materializationStatus: created ? 'created' : 'reused',
      manifest,
      packageMetadata,
      source: resolved.receipt,
      compiler: {
        codeDigest: sha256(compilation.code),
        diagnostics: compilation.diagnostics,
        requiredBuiltins: compilation.requiredBuiltins,
        importedPackages: compilation.importedPackages,
        localFiles: compilation.localFiles,
      },
      sidecar,
      request,
    };
  }

  private async resolveSource(draft: DraftRecord): Promise<ResolvedTypeScriptModuleSource> {
    return resolveTypeScriptModuleSource(draft.source, {
      workspaceRoot: this.options.workspaceRoot,
      maxSourceBytes: this.options.maxSourceBytes,
      readArtifact: this.options.readArtifact,
    });
  }

  private async compileDraftSource(
    draft: DraftRecord,
    resolved: ResolvedTypeScriptModuleSource,
  ): Promise<CompileInlineModuleResult> {
    const packages = normalizePackages(draft.imports.packages ?? []);
    const builtins = normalizeBuiltins(draft.imports.builtins ?? []);
    const result = await compileInlineModule({
      source: resolved.source,
      filename: resolved.filename,
      workingDirectory: this.options.workingDirectory!,
      mode: 'trusted',
      allowedPackages: new Set(packages),
      allowedBuiltins: new Set(builtins),
      sourceKind: resolved.identity.kind,
      workspaceRoot: this.options.workspaceRoot,
    });
    assertDeclaredImports(packages, builtins, result);
    return result;
  }

  private buildMaterialization(
    draft: DraftRecord,
    resolved: ResolvedTypeScriptModuleSource,
    compilation: CompileInlineModuleResult,
  ): {
    readonly packageJsonText: string;
    readonly manifestText: string;
    readonly sidecarText: string;
    readonly sidecar: TypeScriptExtensionAuthoringSidecar;
  } {
    const manifest = {
      schemaVersion: RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION,
      identity: draft.identity,
      version: draft.version,
      entrypoint: AUTHORING_ENTRYPOINT,
      moduleFormat: RUNTIME_EXTENSION_MODULE_FORMAT,
    } as const;
    const packageJson = {
      name: draft.identity,
      version: draft.version,
      type: 'commonjs',
      main: AUTHORING_ENTRYPOINT,
    } as const;
    const sourceProvenance = [
      ...(draft.provenance ?? []),
      ...(resolved.identity.provenance ?? []),
    ];
    const sidecar: TypeScriptExtensionAuthoringSidecar = {
      schemaVersion: 1,
      draftId: draft.draftId,
      owner: draft.owner,
      scope: draft.scope,
      revision: draft.revision,
      source: resolved.receipt,
      provenance: sourceProvenance,
      imports: draft.imports,
      permissions: draft.permissions,
      contributions: draft.contributions,
      compilation: {
        codeDigest: sha256(compilation.code),
        diagnostics: compilation.diagnostics,
        requiredBuiltins: compilation.requiredBuiltins,
        importedPackages: compilation.importedPackages,
        localFiles: compilation.localFiles,
      },
    };
    return {
      packageJsonText: stableJson(packageJson),
      manifestText: stableJson(manifest),
      sidecarText: stableJson(sidecar),
      sidecar,
    };
  }

  private summarizeDraft(draft: DraftRecord): TypeScriptExtensionDraftSummary {
    return {
      schemaVersion: 1,
      draftId: draft.draftId,
      identity: draft.identity,
      version: draft.version,
      owner: draft.owner,
      scope: draft.scope,
      revision: draft.revision,
      source: {
        kind: draft.source.kind,
        identifier: draft.sourceIdentity?.identifier ?? draft.source.kind,
        uri: draft.sourceIdentity?.uri,
      },
      imports: draft.imports,
      permissions: draft.permissions,
      contributions: draft.contributions,
      resource: draft.resource,
    };
  }

  private summarizeCandidate(
    candidate: CandidateRecord,
    materializationStatus: 'created' | 'reused' = candidate.materializationStatus,
  ): TypeScriptExtensionCandidateSummary {
    return {
      schemaVersion: candidate.schemaVersion,
      candidateDigest: candidate.candidateDigest,
      draftId: candidate.draftId,
      identity: candidate.identity,
      version: candidate.version,
      owner: candidate.owner,
      scope: candidate.scope,
      packageRoot: candidate.packageRoot,
      resource: candidate.resource,
      integrity: candidate.integrity,
      materializationStatus,
      manifest: candidate.manifest,
      packageMetadata: candidate.packageMetadata,
      source: candidate.source,
      compiler: candidate.compiler,
      sidecar: candidate.sidecar,
    };
  }

  private async lifecycleCall(
    operation: 'install' | 'replace',
    candidateDigest: string,
    context: InvocationContext,
  ): Promise<RuntimeExtensionRecord>;
  private async lifecycleCall(
    operation: 'remove',
    candidateDigest: string,
    context: InvocationContext,
  ): Promise<void>;
  private async lifecycleCall(
    operation: 'install' | 'replace' | 'remove',
    candidateDigest: string,
    context: InvocationContext,
  ): Promise<RuntimeExtensionRecord | void> {
    const candidate = this.requireCandidate(candidateDigest, context);
    assertNotCancelled(context);
    const lifecycle = this.options.services.tryGet(
      RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
    );
    if (!lifecycle) throw new TypeScriptExtensionAuthoringError('LIFECYCLE_UNAVAILABLE');
    const relationshipKey = installedCandidateKey(candidate, context);
    const previousDigest = this.installedCandidates.get(relationshipKey);
    const previous = lifecycle.get(candidate.identity);
    const previousCandidateDigest = previous
      ? previousDigest ?? this.findCandidateDigest(previous)
      : undefined;
    const previousCandidate = previousCandidateDigest
      ? this.candidates.get(previousCandidateDigest)
      : undefined;
    if (previous && !previousCandidate) {
      throw new TypeScriptExtensionAuthoringError(
        'LIFECYCLE_FAILED',
        new Error(`No authored candidate is available to restore ${candidate.identity}.`),
      );
    }
    let lifecycleCommitted = false;
    try {
      let result: RuntimeExtensionRecord | void;
      switch (operation) {
        case 'install':
          result = await lifecycle.install(candidate.request, { signal: context.signal });
          break;
        case 'replace':
          result = await lifecycle.update(candidate.identity, candidate.request, {
            signal: context.signal,
          });
          break;
        case 'remove':
          result = await lifecycle.remove(candidate.identity, { signal: context.signal });
          break;
      }
      lifecycleCommitted = true;
      // A cancellation observed after the lifecycle call must compensate the
      // completed mutation instead of persisting caller-rejected state.
      assertNotCancelled(context);
      if (operation === 'remove') {
        this.installedCandidates.delete(relationshipKey);
      } else {
        this.installedCandidates.set(relationshipKey, candidateDigest);
      }
      await this.persist();
      return result;
    } catch (error) {
      let compensationError: unknown;
      if (lifecycleCommitted) {
        try {
          await this.compensateLifecycle(lifecycle, candidate, previous, previousCandidate, error);
        } catch (rollbackError) {
          compensationError = rollbackError;
        }
      }
      if (this.installedCandidates.get(relationshipKey) !== previousDigest) {
        this.restoreRelationship(relationshipKey, previousDigest);
      }
      if (compensationError) throw compensationError;
      if (isCancelled(error, context.signal)) throw new TypeScriptExtensionAuthoringError('CANCELLED', error);
      if (isRuntimeExtensionError(error) && error.code === 'ACTIVATION_FAILED') {
        throw new TypeScriptExtensionAuthoringError('ACTIVATION_FAILED', error);
      }
      throw new TypeScriptExtensionAuthoringError('LIFECYCLE_FAILED', error);
    }
  }

  private findCandidateDigest(record: RuntimeExtensionRecord): string | undefined {
    return [...this.candidates.values()].find((candidate) =>
      candidate.identity === record.identity
      && candidate.version === record.version
      && candidate.integrity.algorithm === record.integrity.algorithm
      && candidate.integrity.domain === record.integrity.domain
      && candidate.integrity.value === record.integrity.value
    )?.candidateDigest;
  }

  private restoreRelationship(key: string, candidateDigest: string | undefined): void {
    if (candidateDigest === undefined) this.installedCandidates.delete(key);
    else this.installedCandidates.set(key, candidateDigest);
  }

  private async compensateLifecycle(
    lifecycle: RuntimeExtensionLifecycleService,
    candidate: CandidateRecord,
    previous: RuntimeExtensionRecord | undefined,
    previousCandidate: CandidateRecord | undefined,
    cause: unknown,
  ): Promise<void> {
    try {
      if (!previous) {
        await lifecycle.remove(candidate.identity);
      } else {
        if (!previousCandidate) throw new Error(`No authored candidate is available to restore ${candidate.identity}.`);
        const options: RuntimeExtensionInstallOptions = {
          enabled: previous.status === 'enabled',
        };
        if (candidate.identity === previous.identity) {
          await lifecycle.update(previous.identity, previousCandidate.request, options);
        } else {
          throw new Error(`Cannot restore mismatched extension identity ${previous.identity}.`);
        }
      }
    } catch (rollbackError) {
      throw new TypeScriptExtensionAuthoringError(
        'LIFECYCLE_FAILED',
        new AggregateError([cause, rollbackError], 'Authored lifecycle compensation failed.'),
      );
    }
  }

  private listCapabilities(context: InvocationContext): readonly CapabilityDescriptor[] {
    assertNotCancelled(context);
    const permissionsDraft = [
      {
        permission: 'runtime.typescript.extension.authoring.draft',
        reason: 'Creates and updates scoped extension drafts.',
        scope: 'workspace/project/session',
        risk: 'medium',
      },
    ] as const;
    const permissionsCandidate = [
      {
        permission: 'runtime.typescript.extension.authoring.candidate',
        reason: 'Materializes content-addressed extension candidates.',
        scope: 'workspace/project/session',
        risk: 'medium',
      },
    ] as const;
    const permissionsLifecycle = [
      {
        permission: 'runtime.typescript.extension.authoring.lifecycle',
        reason: 'Installs, replaces, or removes content-addressed extension candidates.',
        scope: 'workspace/project/session',
        risk: 'high',
      },
    ] as const;
    return OPERATION_NAMES.map((name) => capabilityFor(name, permissionsDraft, permissionsCandidate, permissionsLifecycle));
  }

  private getCapability(
    name: string,
    context: InvocationContext,
  ): CapabilityDescriptor | undefined {
    return this.listCapabilities(context).find((descriptor) => descriptor.name === name);
  }

  private async listCatalogEntries(
    context: InvocationContext,
  ): Promise<readonly RuntimeCatalogEntry[]> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    const entries: RuntimeCatalogEntry[] = [];
    for (const state of this.drafts.values()) {
      if (!scopeOwnerMatches(state.draft.owner, state.draft.scope, context)) continue;
      entries.push({
        id: state.draft.resource.uri,
        kind: 'resource',
        title: `${state.draft.identity}@${state.draft.version} draft`,
        description: 'Mutable agent-authored TypeScript extension draft.',
        tags: ['typescript', 'extension', 'authoring', 'draft'],
        action: { type: 'resource_read', uri: state.draft.resource.uri },
        metadata: {
          draftId: state.draft.draftId,
          revision: state.draft.revision,
          owner: state.draft.owner,
          scope: state.draft.scope,
        },
      });
      if (state.candidate) {
        entries.push(candidateCatalogEntry(state.candidate));
      }
    }
    for (const candidate of this.candidates.values()) {
      if (!scopeOwnerMatches(candidate.owner, candidate.scope, context)) continue;
      if (entries.some((entry) => entry.id === candidate.resource.uri)) continue;
      entries.push(candidateCatalogEntry(candidate));
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async getCatalogEntry(
    id: string,
    context: InvocationContext,
  ): Promise<RuntimeCatalogEntry | undefined> {
    const entries = await this.listCatalogEntries(context);
    return entries.find((entry) => entry.id === id);
  }

  private async listResources(
    context: InvocationContext,
  ): Promise<readonly RuntimeResourceDescriptor[]> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    const resources: RuntimeResourceDescriptor[] = [];
    for (const state of this.drafts.values()) {
      if (!scopeOwnerMatches(state.draft.owner, state.draft.scope, context)) continue;
      resources.push(state.draft.resource);
      if (state.candidate) resources.push(state.candidate.resource);
    }
    return resources.sort((left, right) => left.uri.localeCompare(right.uri));
  }

  private async readResource(
    uri: string,
    context: InvocationContext,
  ): Promise<RuntimeResourceContent> {
    await this.ensureLoaded();
    assertNotCancelled(context);
    const draft = [...this.drafts.values()].find((state) => state.draft.resource.uri === uri);
    if (draft && scopeOwnerMatches(draft.draft.owner, draft.draft.scope, context)) {
      return {
        uri,
        mimeType: 'application/json',
        text: `${stableJson(this.summarizeDraft(draft.draft))}\n`,
      };
    }
    const candidate = [...this.candidates.values()].find((state) => state.resource.uri === uri);
    if (candidate && scopeOwnerMatches(candidate.owner, candidate.scope, context)) {
      return {
        uri,
        mimeType: 'application/json',
        text: `${stableJson(this.summarizeCandidate(candidate))}\n`,
      };
    }
    throw new TypeScriptExtensionAuthoringError('RESOURCE_NOT_FOUND');
  }

  private requireDraft(draftId: string, context: InvocationContext): AuthoringInternalState {
    const owner = ownerFrom(context);
    const scope = scopeFrom(context);
    const state = this.drafts.get(draftKey(owner, scope, draftId));
    if (!state) throw new TypeScriptExtensionAuthoringError('NOT_FOUND');
    return state;
  }

  private requireCandidate(
    candidateDigest: string,
    context: InvocationContext,
  ): CandidateRecord {
    const candidate = this.candidates.get(candidateDigest);
    if (!candidate) throw new TypeScriptExtensionAuthoringError('NOT_FOUND');
    if (!scopeOwnerMatches(candidate.owner, candidate.scope, context)) {
      throw new TypeScriptExtensionAuthoringError('OWNER_MISMATCH');
    }
    return candidate;
  }

  private requireInput(value: unknown, label: string): TypeScriptExtensionDraftInput {
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.draft)) {
      throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
    }
    return { schemaVersion: 1, draft: this.normalizeDraftPayload(value.draft, label) };
  }

  private requirePatchInput(value: unknown): TypeScriptExtensionDraftPatch {
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.draft)) {
      throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
    }
    return { schemaVersion: 1, draft: this.normalizeDraftPatchPayload(value.draft) };
  }

  private requireDraftLookup(
    value: unknown,
  ): { readonly schemaVersion: 1; readonly draftId: string } {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.draftId !== 'string') {
      throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
    }
    return { schemaVersion: 1, draftId: boundedDraftId(value.draftId) };
  }

  private requireCandidateLookup(
    value: unknown,
  ): { readonly schemaVersion: 1; readonly candidateDigest: string } {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.candidateDigest !== 'string') {
      throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
    }
    return { schemaVersion: 1, candidateDigest: boundedDigest(value.candidateDigest) };
  }

  private normalizeDraftInput(input: TypeScriptExtensionDraftInput): TypeScriptExtensionDraftPayload {
    if (input.schemaVersion !== 1) throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
    return this.normalizeDraftPayload(input.draft, 'draft');
  }

  private normalizeDraftPatch(input: TypeScriptExtensionDraftPatch): TypeScriptExtensionDraftPatchPayload {
    if (input.schemaVersion !== 1) throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
    return this.normalizeDraftPatchPayload(input.draft);
  }

  private normalizeDraftPayload(
    draft: object,
    label: string,
  ): NormalizedDraftPayload {
    const record = draft as Record<string, unknown>;
    assertStrictKeys(record, [
      'schemaVersion',
      'draftId',
      'identity',
      'version',
      'source',
      'provenance',
      'imports',
      'permissions',
      'contributions',
    ], label);
    if (record.schemaVersion !== 1) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
    const draftId = boundedDraftId(record.draftId);
    const identity = requireRuntimeExtensionIdentity(record.identity);
    const version = requireRuntimeExtensionVersion(record.version);
    const source = normalizeSourceReference(record.source, this.options.maxSourceBytes!, label);
    const provenance = normalizeProvenance(record.provenance);
    const imports = normalizeImports(record.imports);
    const permissions = normalizePermissions(record.permissions);
    const contributions = normalizeContributions(record.contributions);
    return {
      schemaVersion: 1,
      draftId,
      identity,
      version,
      source,
      provenance,
      imports,
      permissions,
      contributions,
    };
  }

  private normalizeDraftPatchPayload(
    draft: object,
  ): NormalizedDraftPatchPayload {
    const record = draft as Record<string, unknown>;
    assertStrictKeys(record, [
      'draftId',
      'identity',
      'version',
      'source',
      'provenance',
      'imports',
      'permissions',
      'contributions',
    ], 'draft patch');
    const draftId = boundedDraftId(record.draftId);
    return {
      draftId,
      ...(typeof record.identity === 'string' ? { identity: requireRuntimeExtensionIdentity(record.identity) } : {}),
      ...(typeof record.version === 'string' ? { version: requireRuntimeExtensionVersion(record.version) } : {}),
      ...(record.source !== undefined ? { source: normalizeSourceReference(record.source, this.options.maxSourceBytes!, 'draft source') } : {}),
      ...(record.provenance !== undefined ? { provenance: normalizeProvenance(record.provenance) } : {}),
      ...(record.imports !== undefined ? { imports: normalizeImports(record.imports) } : {}),
      ...(record.permissions !== undefined ? { permissions: normalizePermissions(record.permissions) } : {}),
      ...(record.contributions !== undefined ? { contributions: normalizeContributions(record.contributions) } : {}),
    };
  }
}

export function createTypeScriptExtensionAuthoringService(
  options: TypeScriptExtensionAuthoringOptions,
): TypeScriptExtensionAuthoringService {
  return new TypeScriptExtensionAuthoringService(options);
}

export function createTypeScriptExtensionAuthoringBundle(
  options: TypeScriptExtensionAuthoringOptions,
): TypeScriptExtensionAuthoringServiceBundle {
  const service = createTypeScriptExtensionAuthoringService(options);
  return {
    provider: service.provider,
    catalog: service.catalog,
    catalogSource: service.catalogSource,
    resources: service.resources,
    dispose: () => service.dispose(),
  };
}

export function createTypeScriptExtensionAuthoringProvider(
  options: TypeScriptExtensionAuthoringOptions,
): import('@marshal/agent-runtime-core').CapabilityProvider {
  return createTypeScriptExtensionAuthoringService(options).provider;
}

function capabilityFor(
  name: (typeof OPERATION_NAMES)[number],
  draftPermissions: readonly CapabilityPermissionRequirement[],
  candidatePermissions: readonly CapabilityPermissionRequirement[],
  lifecyclePermissions: readonly CapabilityPermissionRequirement[],
): CapabilityDescriptor {
  const common = {
    protocolVersion: AUTHORING_PROTOCOL_VERSION,
    version: AUTHORING_PROTOCOL_VERSION,
    description: operationDescription(name),
    outputSchema: {
      type: 'object',
      additionalProperties: true,
    },
  } as const;
  switch (name) {
    case 'typescript.extension.draft.create':
    case 'typescript.extension.draft.update':
      return {
        ...common,
        name,
        title: 'Manage an extension draft',
        permissions: draftPermissions,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion', 'draft'],
          properties: {
            schemaVersion: { const: 1 },
            draft: { type: 'object', additionalProperties: true },
          },
        },
      };
    case 'typescript.extension.draft.get':
    case 'typescript.extension.draft.list':
      return {
        ...common,
        name,
        title: 'Read scoped extension drafts',
        permissions: draftPermissions,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion'],
          properties: {
            schemaVersion: { const: 1 },
            draftId: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      };
    case 'typescript.extension.candidate.materialize':
    case 'typescript.extension.candidate.get':
    case 'typescript.extension.candidate.list':
      return {
        ...common,
        name,
        title: 'Manage extension candidates',
        permissions: candidatePermissions,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion'],
          properties: {
            schemaVersion: { const: 1 },
            draftId: { type: 'string', minLength: 1, maxLength: 128 },
            candidateDigest: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      };
    case 'typescript.extension.candidate.install':
    case 'typescript.extension.candidate.replace':
    case 'typescript.extension.candidate.remove':
      return {
        ...common,
        name,
        title: 'Delegate extension lifecycle operations',
        permissions: lifecyclePermissions,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion', 'candidateDigest'],
          properties: {
            schemaVersion: { const: 1 },
            candidateDigest: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      };
  }
  throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
}

function operationDescription(name: (typeof OPERATION_NAMES)[number]): string {
  switch (name) {
    case 'typescript.extension.draft.create':
      return 'Create a mutable, scope-isolated TypeScript extension draft with explicit source, provenance, imports, permissions, and declared contributions.';
    case 'typescript.extension.draft.update':
      return 'Update a mutable, scope-isolated TypeScript extension draft without changing host-derived ownership.';
    case 'typescript.extension.draft.get':
      return 'Read a single scoped extension draft.';
    case 'typescript.extension.draft.list':
      return 'List drafts visible to the current principal and scope.';
    case 'typescript.extension.candidate.materialize':
      return 'Materialize a deterministic content-addressed extension candidate root with package.json, runtime-extension.json, dist/index.cjs, and a sidecar.';
    case 'typescript.extension.candidate.get':
      return 'Read a single materialized extension candidate.';
    case 'typescript.extension.candidate.list':
      return 'List candidates visible to the current principal and scope.';
    case 'typescript.extension.candidate.install':
      return 'Install a materialized candidate through the canonical extension lifecycle service.';
    case 'typescript.extension.candidate.replace':
      return 'Replace an installed extension version through the canonical lifecycle service.';
    case 'typescript.extension.candidate.remove':
      return 'Remove an installed extension through the canonical lifecycle service.';
  }
  throw new TypeScriptExtensionAuthoringError('INVALID_REQUEST');
}

function draftResourceDescriptor(
  owner: TypeScriptExtensionDraftOwner,
  scope: TypeScriptExtensionDraftScope,
  draftId: string,
): RuntimeResourceDescriptor {
  return {
    uri: resourceUri('draft', draftKey(owner, scope, draftId)),
    name: `Extension draft ${draftId}`,
    description: 'Mutable extension draft metadata.',
    mimeType: 'application/json',
  };
}

function candidateResourceDescriptor(
  candidateDigest: string,
  identity: string,
  version: string,
): RuntimeResourceDescriptor {
  return {
    uri: resourceUri('candidate', candidateDigest),
    name: `Extension candidate ${identity}@${version}`,
    description: 'Immutable content-addressed extension candidate metadata.',
    mimeType: 'application/json',
  };
}

function resourceUri(kind: 'draft' | 'candidate', key: string): string {
  return `runtime-extension-authoring://${kind}/${key}`;
}

function candidateCatalogEntry(candidate: CandidateRecord): RuntimeCatalogEntry {
  return {
    id: candidate.resource.uri,
    kind: 'resource',
    title: `${candidate.identity}@${candidate.version} candidate`,
    description: 'Immutable content-addressed extension candidate.',
    tags: ['typescript', 'extension', 'authoring', 'candidate'],
    action: { type: 'resource_read', uri: candidate.resource.uri },
    metadata: {
      candidateDigest: candidate.candidateDigest,
      draftId: candidate.draftId,
      owner: candidate.owner,
      scope: candidate.scope,
      integrity: candidate.integrity,
    },
  };
}

function candidatePackageRoot(storageRoot: string, candidateDigest: string): string {
  return path.join(storageRoot, candidateDigest.replace(/:/g, '-'));
}

function installedCandidateKey(
  candidate: Pick<CandidateRecord, 'owner' | 'scope' | 'identity'>,
  context: InvocationContext,
): string {
  return sha256(stableJson({
    owner: candidate.owner,
    scope: candidate.scope,
    identity: candidate.identity,
    principal: ownerFrom(context),
    invocationScope: scopeFrom(context),
  }));
}

function sourceUriFor(source: TypeScriptModuleSourceReference): string | undefined {
  switch (source.kind) {
    case 'inline':
      return undefined;
    case 'workspace_file':
      return `workspace://${source.path}`;
    case 'artifact':
      return `artifact://${source.scope ?? 'session'}/${source.path}`;
  }
  throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
}

function sourceIdentityFor(source: TypeScriptModuleSourceReference): TypeScriptModuleSourceIdentity {
  switch (source.kind) {
    case 'inline':
      return {
        kind: 'inline',
        identifier: source.filename ?? 'inline-module.ts',
      };
    case 'workspace_file':
      return {
        kind: 'workspace_file',
        identifier: source.path,
        uri: `workspace://${source.path}`,
      };
    case 'artifact':
      return {
        kind: 'artifact',
        identifier: `${source.scope ?? 'session'}:${source.path}`,
        uri: sourceUriFor(source),
      };
  }
  throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
}

function ownerFrom(context: InvocationContext): TypeScriptExtensionDraftOwner {
  return {
    principalId: boundedText(context.principal?.id, 'principal id', 256),
    principalKind: boundedText(context.principal?.kind ?? 'unknown', 'principal kind', 128),
    ...(context.identity?.harnessId ? { harnessId: boundedText(context.identity.harnessId, 'harness id', 128) } : {}),
    ...(context.identity?.installationId ? { installationId: boundedText(context.identity.installationId, 'installation id', 128) } : {}),
    ...(context.identity?.profileId ? { profileId: boundedText(context.identity.profileId, 'profile id', 128) } : {}),
    ...(context.identity?.userId ? { userId: boundedText(context.identity.userId, 'user id', 128) } : {}),
    ...(context.identity?.agentId ? { agentId: boundedText(context.identity.agentId, 'agent id', 128) } : {}),
  };
}

function scopeFrom(context: InvocationContext): TypeScriptExtensionDraftScope {
  if (!context.scope || (
    context.scope.workspaceId === undefined
    && context.scope.projectId === undefined
    && context.scope.sessionId === undefined
  )) {
    throw new TypeScriptExtensionAuthoringError('SCOPE_MISMATCH');
  }
  return {
    ...(context.scope.workspaceId ? { workspaceId: boundedText(context.scope.workspaceId, 'workspace id', 256) } : {}),
    ...(context.scope.projectId ? { projectId: boundedText(context.scope.projectId, 'project id', 256) } : {}),
    ...(context.scope.sessionId ? { sessionId: boundedText(context.scope.sessionId, 'session id', 256) } : {}),
  };
}

function scopeOwnerMatches(
  owner: TypeScriptExtensionDraftOwner,
  scope: TypeScriptExtensionDraftScope,
  context: InvocationContext,
): boolean {
  if (!context.principal?.id || !context.scope) return false;
  const nextOwner = ownerFrom(context);
  const nextScope = scopeFrom(context);
  return stableJson(owner) === stableJson(nextOwner) && stableJson(scope) === stableJson(nextScope);
}

function draftKey(
  owner: TypeScriptExtensionDraftOwner,
  scope: TypeScriptExtensionDraftScope,
  draftId: string,
): string {
  return sha256(stableJson({ owner, scope, draftId }));
}

function boundedDraftId(value: unknown): string {
  return boundedText(value, 'draft id', 128, /^[A-Za-z0-9._/-]+$/);
}

function boundedDigest(value: unknown): string {
  return boundedText(value, 'candidate digest', 256, /^[A-Za-z0-9:+/_-]+$/);
}

function boundedText(
  value: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT', new Error(`${label} must be a bounded string.`));
  }
  if (pattern && !pattern.test(value)) {
    throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT', new Error(`${label} contains invalid characters.`));
  }
  return value;
}

function boundedSourceText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  }
  return value;
}

function normalizeSourceReference(
  value: unknown,
  maxSourceBytes: number,
  label: string,
): TypeScriptModuleSourceReference {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  }
  switch (value.kind) {
    case 'inline': {
      assertStrictKeys(value, ['kind', 'source', 'filename', 'export'], label);
      const source = boundedSourceText(value.source, maxSourceBytes);
      const filename = value.filename === undefined ? undefined : validatePortableModulePath(value.filename, 'filename');
      const exported = value.export === undefined ? undefined : validateExportName(value.export);
      return {
        kind: 'inline',
        source,
        ...(filename ? { filename } : {}),
        ...(exported ? { export: exported } : {}),
      };
    }
    case 'workspace_file': {
      assertStrictKeys(value, ['kind', 'path', 'export'], label);
      const sourcePath = validatePortableModulePath(value.path, 'path');
      const exported = value.export === undefined ? undefined : validateExportName(value.export);
      return {
        kind: 'workspace_file',
        path: sourcePath,
        ...(exported ? { export: exported } : {}),
      };
    }
    case 'artifact': {
      assertStrictKeys(value, ['kind', 'path', 'scope', 'export'], label);
      const sourcePath = validatePortableModulePath(value.path, 'path');
      const scope = value.scope === undefined
        ? undefined
        : validateArtifactScope(value.scope);
      const exported = value.export === undefined ? undefined : validateExportName(value.export);
      return {
        kind: 'artifact',
        path: sourcePath,
        ...(scope ? { scope } : {}),
        ...(exported ? { export: exported } : {}),
      };
    }
    default:
      throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  }
}

function normalizeProvenance(
  value: unknown,
): readonly TypeScriptSourceProvenance[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.source !== 'string') throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
    return cloneJson(entry, 'provenance') as unknown as TypeScriptSourceProvenance;
  });
}

function normalizeImports(
  value: unknown,
): Required<TypeScriptExtensionImportPolicy> {
  if (value === undefined) return { packages: [], builtins: [] };
  if (!isRecord(value)) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  assertStrictKeys(value, ['packages', 'builtins'], 'imports');
  return {
    packages: normalizePackages(value.packages ?? []),
    builtins: normalizeBuiltins(value.builtins ?? []),
  };
}

function normalizePackages(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  const seen = new Set<string>();
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
    const normalized = entry === '*' ? '*' : requireRuntimeExtensionIdentity(entry);
    if (seen.has(normalized)) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
    seen.add(normalized);
    return normalized;
  });
}

function normalizeBuiltins(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  const seen = new Set<string>();
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
    const normalized = entry === '*' ? '*' : normalizeBuiltin(entry);
    if (seen.has(normalized)) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
    seen.add(normalized);
    return normalized;
  });
}

function normalizeBuiltin(value: string): string {
  const name = value.startsWith('node:') ? value.slice(5) : value;
  if (!BUILTINS.has(name)) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  return name;
}

function normalizePermissions(
  value: unknown,
): readonly CapabilityPermissionRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.permission !== 'string') throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
    return cloneJson(entry, 'permission') as unknown as CapabilityPermissionRequirement;
  });
}

function normalizeContributions(
  value: unknown,
): TypeScriptExtensionDeclaredContributions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  assertStrictKeys(value, [
    'capabilityProviders',
    'catalogEntries',
    'resourceDescriptors',
    'uiApplications',
    'uiPlacements',
  ], 'contributions');
  return cloneJson(value, 'contributions') as TypeScriptExtensionDeclaredContributions;
}

function validatePortableModulePath(value: unknown, label: string): string {
  const text = boundedText(value, label, 512, /^[A-Za-z0-9@._+\-/]+$/);
  if (path.isAbsolute(text) || text.includes('\\') || text.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  }
  return text;
}

function validateExportName(value: unknown): string {
  const text = boundedText(value, 'export', 128, /^[A-Za-z_$][\w$]*$/);
  return text;
}

function validateArtifactScope(value: unknown): 'workspace' | 'project' | 'session' {
  if (value !== 'workspace' && value !== 'project' && value !== 'session') {
    throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
  }
  return value;
}

function assertStrictKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT', new Error(`${label} contains unexpected key "${key}".`));
  }
}

function assertDeclaredImports(
  packages: readonly string[],
  builtins: readonly string[],
  compilation: CompileInlineModuleResult,
): void {
  for (const name of compilation.importedPackages) {
    if (!(packages.includes('*') || packages.includes(name))) {
      throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT', new Error(`Package import "${name}" was not declared.`));
    }
  }
  for (const name of compilation.requiredBuiltins) {
    if (!(builtins.includes('*') || builtins.includes(name))) {
      throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT', new Error(`Builtin import "${name}" was not declared.`));
    }
  }
}

function digestMaterialization(
  packageJsonText: string,
  manifestText: string,
  bundleText: string,
  sidecarText: string,
): string {
  return sha256(stableJson([
    { path: AUTHORING_PACKAGE_FILENAME, text: packageJsonText },
    { path: RUNTIME_EXTENSION_MANIFEST_FILENAME, text: manifestText },
    { path: AUTHORING_ENTRYPOINT, text: bundleText },
    { path: AUTHORING_SIDEcar_FILENAME, text: sidecarText },
  ]));
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeScriptExtensionAuthoringError('INVALID_DRAFT');
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function authoringErrorMessage(
  code:
    | 'INVALID_REQUEST'
    | 'INVALID_DRAFT'
    | 'OWNER_MISMATCH'
    | 'SCOPE_MISMATCH'
    | 'NOT_FOUND'
    | 'ALREADY_EXISTS'
    | 'MATERIALIZATION_FAILED'
    | 'LIFECYCLE_UNAVAILABLE'
    | 'ACTIVATION_FAILED'
    | 'LIFECYCLE_FAILED'
    | 'RESOURCE_NOT_FOUND'
    | 'CANCELLED',
): string {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'INVALID_DRAFT':
      return 'The extension authoring request is invalid.';
    case 'OWNER_MISMATCH':
      return 'The requested draft or candidate is owned by a different principal.';
    case 'SCOPE_MISMATCH':
      return 'The requested draft or candidate is outside the current workspace/project/session scope.';
    case 'NOT_FOUND':
      return 'The requested draft or candidate was not found.';
    case 'ALREADY_EXISTS':
      return 'The requested draft or candidate already exists.';
    case 'MATERIALIZATION_FAILED':
      return 'The extension candidate could not be materialized.';
    case 'LIFECYCLE_UNAVAILABLE':
      return 'The Runtime extension lifecycle service is not registered.';
    case 'ACTIVATION_FAILED':
      return 'The extension candidate failed to activate.';
    case 'LIFECYCLE_FAILED':
      return 'The extension lifecycle operation failed.';
    case 'RESOURCE_NOT_FOUND':
      return 'The requested authoring resource was not found.';
    case 'CANCELLED':
      return 'The authoring operation was cancelled.';
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNotCancelled(context: InvocationContext): void {
  if (context.signal?.aborted) throw new TypeScriptExtensionAuthoringError('CANCELLED');
}

function isCancelled(error: unknown, signal: InvocationContext['signal']): boolean {
  return Boolean(signal?.aborted)
    || (error instanceof TypeScriptExtensionAuthoringError && error.code === 'CANCELLED');
}

function isRuntimeExtensionError(error: unknown): error is { readonly code: string } {
  return isRecord(error) && typeof error.code === 'string';
}

async function ensureDirectory(root: string): Promise<boolean> {
  await fs.mkdir(root, { recursive: true });
  return true;
}

async function writeUtf8(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: 'utf8' });
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
