import type {
  CapabilityDescriptor,
  CapabilityProvider,
  InvocationContext,
  JsonSchema,
} from '@marshal/agent-runtime-core';
import {
  PROTOCOL_VERSION,
  assertRecord,
  boundedInteger,
  createProvider,
  requireString,
  result,
} from '@marshal/agent-runtime-provider-kit';

import {
  CREATED_AFTER_SCHEMA,
  CREATED_BEFORE_SCHEMA,
  parseMemoryDateWindow,
  withinMemoryDateWindow,
  type MemoryDateWindow,
} from './memory-date-filter.js';
import { readTogether } from './readBatch.js';
import { accessPrincipals, type AccessPrincipals } from './access.js';

export type KnowledgeNodeKind = 'memory' | 'code_file' | 'symbol' | 'execution_flow' | 'evidence' | 'entity';

/** Who may read an entity or a link: everyone, or exactly these lower-case work emails. */
export type KnowledgeAudience = 'public' | readonly string[];

/** How one LINK edge was found, who asserted it, and who may see it. */
export interface KnowledgeLinkReference {
  readonly label: string;
  readonly method: string;
  readonly source: string;
  readonly status: 'recorded' | 'suggested' | 'accepted';
  readonly confidence: number;
  readonly count?: number;
  readonly confirmedBy?: string;
  readonly scope: KnowledgeAudience;
}

export type KnowledgeEdgeType =
  | 'APPLIES_TO'
  | 'DEPENDS_ON'
  | 'RELATED_TO'
  | 'CONTRADICTS'
  | 'SUPERSEDES'
  | 'DERIVED_FROM'
  | 'CONTAINS'
  | 'IMPORTS'
  | 'CALLS'
  | 'IMPLEMENTS'
  | 'PARTICIPATES_IN';

export type KnowledgeTarget =
  | { readonly kind: 'memory'; readonly id: string }
  | { readonly kind: 'code'; readonly path: string; readonly symbol?: string }
  | { readonly kind: 'node'; readonly id: string };

export interface NormalizedKnowledgeMemoryTarget {
  readonly memoryId: string;
  readonly routedId: string;
  readonly route?: string;
}

export interface KnowledgeNodeReference {
  readonly id: string;
  readonly kind: KnowledgeNodeKind;
  readonly name: string;
  readonly path?: string;
  readonly symbol?: string;
  readonly memoryId?: string;
  readonly scope?: string;
  readonly state?: 'active' | 'superseded' | 'archived';
  /** Memory nodes: when the memory was first stated (UTC ISO timestamp), when known. */
  readonly createdAt?: string;
  /** User memories: preference, fact, decision or context. */
  readonly category?: 'preference' | 'fact' | 'decision' | 'context';
  readonly resolved?: boolean;
  /** Entity nodes: the entity type (ticket, pull_request, person, meeting, meeting_item). */
  readonly entityKind?: string;
  /** Entity nodes: who may read the entity. */
  readonly audience?: KnowledgeAudience;
  /** Entity nodes: the typed fields the entity declares. */
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly url?: string;
  /** The access labels stored on the node; absent means staff-only. The caller already holds one of them. */
  readonly access?: readonly string[];
}

export interface KnowledgeExplanationPath {
  readonly nodes: readonly KnowledgeNodeReference[];
  readonly edges: readonly KnowledgeEdgeType[];
  readonly directions: readonly ('inbound' | 'outbound')[];
  readonly explanation: string;
  /** One entry per edge: the link attributes of an entity edge, null for every other edge. */
  readonly links?: readonly (KnowledgeLinkReference | null)[];
}

/** The nodes of one code file that matched a `granularity: 'file'` search, best first (at most three ids). */
export interface KnowledgeFileMatch {
  readonly path: string;
  readonly nodeIds: readonly string[];
  /** How many nodes of the file matched. */
  readonly nodeCount: number;
}

export type KnowledgeSearchGranularity = 'node' | 'file';

export interface KnowledgeSearchHit {
  readonly node: KnowledgeNodeReference;
  readonly rank: number;
  /** Engine/fusion score retained for protected replay and ranking diagnostics. */
  readonly score?: number;
  readonly sourceScores?: readonly {
    readonly source: string;
    readonly rank: number;
    readonly score: number;
  }[];
  readonly location?: string;
  /** Code hits: 1-based first line of the passage that answers the query. */
  readonly line?: number;
  /** Code hits: last line of that passage. */
  readonly endLine?: number;
  /** Code hits: the matched outline entry (e.g. `variable github_config_url`), else documentation and signature. */
  readonly summary?: string;
  /** One to three lines of the hit's own text where it answers the query. */
  readonly snippet?: string;
  /** Code hits of a `granularity: 'file'` search: the file's matching nodes; `node` is the best of them. */
  readonly fileMatch?: KnowledgeFileMatch;
  /** Present with `debug: true`. */
  readonly explanationPaths?: readonly KnowledgeExplanationPath[];
}

export interface KnowledgeSearchResult {
  readonly hits: readonly KnowledgeSearchHit[];
  readonly generation: number;
  readonly generationVector?: readonly KnowledgeGenerationVectorEntry[];
  readonly truncated: boolean;
  /** Routes that failed or were unavailable, with the reason; their results are missing. */
  readonly routeFailures?: readonly string[];
  /** Why answered results may be incomplete (e.g. a degraded search mode). */
  readonly incompleteReasons?: readonly string[];
}

export interface KnowledgeGenerationVectorEntry {
  readonly route: string;
  readonly generation: number;
  readonly vectorGeneration: string | null;
}

export interface KnowledgeContextResult {
  readonly target: KnowledgeNodeReference | null;
  readonly nodes: readonly KnowledgeNodeReference[];
  readonly paths: readonly KnowledgeExplanationPath[];
  readonly generation: number;
  readonly truncated: boolean;
}

/** Calls to the target's name the indexer left unresolved or ambiguous, summed over the target's callables. */
export interface KnowledgeImpactGaps {
  readonly callables: number;
  readonly covered: number;
  readonly unresolvedCalls: number;
  readonly ambiguousCalls: number;
}

export interface KnowledgeImpactResult {
  readonly target: KnowledgeNodeReference | null;
  /** Absent when the target has no callable, or the index does not report call resolution. */
  readonly gaps?: KnowledgeImpactGaps;
  readonly nodes: readonly KnowledgeNodeReference[];
  readonly paths: readonly KnowledgeExplanationPath[];
  readonly direction: 'inbound' | 'outbound' | 'both';
  readonly maxDepth: number;
  readonly generation: number;
  readonly truncated: boolean;
}

export interface KnowledgeChangeResult {
  readonly changedPaths: readonly string[];
  readonly affected: readonly KnowledgeNodeReference[];
  readonly paths: readonly KnowledgeExplanationPath[];
  readonly generation: number;
  readonly truncated: boolean;
}

export interface KnowledgeQueryRelationFilter {
  readonly type: string;
  readonly direction: 'incoming' | 'outgoing' | 'both';
  readonly absent?: boolean;
  readonly min?: number;
  readonly otherName?: string;
  readonly otherKinds?: readonly string[];
  readonly otherPathPrefix?: string;
}

/** An exhaustive filter over every code node of the index; it returns all matches where search returns the best ranked ones. */
export interface KnowledgeQueryRequest {
  readonly nodeKinds?: readonly string[];
  readonly languages?: readonly string[];
  readonly repositories?: readonly string[];
  readonly pathPrefix?: string;
  readonly names?: readonly string[];
  readonly nameContains?: string;
  readonly outline?: { readonly namePrefixes?: readonly string[]; readonly name: string };
  readonly relations?: readonly KnowledgeQueryRelationFilter[];
  readonly groupBy?: 'kind' | 'language' | 'repositoryId' | 'directory';
  readonly directoryDepth?: number;
  readonly after?: string;
  readonly limit?: number;
}

export interface KnowledgeQueryEntry {
  readonly node: KnowledgeNodeReference;
  readonly table: string;
  readonly language?: string;
}

export interface KnowledgeQueryResult {
  readonly entries: readonly KnowledgeQueryEntry[];
  /** Every node that matches, whatever the limit is. */
  readonly total: number;
  /** More matching nodes follow; pass `nextAfter` as `after`. */
  readonly more: boolean;
  readonly nextAfter?: string;
  readonly groups?: readonly { readonly key: string; readonly count: number }[];
  readonly generation: number;
  readonly truncated: boolean;
  readonly routeFailures?: readonly string[];
  readonly incompleteReasons?: readonly string[];
}

/** Error code thrown by knowledge search when the session workspace's own code index cannot answer. */
export const WORKSPACE_INDEX_UNAVAILABLE = 'knowledge_workspace_index_unavailable';

export interface KnowledgeIndexStatus {
  readonly state: 'ready' | 'stale' | 'degraded' | 'unavailable' | 'uninitialized' | 'busy';
  readonly engine: string;
  readonly generation: number;
  readonly indexedCommit?: string;
  readonly currentCommit?: string;
  readonly lastGoodGeneration?: number;
  readonly nodeCount: number;
  /** Entities the asking caller may read. */
  readonly entityCount?: number;
  readonly edgeCount?: number;
  readonly reason?: string;
  readonly route?: string;
  readonly codeRoot?: string;
  readonly projectionRoot?: string;
  readonly dataRoot?: string;
  readonly repositoryCommonId?: string;
  readonly worktreeId?: string;
  readonly gitCommonDirectoryId?: string;
  readonly baseCommit?: string;
  readonly overlayDigest?: string;
  readonly baseGeneration?: string;
  readonly overlayGeneration?: string;
  readonly composedGeneration?: string;
  readonly vectorState?: 'disabled' | 'ready' | 'unavailable';
  readonly vectorGeneration?: {
    readonly providerId: string;
    readonly providerKind: 'local' | 'openai-compatible' | 'vertex-gemini';
    readonly model: string;
    readonly revision: string | null;
    readonly dimensions: number;
    readonly identityDigest: string;
  } | null;
  readonly generationVector?: readonly KnowledgeGenerationVectorEntry[];
}

export interface KnowledgeIndexMutationResult {
  readonly changed: boolean;
  readonly generation: number;
  readonly nodeIds: readonly string[];
}

export type KnowledgeDocumentMutation =
  | {
      readonly operation: 'upsert';
      readonly path: string;
    }
  | {
      readonly operation: 'remove';
      readonly path: string;
      readonly identity?: string;
    };

export interface KnowledgeIndexRequestOptions {
  readonly signal?: AbortSignal;
  /** The work email the host resolved for the person asking; entities they may not read never reach a result or a count. */
  readonly caller?: string;
  /** The principals the server derived from the caller's credential; nodes whose access labels share none with them never reach a result, count or walk. */
  readonly access?: AccessPrincipals;
}

/** The host call context's caller identity: a work email, or undefined when the host named none. */
export type KnowledgeCallerResolver = (context: InvocationContext) => string | undefined;

export interface KnowledgeIndex {
  search(
    request: {
      readonly query: string;
      readonly kinds?: readonly KnowledgeNodeKind[];
      /** Entity types to return; with no kinds, searches entities only. */
      readonly entityTypes?: readonly string[];
      /** A candidate set of node ids: only these can be returned, applied before ranking. */
      readonly ids?: readonly string[];
      /** Host-authorized opaque memory scope IDs applied before result ranking. */
      readonly scopes?: readonly string[];
      readonly limit?: number;
      readonly expand?: boolean;
      /** Internal bounded continuation used by authorization-aware providers. */
      readonly offset?: number;
      /** Judge a wider candidate pool; indexes without a judge keep hybrid order. */
      readonly deep?: boolean;
      /** Also return superseded and archived memories. */
      readonly includeHistory?: boolean;
      /** `file`: one hit per code file with its matching nodes in `fileMatch`. Default `node`. */
      readonly granularity?: KnowledgeSearchGranularity;
      /**
       * Opt in to createdAt/category on memory nodes. Indexes omit them otherwise, because
       * older providers validate nodes against a closed schema that rejects unknown fields.
       */
      readonly memoryFacets?: boolean;
      /** Opt in to line/summary on hits, for the same closed-schema reason as memoryFacets. */
      readonly hitDetail?: boolean;
    },
    options?: KnowledgeIndexRequestOptions,
  ): Promise<KnowledgeSearchResult>;
  context(
    request: {
      readonly target: KnowledgeTarget;
      readonly maxDepth?: number;
      readonly limit?: number;
      /** Also walk through superseded and archived memories. */
      readonly includeHistory?: boolean;
    },
    options?: KnowledgeIndexRequestOptions,
  ): Promise<KnowledgeContextResult>;
  impact(
    request: {
      readonly target: KnowledgeTarget;
      readonly direction: 'inbound' | 'outbound' | 'both';
      readonly edgeTypes?: readonly KnowledgeEdgeType[];
      readonly maxDepth?: number;
      readonly limit?: number;
      /** Also walk through superseded and archived memories. */
      readonly includeHistory?: boolean;
    },
    options?: KnowledgeIndexRequestOptions,
  ): Promise<KnowledgeImpactResult>;
  /** Lists every code node that matches a filter, with the exact total; indexes that cannot scan their node tables leave it out. */
  query?(request: KnowledgeQueryRequest, options?: KnowledgeIndexRequestOptions): Promise<KnowledgeQueryResult>;
  detectChanges(
    request: {
      readonly changedPaths?: readonly string[];
      readonly baseRef?: string;
      readonly limit?: number;
    },
    options?: KnowledgeIndexRequestOptions,
  ): Promise<KnowledgeChangeResult>;
  upsertDocument(path: string, options?: KnowledgeIndexRequestOptions): Promise<KnowledgeIndexMutationResult>;
  removeDocument(path: string, options?: KnowledgeIndexRequestOptions): Promise<KnowledgeIndexMutationResult>;
  mutateDocuments?(
    mutations: readonly KnowledgeDocumentMutation[],
    options?: KnowledgeIndexRequestOptions,
  ): Promise<KnowledgeIndexMutationResult>;
  status(options?: KnowledgeIndexRequestOptions): Promise<KnowledgeIndexStatus>;
  dispose?(): void;
}

export interface RebuildableKnowledgeIndex extends KnowledgeIndex {
  rebuild(options?: KnowledgeIndexRequestOptions): Promise<KnowledgeIndexStatus>;
  /**
   * Republishes this index's memory-bearing slot as a fresh generation built from its sources
   * and deletes the previous file, so records removed since leave no bytes behind. Document
   * writes reuse the active file and only mark deleted rows free, so call this after an
   * irreversible deletion. `rebuild` skips an index that is already current. On a federated
   * index this compacts the local route only; compact each route that held the records.
   */
  compact?(options?: KnowledgeIndexRequestOptions): Promise<KnowledgeIndexStatus>;
}

/**
 * Shared by the authorizations of one page of search hits: the memory ids of the page (primed
 * before the first hit is authorized) and whatever the authorizer memoizes for the page.
 */
export interface KnowledgeAuthorizationBatch {
  readonly ids: string[];
  reasons?: ReadonlyMap<string, string>;
  sources?: ReadonlyMap<string, { readonly source: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque to the runtime
  memo?: any;
}

export type KnowledgeMemoryAuthorizer = (
  node: KnowledgeNodeReference,
  context: InvocationContext,
  batch?: KnowledgeAuthorizationBatch,
) => Promise<KnowledgeNodeReference | null>;

const SEARCH_TRACER_SLOT = Symbol.for('quillstone.searchTracer');

interface SearchStageTracer {
  stageClock?(): number;
  endStage?(stage: string, started: number): void;
}

/** Marks a search stage on the Quillstone search tracer, when the serving process published one. */
function searchStageMark(): (stage: string) => void {
  const tracer = (globalThis as { [SEARCH_TRACER_SLOT]?: SearchStageTracer })[SEARCH_TRACER_SLOT];
  const started = tracer?.stageClock?.();
  return (stage) => {
    if (started !== undefined) tracer!.endStage?.(stage, started);
  };
}

export type KnowledgeMemoryScopeResolver = (
  context: InvocationContext,
) => readonly string[];

const MAX_AUTHORIZATION_SEARCH_CANDIDATES = 500;
const MAX_AUTHORIZATION_SEARCH_RESTARTS = 3;

const TARGET_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    kind: { enum: ['memory', 'code', 'node'] },
    id: { type: 'string', minLength: 1, maxLength: 4_096 },
    path: { type: 'string', minLength: 1, maxLength: 4_096 },
    symbol: { type: 'string', minLength: 1, maxLength: 1_024 },
  },
  required: ['kind'],
  additionalProperties: false,
};

const KNOWLEDGE_SCHEMA_DEFINITIONS: Readonly<Record<string, JsonSchema>> = {
  node: {
    type: 'object',
    required: ['id', 'kind', 'name'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 4_096 },
      kind: { enum: ['memory', 'code_file', 'symbol', 'execution_flow', 'evidence', 'entity'] },
      name: { type: 'string', maxLength: 4_096 },
      entityKind: { type: 'string', maxLength: 64 },
      audience: { anyOf: [{ enum: ['public'] }, { type: 'array', maxItems: 80, items: { type: 'string', maxLength: 254 } }] },
      access: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 254 } },
      fields: { type: 'object' },
      url: { type: 'string', maxLength: 4_096 },
      path: { type: 'string', maxLength: 4_096 },
      symbol: { type: 'string', maxLength: 1_024 },
      memoryId: { type: 'string', maxLength: 128 },
      scope: {
        anyOf: [
          { enum: ['workspace', 'project'] },
          { type: 'string', pattern: '^scope-[a-f0-9-]{16,80}$' },
        ],
      },
      state: { enum: ['active', 'superseded', 'archived'] },
      createdAt: { type: 'string', maxLength: 64 },
      category: { enum: ['preference', 'fact', 'decision', 'context'] },
      resolved: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  path: {
    type: 'object',
    required: ['nodes', 'edges', 'directions', 'explanation'],
    properties: {
      nodes: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/node' } },
      edges: {
        type: 'array',
        maxItems: 100,
        items: {
          enum: [
            'APPLIES_TO', 'DEPENDS_ON', 'RELATED_TO', 'CONTRADICTS', 'SUPERSEDES',
            'DERIVED_FROM', 'CONTAINS', 'IMPORTS', 'CALLS', 'IMPLEMENTS', 'PARTICIPATES_IN',
          ],
        },
      },
      directions: {
        type: 'array',
        maxItems: 100,
        items: { enum: ['inbound', 'outbound'] },
      },
      explanation: { type: 'string', maxLength: 20_000 },
      links: {
        type: 'array',
        maxItems: 100,
        items: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              required: ['label', 'method', 'source', 'status', 'confidence', 'scope'],
              properties: {
                label: { type: 'string', maxLength: 64 },
                method: { type: 'string', maxLength: 64 },
                source: { type: 'string', maxLength: 64 },
                status: { enum: ['recorded', 'suggested', 'accepted'] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                count: { type: 'integer', minimum: 0 },
                confirmedBy: { type: 'string', maxLength: 64 },
                scope: { anyOf: [{ enum: ['public'] }, { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 254 } }] },
              },
              additionalProperties: false,
            },
          ],
        },
      },
    },
    additionalProperties: false,
  },
};

function knowledgeOutputSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return {
    type: 'object',
    required,
    properties,
    additionalProperties: false,
    $defs: KNOWLEDGE_SCHEMA_DEFINITIONS,
  };
}

const KNOWLEDGE_STATUS_OUTPUT_SCHEMA = knowledgeOutputSchema({
  state: { enum: ['ready', 'stale', 'degraded', 'unavailable', 'uninitialized', 'busy'] },
  engine: { type: 'string', minLength: 1, maxLength: 255 },
  generation: { type: 'integer', minimum: 0 },
  indexedCommit: { type: 'string', maxLength: 1_024 },
  currentCommit: { type: 'string', maxLength: 1_024 },
  lastGoodGeneration: { type: 'integer', minimum: 0 },
  nodeCount: { type: 'integer', minimum: 0 },
  entityCount: { type: 'integer', minimum: 0 },
  edgeCount: { type: 'integer', minimum: 0 },
  reason: { type: 'string', maxLength: 20_000 },
  route: { type: 'string', minLength: 1, maxLength: 256 },
  codeRoot: { type: 'string', minLength: 1, maxLength: 4_096 },
  projectionRoot: { type: 'string', minLength: 1, maxLength: 4_096 },
  dataRoot: { type: 'string', minLength: 1, maxLength: 4_096 },
  repositoryCommonId: { type: 'string', minLength: 1, maxLength: 256 },
  worktreeId: { type: 'string', minLength: 1, maxLength: 256 },
  gitCommonDirectoryId: { type: 'string', minLength: 1, maxLength: 256 },
  baseCommit: { type: 'string', minLength: 1, maxLength: 256 },
  overlayDigest: { type: 'string', minLength: 1, maxLength: 256 },
  baseGeneration: { type: 'string', minLength: 1, maxLength: 256 },
  overlayGeneration: { type: 'string', minLength: 1, maxLength: 256 },
  composedGeneration: { type: 'string', minLength: 1, maxLength: 256 },
  vectorState: { enum: ['disabled', 'ready', 'unavailable'] },
  vectorGeneration: {
    anyOf: [
      { type: 'null' },
      {
        type: 'object',
        required: ['providerId', 'providerKind', 'model', 'revision', 'dimensions', 'identityDigest'],
        properties: {
          providerId: { type: 'string', minLength: 1, maxLength: 256 },
          providerKind: { enum: ['local', 'openai-compatible', 'vertex-gemini'] },
          model: { type: 'string', minLength: 1, maxLength: 1_024 },
          revision: { type: ['string', 'null'], maxLength: 1_024 },
          dimensions: { type: 'integer', minimum: 1, maximum: 65_536 },
          identityDigest: { type: 'string', minLength: 1, maxLength: 256 },
        },
        additionalProperties: false,
      },
    ],
  },
  generationVector: {
    type: 'array',
    maxItems: 64,
    items: {
      type: 'object',
      required: ['route', 'generation', 'vectorGeneration'],
      properties: {
        route: { type: 'string', minLength: 1, maxLength: 256 },
        generation: { type: 'integer', minimum: 0 },
        vectorGeneration: { type: ['string', 'null'], maxLength: 256 },
      },
      additionalProperties: false,
    },
  },
}, ['state', 'engine', 'generation', 'nodeCount']);

/** Hits a search returns when the caller names no limit: top-3 accuracy is what agents act on. */
export const DEFAULT_SEARCH_LIMIT = 3;

/** Targets one `knowledge.impact_many` call answers; the same bound as the other lists the capabilities take. */
export const MAX_IMPACT_MANY_TARGETS = 100;

/** The fields of a `knowledge.impact` answer, defined once: `knowledge.impact` and every `knowledge.impact_many` entry are built from them, so a field added here is valid in both. */
const IMPACT_OUTPUT_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  target: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] },
  gaps: {
    type: 'object',
    required: ['callables', 'covered', 'unresolvedCalls', 'ambiguousCalls'],
    properties: {
      callables: { type: 'integer', minimum: 0 },
      covered: { type: 'integer', minimum: 0 },
      unresolvedCalls: { type: 'integer', minimum: 0 },
      ambiguousCalls: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  nodes: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/node' } },
  paths: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/path' } },
  direction: { enum: ['inbound', 'outbound', 'both'] },
  maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
  generation: { type: 'integer', minimum: 0 },
  truncated: { type: 'boolean' },
};

const IMPACT_OUTPUT_REQUIRED = ['target', 'nodes', 'paths', 'direction', 'maxDepth', 'generation', 'truncated'] as const;

const IMPACT_ENTRY_SCHEMA: JsonSchema = {
  type: 'object',
  required: IMPACT_OUTPUT_REQUIRED,
  properties: IMPACT_OUTPUT_PROPERTIES,
  additionalProperties: false,
};

const KNOWLEDGE_OUTPUT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  'knowledge.search': knowledgeOutputSchema({
    hits: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['node', 'rank'],
        properties: {
          node: { $ref: '#/$defs/node' },
          rank: { type: 'number' },
          score: { type: 'number' },
          endLine: { type: 'integer', minimum: 1 },
          snippet: { type: 'string', maxLength: 1_000 },
          sourceScores: {
            type: 'array',
            maxItems: 16,
            items: {
              type: 'object',
              required: ['source', 'rank', 'score'],
              properties: {
                source: { type: 'string', maxLength: 128 },
                rank: { type: 'number' },
                score: { type: 'number' },
              },
              additionalProperties: false,
            },
          },
          location: { type: 'string', maxLength: 4_096 },
          line: { type: 'integer', minimum: 1 },
          summary: { type: 'string', maxLength: 600 },
          fileMatch: {
            type: 'object',
            required: ['path', 'nodeIds', 'nodeCount'],
            properties: {
              path: { type: 'string', maxLength: 4_096 },
              nodeIds: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 4_096 } },
              nodeCount: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
          explanationPaths: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/path' } },
        },
        additionalProperties: false,
      },
    },
    generation: { type: 'integer', minimum: 0 },
    generationVector: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        required: ['route', 'generation', 'vectorGeneration'],
        properties: {
          route: { type: 'string', minLength: 1, maxLength: 256 },
          generation: { type: 'integer', minimum: 0 },
          vectorGeneration: { type: ['string', 'null'], maxLength: 256 },
        },
        additionalProperties: false,
      },
    },
    truncated: { type: 'boolean' },
    routeFailures: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 2_048 } },
    incompleteReasons: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 2_048 } },
  }, ['hits', 'generation', 'truncated']),
  'knowledge.context': knowledgeOutputSchema({
    target: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] },
    nodes: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/node' } },
    paths: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/path' } },
    generation: { type: 'integer', minimum: 0 },
    truncated: { type: 'boolean' },
  }, ['target', 'nodes', 'paths', 'generation', 'truncated']),
  'knowledge.impact': knowledgeOutputSchema(IMPACT_OUTPUT_PROPERTIES, IMPACT_OUTPUT_REQUIRED),
  'knowledge.impact_many': knowledgeOutputSchema({
    results: {
      type: 'array',
      maxItems: MAX_IMPACT_MANY_TARGETS,
      description: 'One entry per target, in order: the knowledge.impact output for it, or the error it failed with.',
      items: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          output: IMPACT_ENTRY_SCHEMA,
          error: { type: 'string', maxLength: 20_000 },
        },
        additionalProperties: false,
      },
    },
  }, ['results']),
  'knowledge.query': knowledgeOutputSchema({
    entries: {
      type: 'array',
      maxItems: 1_000,
      items: {
        type: 'object',
        required: ['node', 'table'],
        properties: {
          node: { $ref: '#/$defs/node' },
          table: { type: 'string', maxLength: 64 },
          language: { type: 'string', maxLength: 64 },
        },
        additionalProperties: false,
      },
    },
    total: { type: 'integer', minimum: 0 },
    more: { type: 'boolean' },
    nextAfter: { type: 'string', maxLength: 4_096 },
    groups: {
      type: 'array',
      maxItems: 1_000,
      items: {
        type: 'object',
        required: ['key', 'count'],
        properties: {
          key: { type: 'string', maxLength: 4_096 },
          count: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    generation: { type: 'integer', minimum: 0 },
    truncated: { type: 'boolean' },
    routeFailures: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 2_048 } },
    incompleteReasons: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 2_048 } },
  }, ['entries', 'total', 'more', 'generation', 'truncated']),
  'knowledge.detect_changes': knowledgeOutputSchema({
    changedPaths: { type: 'array', maxItems: 1_000, items: { type: 'string', maxLength: 4_096 } },
    affected: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/node' } },
    paths: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/path' } },
    generation: { type: 'integer', minimum: 0 },
    truncated: { type: 'boolean' },
  }, ['changedPaths', 'affected', 'paths', 'generation', 'truncated']),
  'knowledge.status': KNOWLEDGE_STATUS_OUTPUT_SCHEMA,
  'knowledge.index.rebuild': KNOWLEDGE_STATUS_OUTPUT_SCHEMA,
};

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor('knowledge.search', 'Search bounded code and shared memory knowledge.', 'knowledge.read', 'low', {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 20_000 },
      kinds: {
        type: 'array',
        maxItems: 6,
        items: { enum: ['memory', 'code_file', 'symbol', 'execution_flow', 'evidence', 'entity'] },
      },
      entityTypes: {
        type: 'array',
        maxItems: 16,
        description: 'Entity types to return (ticket, pull_request, person, meeting, meeting_item). '
          + 'With no kinds, searches entities only; the filter is applied before ranking, so other nodes never crowd these out.',
        items: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
      },
      ids: {
        type: 'array',
        maxItems: 5000,
        description: 'A candidate set of node ids (for example the nodes near a tag). Only these nodes can be returned; '
          + 'the set is applied before ranking, so the best matches inside it are found whatever else the index holds. '
          + 'The caller\'s audience still applies, and an empty list returns no hits.',
        items: { type: 'string', minLength: 1, maxLength: 1024 },
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: `Default ${DEFAULT_SEARCH_LIMIT}: the best answers first. Ask for more only to browse.`,
      },
      debug: {
        type: 'boolean',
        description: 'Off by default: each hit is its node, rank, line range, a 1-3 line snippet and a summary. '
          + 'true adds scores, location, explanation paths and incomplete reasons.',
      },
      expand: { type: 'boolean' },
      deep: {
        type: 'boolean',
        description: 'On by default for natural-language queries: a judge (Jev) picks the best match '
          + 'among the hybrid top 10 and deeper semantic and lexical hits (~0.3-0.7 s). Pass false for '
          + 'plain hybrid order. A judged hit carries a "judge" sourceScore: the judge\'s probability '
          + '(0-1) that it is the best match. When the top probabilities are close, check each of them.',
      },
      includeHistory: {
        type: 'boolean',
        description: 'Default false: only current memories, so a replaced revision and its links stay hidden. '
          + 'Pass true to also see superseded and archived revisions (what was believed before).',
      },
      granularity: {
        enum: ['node', 'file'],
        description: 'Default node: every hit is one symbol, section or memory. file: one hit per code file, '
          + 'ranked by its best three symbols (a File match counts on its own), with fileMatch listing the '
          + 'file\'s matching node ids (at most three, best first). Memories, tickets and other non-code hits are unchanged.',
      },
      createdAfter: CREATED_AFTER_SCHEMA,
      createdBefore: CREATED_BEFORE_SCHEMA,
    },
    required: ['query'],
    additionalProperties: false,
  }),
  descriptor('knowledge.context', 'Expand bounded context around one code or memory target.', 'knowledge.read', 'low', {
    type: 'object',
    properties: {
      target: TARGET_SCHEMA,
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      includeHistory: {
        type: 'boolean',
        description: 'Default false: only current memories, so a replaced revision and its links stay hidden. '
          + 'Pass true to also see superseded and archived revisions (what was believed before).',
      },
    },
    required: ['target'],
    additionalProperties: false,
  }),
  descriptor('knowledge.impact', 'Analyze bounded bidirectional code and memory impact.', 'knowledge.impact', 'high', {
    type: 'object',
    properties: {
      target: TARGET_SCHEMA,
      direction: { enum: ['inbound', 'outbound', 'both'] },
      edgeTypes: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 64 },
      },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      includeHistory: {
        type: 'boolean',
        description: 'Default false: only current memories, so a replaced revision and its links stay hidden. '
          + 'Pass true to also see superseded and archived revisions (what was believed before).',
      },
    },
    required: ['target', 'direction'],
    additionalProperties: false,
  }),
  descriptor('knowledge.impact_many', 'Run knowledge.impact for many targets in one call, with one shared direction, edge types, depth and limit. Each entry is exactly what knowledge.impact returns for that target alone, or its error; the reads share their index statements, so N targets cost far less than N calls.', 'knowledge.impact', 'high', {
    type: 'object',
    properties: {
      targets: { type: 'array', minItems: 1, maxItems: MAX_IMPACT_MANY_TARGETS, items: TARGET_SCHEMA },
      direction: { enum: ['inbound', 'outbound', 'both'] },
      edgeTypes: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 64 },
      },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      includeHistory: {
        type: 'boolean',
        description: 'Default false: only current memories, so a replaced revision and its links stay hidden. '
          + 'Pass true to also see superseded and archived revisions (what was believed before).',
      },
    },
    required: ['targets', 'direction'],
    additionalProperties: false,
  }),
  descriptor('knowledge.query', 'List every code node that matches a filter (kind, language, path prefix, name, document outline entry, relations) with the exact total and optional group counts.', 'knowledge.read', 'low', {
    type: 'object',
    properties: {
      nodeKinds: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 64 } },
      languages: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 64 } },
      repositories: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 256 } },
      pathPrefix: { type: 'string', minLength: 1, maxLength: 4_096 },
      names: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 1_024 } },
      nameContains: { type: 'string', minLength: 1, maxLength: 1_024 },
      outline: {
        type: 'object',
        properties: {
          namePrefixes: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 64 } },
          name: { type: 'string', minLength: 1, maxLength: 1_024 },
        },
        required: ['name'],
        additionalProperties: false,
      },
      relations: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', pattern: '^[A-Z_]{2,40}$' },
            direction: { enum: ['incoming', 'outgoing', 'both'] },
            absent: { type: 'boolean' },
            min: { type: 'integer', minimum: 1, maximum: 1_000_000 },
            otherName: { type: 'string', minLength: 1, maxLength: 1_024 },
            otherKinds: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 64 } },
            otherPathPrefix: { type: 'string', minLength: 1, maxLength: 4_096 },
          },
          required: ['type', 'direction'],
          additionalProperties: false,
        },
      },
      groupBy: { enum: ['kind', 'language', 'repositoryId', 'directory'] },
      directoryDepth: { type: 'integer', minimum: 1, maximum: 32 },
      after: { type: 'string', minLength: 1, maxLength: 4_096 },
      limit: { type: 'integer', minimum: 0, maximum: 1_000 },
    },
    additionalProperties: false,
  }),
  descriptor('knowledge.detect_changes', 'Map bounded workspace changes to code and memory impact.', 'knowledge.detect_changes', 'medium', {
    type: 'object',
    properties: {
      changedPaths: {
        type: 'array',
        maxItems: 1_000,
        items: { type: 'string', minLength: 1, maxLength: 4_096 },
      },
      baseRef: { type: 'string', minLength: 1, maxLength: 255 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  }),
  descriptor('knowledge.status', 'Read the matching unified knowledge index health.', 'knowledge.read', 'low', {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }),
  descriptor('knowledge.index.rebuild', 'Rebuild the disposable code and shared-memory index.', 'knowledge.index.rebuild', 'high', {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }),
];

function descriptor(
  name: string,
  description: string,
  permission: string,
  risk: 'low' | 'medium' | 'high',
  inputSchema: JsonSchema,
): CapabilityDescriptor {
  return {
    protocolVersion: PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    description,
    tags: ['knowledge', 'quillstone', name.slice('knowledge.'.length)],
    permissions: [{ permission, scope: 'workspace', risk }],
    inputSchema,
    outputSchema: KNOWLEDGE_OUTPUT_SCHEMAS[name]!,
  };
}

export function createKnowledgeIndexProvider(
  index: KnowledgeIndex,
  providerId = 'marshal.quillstone',
  authorizeMemory?: KnowledgeMemoryAuthorizer,
  resolveMemoryScopes?: KnowledgeMemoryScopeResolver,
  resolveCaller: KnowledgeCallerResolver = principalCaller,
  resolveAccess: KnowledgeAccessResolver = principalAccess,
): CapabilityProvider {
  const descriptors = DESCRIPTORS.filter((descriptor) =>
    (descriptor.name !== 'knowledge.index.rebuild' || isRebuildableKnowledgeIndex(index))
    && (descriptor.name !== 'knowledge.query' || index.query !== undefined));
  return createProvider(providerId, descriptors, async (name, rawInput, context) => {
    throwIfCancelled(context);
    const input = assertRecord(rawInput ?? {});
    const caller = resolveCaller(context);
    const access = resolveAccess(context);
    const options: KnowledgeIndexRequestOptions | undefined = context.signal || caller || access
      ? {
          ...(context.signal ? { signal: context.signal as AbortSignal } : {}),
          ...(caller ? { caller } : {}),
          ...(access ? { access } : {}),
        }
      : undefined;
    let output: unknown;
    switch (name) {
      case 'knowledge.search': {
        const limit = boundedInteger(input.limit, DEFAULT_SEARCH_LIMIT, 1, 100, 'limit');
        const debug = parseOptionalBoolean(input.debug, 'debug');
        const searchQuery = requireString(input, 'query', { maxLength: 20_000 });
        const searched = await searchAuthorizedKnowledge(index, {
            query: searchQuery,
            kinds: parseKinds(input.kinds),
            ...(input.entityTypes === undefined ? {} : { entityTypes: parseEntityTypes(input.entityTypes) }),
            ...(input.ids === undefined ? {} : { ids: parseStrings(input.ids, 5000, 1024) ?? [] }),
            scopes: resolveMemoryScopes?.(context),
            limit,
            expand: input.expand === true,
            ...(typeof input.deep === 'boolean' ? { deep: input.deep } : {}),
            ...(input.includeHistory === true ? { includeHistory: true } : {}),
            ...(input.granularity === undefined ? {} : { granularity: parseGranularity(input.granularity) }),
          }, options, authorizeMemory, context, parseMemoryDateWindow(input));
        output = debug ? searched : compactSearchResult(searched);
        break;
      }
      case 'knowledge.context':
        output = await sanitizeKnowledgeContext(await index.context({
          target: parseTarget(input.target),
          maxDepth: boundedInteger(input.maxDepth, 2, 1, 5, 'maxDepth'),
          limit: boundedInteger(input.limit, 20, 1, 100, 'limit'),
          ...(input.includeHistory === true ? { includeHistory: true } : {}),
        }, options), authorizeMemory, context);
        break;
      case 'knowledge.impact':
        output = await sanitizeKnowledgeImpact(await index.impact({
          target: parseTarget(input.target),
          direction: parseDirection(input.direction),
          edgeTypes: parseEdgeTypes(input.edgeTypes),
          maxDepth: boundedInteger(input.maxDepth, 2, 1, 5, 'maxDepth'),
          limit: boundedInteger(input.limit, 20, 1, 100, 'limit'),
          ...(input.includeHistory === true ? { includeHistory: true } : {}),
        }, options), authorizeMemory, context);
        break;
      case 'knowledge.impact_many': {
        if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > MAX_IMPACT_MANY_TARGETS) {
          throw new TypeError(`targets must be a list of 1 to ${MAX_IMPACT_MANY_TARGETS} targets.`);
        }
        const targets = input.targets.map((target) => parseTarget(target));
        const direction = parseDirection(input.direction);
        const edgeTypes = parseEdgeTypes(input.edgeTypes);
        const maxDepth = boundedInteger(input.maxDepth, 2, 1, 5, 'maxDepth');
        const limit = boundedInteger(input.limit, 20, 1, 100, 'limit');
        const settled = await readTogether(targets, async (target) => sanitizeKnowledgeImpact(await index.impact({
          target,
          direction,
          edgeTypes,
          maxDepth,
          limit,
          ...(input.includeHistory === true ? { includeHistory: true } : {}),
        }, options), authorizeMemory, context));
        output = {
          results: settled.map((entry) => entry.status === 'ok'
            ? { ok: true, output: entry.value }
            : { ok: false, error: entry.message }),
        };
        break;
      }
      case 'knowledge.query': {
        if (index.query === undefined) throw new Error('This knowledge index cannot run an exhaustive query.');
        output = codeOnlyQuery(await index.query(parseQuery(input), options));
        break;
      }
      case 'knowledge.detect_changes':
        output = await sanitizeKnowledgeChanges(await index.detectChanges({
          changedPaths: parseStrings(input.changedPaths, 1_000, 4_096),
          ...(input.baseRef === undefined
            ? {}
            : { baseRef: requireString(input, 'baseRef', { maxLength: 255 }) }),
          limit: boundedInteger(input.limit, 20, 1, 100, 'limit'),
        }, options), authorizeMemory, context);
        break;
      case 'knowledge.status':
        output = await index.status(options);
        break;
      case 'knowledge.index.rebuild':
        if (!isRebuildableKnowledgeIndex(index)) {
          throw new Error('Knowledge index maintenance is not exposed by this service.');
        }
        output = await index.rebuild(options);
        break;
      default:
        throw new Error(`Unsupported knowledge capability: ${name}`);
    }

    const resultDone = searchStageMark();
    const enveloped = result(output, providerId, name, rawInput, context);
    resultDone('result');
    return enveloped;
  });
}

const QUERY_CODE_KINDS: ReadonlySet<string> = new Set(['code_file', 'symbol', 'execution_flow']);
const QUERY_GROUP_BY: ReadonlySet<string> = new Set(['kind', 'language', 'repositoryId', 'directory']);
const QUERY_RELATION_TYPE = /^[A-Z_]{2,40}$/u;

function parseQueryString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${name} must be a bounded non-empty string.`);
  }
  return value.trim();
}

function parseQueryInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  return boundedInteger(value, minimum, minimum, maximum, name);
}

function parseQueryRelation(value: unknown): KnowledgeQueryRelationFilter {
  const relation = assertRecord(value);
  const type = parseQueryString(relation.type, 'relation type', 40);
  if (type === undefined || !QUERY_RELATION_TYPE.test(type)) throw new TypeError('A relation filter needs a relation type.');
  if (relation.direction !== 'incoming' && relation.direction !== 'outgoing' && relation.direction !== 'both') {
    throw new TypeError('A relation filter direction must be incoming, outgoing or both.');
  }
  const otherName = parseQueryString(relation.otherName, 'otherName', 1_024);
  const otherPathPrefix = parseQueryString(relation.otherPathPrefix, 'otherPathPrefix', 4_096);
  const otherKinds = parseStrings(relation.otherKinds, 64, 64);
  const min = parseQueryInteger(relation.min, 'min', 1, 1_000_000);
  return {
    type,
    direction: relation.direction,
    ...(relation.absent === true ? { absent: true } : {}),
    ...(min === undefined ? {} : { min }),
    ...(otherName === undefined ? {} : { otherName }),
    ...(otherKinds === undefined ? {} : { otherKinds }),
    ...(otherPathPrefix === undefined ? {} : { otherPathPrefix }),
  };
}

function parseQuery(input: Record<string, unknown>): KnowledgeQueryRequest {
  const nodeKinds = parseStrings(input.nodeKinds, 64, 64);
  const languages = parseStrings(input.languages, 64, 64);
  const repositories = parseStrings(input.repositories, 64, 256);
  const names = parseStrings(input.names, 100, 1_024);
  const pathPrefix = parseQueryString(input.pathPrefix, 'pathPrefix', 4_096);
  const nameContains = parseQueryString(input.nameContains, 'nameContains', 1_024);
  const after = parseQueryString(input.after, 'after', 4_096);
  const limit = parseQueryInteger(input.limit, 'limit', 0, 1_000);
  const directoryDepth = parseQueryInteger(input.directoryDepth, 'directoryDepth', 1, 32);
  const groupBy = input.groupBy;
  if (groupBy !== undefined && (typeof groupBy !== 'string' || !QUERY_GROUP_BY.has(groupBy))) {
    throw new TypeError('groupBy must be kind, language, repositoryId or directory.');
  }
  let outline: KnowledgeQueryRequest['outline'];
  if (input.outline !== undefined) {
    const raw = assertRecord(input.outline);
    const name = parseQueryString(raw.name, 'outline name', 1_024);
    if (name === undefined) throw new TypeError('An outline filter needs a name.');
    const namePrefixes = parseStrings(raw.namePrefixes, 32, 64);
    outline = { name, ...(namePrefixes === undefined ? {} : { namePrefixes }) };
  }
  if (input.relations !== undefined && (!Array.isArray(input.relations) || input.relations.length > 8)) {
    throw new TypeError('relations must be a list of at most 8 filters.');
  }
  return {
    ...(nodeKinds === undefined ? {} : { nodeKinds }),
    ...(languages === undefined ? {} : { languages }),
    ...(repositories === undefined ? {} : { repositories }),
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
    ...(names === undefined ? {} : { names }),
    ...(nameContains === undefined ? {} : { nameContains }),
    ...(outline === undefined ? {} : { outline }),
    ...(input.relations === undefined ? {} : { relations: (input.relations as unknown[]).map(parseQueryRelation) }),
    ...(groupBy === undefined ? {} : { groupBy: groupBy as NonNullable<KnowledgeQueryRequest['groupBy']> }),
    ...(directoryDepth === undefined ? {} : { directoryDepth }),
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function codeOnlyQuery(result: KnowledgeQueryResult): KnowledgeQueryResult {
  return { ...result, entries: result.entries.filter((entry) => QUERY_CODE_KINDS.has(entry.node.kind)) };
}

function parseGranularity(value: unknown): KnowledgeSearchGranularity {
  if (value === 'node' || value === 'file') return value;
  throw new TypeError('granularity must be node or file.');
}

function parseOptionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  throw new TypeError(`${name} must be a boolean.`);
}

/** Where each hit is and what it says; ranking diagnostics stay out unless `debug: true`. */
export function compactSearchResult(result: KnowledgeSearchResult): KnowledgeSearchResult {
  return {
    hits: result.hits.map((hit) => ({
      node: hit.node,
      rank: hit.rank,
      ...(hit.line === undefined ? {} : { line: hit.line }),
      ...(hit.endLine === undefined ? {} : { endLine: hit.endLine }),
      ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
      ...(hit.summary === undefined ? {} : { summary: hit.summary }),
      ...(hit.fileMatch === undefined ? {} : { fileMatch: hit.fileMatch }),
    })),
    generation: result.generation,
    truncated: result.truncated,
    ...(result.routeFailures === undefined ? {} : { routeFailures: result.routeFailures }),
    ...(result.incompleteReasons === undefined ? {} : { incompleteReasons: result.incompleteReasons }),
  };
}

function isRebuildableKnowledgeIndex(
  index: KnowledgeIndex,
): index is RebuildableKnowledgeIndex {
  return typeof (index as Partial<RebuildableKnowledgeIndex>).rebuild === 'function';
}

async function searchAuthorizedKnowledge(
  index: KnowledgeIndex,
  request: {
    readonly query: string;
    readonly kinds?: readonly KnowledgeNodeKind[];
    readonly entityTypes?: readonly string[];
    readonly ids?: readonly string[];
    readonly scopes?: readonly string[];
    readonly limit: number;
    readonly expand: boolean;
    readonly deep?: boolean;
    readonly includeHistory?: boolean;
    readonly granularity?: KnowledgeSearchGranularity;
  },
  options: KnowledgeIndexRequestOptions | undefined,
  authorizeMemory: KnowledgeMemoryAuthorizer | undefined,
  context: InvocationContext,
  createdWindow?: MemoryDateWindow,
): Promise<KnowledgeSearchResult> {
  const pageSize = Math.min(100, Math.max(20, request.limit * 2));
  for (let attempt = 0; attempt < MAX_AUTHORIZATION_SEARCH_RESTARTS; attempt += 1) {
    const authorization = authorizationSession(authorizeMemory, context);
    const hits: KnowledgeSearchHit[] = [];
    let offset = 0;
    let generation: number | undefined;
    let generationVector: readonly KnowledgeGenerationVectorEntry[] | undefined;
    let sourceTruncated = false;
    let generationChanged = false;
    const routeFailures = new Set<string>();
    const incompleteReasons = new Set<string>();
    while (offset < MAX_AUTHORIZATION_SEARCH_CANDIDATES && hits.length < request.limit) {
      throwIfCancelled(context);
      const page = await index.search({
        ...request,
        memoryFacets: true,
        hitDetail: true,
        limit: Math.min(pageSize, MAX_AUTHORIZATION_SEARCH_CANDIDATES - offset),
        offset,
      }, options);
      if (generation !== undefined && page.generation !== generation) {
        generationChanged = true;
        break;
      }
      generation = page.generation;
      generationVector = page.generationVector;
      sourceTruncated = page.truncated;
      for (const failure of page.routeFailures ?? []) routeFailures.add(failure);
      for (const reason of page.incompleteReasons ?? []) incompleteReasons.add(reason);
      authorization.prime(page.hits.map((hit) => hit.node));
      const authorizeDone = searchStageMark();
      for (const hit of page.hits) {
        const node = await authorization.node(hit.node);
        if (!node || !withinMemoryDateWindow(node, createdWindow)) continue;
        hits.push({
          ...hit,
          node,
          ...(hit.explanationPaths === undefined
            ? {}
            : { explanationPaths: await authorization.paths(hit.explanationPaths) }),
        });
        if (hits.length >= request.limit) break;
      }
      authorizeDone('authorize');
      offset += page.hits.length;
      if (!page.truncated || page.hits.length === 0) break;
    }
    if (generationChanged) continue;
    return {
      hits,
      generation: generation ?? 0,
      ...(generationVector ? { generationVector } : {}),
      truncated: sourceTruncated || offset >= MAX_AUTHORIZATION_SEARCH_CANDIDATES,
      ...(routeFailures.size > 0 ? { routeFailures: [...routeFailures].slice(0, 64) } : {}),
      ...(incompleteReasons.size > 0 ? { incompleteReasons: [...incompleteReasons].slice(0, 64) } : {}),
    };
  }
  throw new Error('Knowledge index generation changed during every bounded authorization search attempt.');
}

async function sanitizeKnowledgeContext(
  value: KnowledgeContextResult,
  authorizeMemory: KnowledgeMemoryAuthorizer | undefined,
  context: InvocationContext,
): Promise<KnowledgeContextResult> {
  const authorization = authorizationSession(authorizeMemory, context);
  const target = value.target ? await authorization.node(value.target) : null;
  if (value.target && !target) {
    return { ...value, target: null, nodes: [], paths: [], truncated: false };
  }
  return {
    ...value,
    target,
    nodes: await authorization.nodes(value.nodes),
    paths: await authorization.paths(value.paths),
  };
}

async function sanitizeKnowledgeImpact(
  value: KnowledgeImpactResult,
  authorizeMemory: KnowledgeMemoryAuthorizer | undefined,
  context: InvocationContext,
): Promise<KnowledgeImpactResult> {
  const authorization = authorizationSession(authorizeMemory, context);
  const target = value.target ? await authorization.node(value.target) : null;
  if (value.target && !target) {
    const { gaps: _hidden, ...visible } = value;
    return { ...visible, target: null, nodes: [], paths: [], truncated: false };
  }
  return {
    ...value,
    target,
    nodes: await authorization.nodes(value.nodes),
    paths: await authorization.paths(value.paths),
  };
}

async function sanitizeKnowledgeChanges(
  value: KnowledgeChangeResult,
  authorizeMemory: KnowledgeMemoryAuthorizer | undefined,
  context: InvocationContext,
): Promise<KnowledgeChangeResult> {
  const authorization = authorizationSession(authorizeMemory, context);
  return {
    ...value,
    affected: await authorization.nodes(value.affected),
    paths: await authorization.paths(value.paths),
  };
}

function authorizationSession(
  authorizeMemory: KnowledgeMemoryAuthorizer | undefined,
  context: InvocationContext,
): {
  readonly node: (node: KnowledgeNodeReference) => Promise<KnowledgeNodeReference | null>;
  readonly nodes: (nodes: readonly KnowledgeNodeReference[]) => Promise<KnowledgeNodeReference[]>;
  readonly paths: (paths: readonly KnowledgeExplanationPath[]) => Promise<KnowledgeExplanationPath[]>;
  /** Lists the memory ids of a page so the authorizer can read their rows in one query. */
  readonly prime: (nodes: readonly KnowledgeNodeReference[]) => void;
} {
  const batch: KnowledgeAuthorizationBatch = { ids: [] };
  const prime = (values: readonly KnowledgeNodeReference[]): void => {
    for (const value of values) if (value.memoryId) batch.ids.push(value.memoryId);
  };
  const cache = new Map<string, Promise<KnowledgeNodeReference | null>>();
  const node = (candidate: KnowledgeNodeReference): Promise<KnowledgeNodeReference | null> => {
    if (candidate.kind === 'memory' && !candidate.memoryId) return Promise.resolve(null);
    if (!candidate.memoryId) return Promise.resolve(candidate);
    const existing = cache.get(candidate.id);
    if (existing) return existing;
    const authorized = authorizeMemory
      ? authorizeMemory(candidate, context, batch)
      : Promise.resolve(null);
    cache.set(candidate.id, authorized);
    return authorized;
  };
  const nodes = async (values: readonly KnowledgeNodeReference[]): Promise<KnowledgeNodeReference[]> => {
    const authorized = await Promise.all(values.map(node));
    return authorized.filter((candidate): candidate is KnowledgeNodeReference => candidate !== null);
  };
  const paths = async (values: readonly KnowledgeExplanationPath[]): Promise<KnowledgeExplanationPath[]> => {
    const authorized: KnowledgeExplanationPath[] = [];
    for (const candidate of values) {
      const candidateNodes = await Promise.all(candidate.nodes.map(node));
      if (candidateNodes.some((item) => item === null)) continue;
      authorized.push({ ...candidate, nodes: candidateNodes as KnowledgeNodeReference[] });
    }
    return authorized;
  };
  return { node, nodes, paths, prime };
}

function parseTarget(value: unknown): KnowledgeTarget {
  const target = assertRecord(value);
  if (target.kind === 'memory') {
    const normalized = normalizeKnowledgeMemoryTarget(
      requireString(target, 'id', { maxLength: 4_096 }),
    );
    return { kind: 'memory', id: normalized.routedId };
  }
  if (target.kind === 'code') {
    return {
      kind: 'code',
      path: requireString(target, 'path', { maxLength: 4_096 }),
      ...(target.symbol === undefined
        ? {}
        : { symbol: requireString(target, 'symbol', { maxLength: 1_024 }) }),
    };
  }
  if (target.kind === 'node') {
    return { kind: 'node', id: requireString(target, 'id', { maxLength: 4_096 }) };
  }
  throw new Error('Knowledge target kind must be memory, code, or node.');
}

export function normalizeKnowledgeMemoryTarget(value: string): NormalizedKnowledgeMemoryTarget {
  const qualified = /^\[([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\][Mm]emory:(.*)$/su.exec(value);
  const unqualified = qualified ? undefined : /^[Mm]emory:(.*)$/su.exec(value);
  if (!qualified && !unqualified) {
    if (value.length === 0 || value.length > 128) throw new Error('Memory ID is invalid.');
    return { memoryId: value, routedId: value };
  }
  const memoryId = (qualified?.[2] ?? unqualified?.[1])!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(memoryId)) {
    throw new Error('Memory node identifier contains an invalid canonical memory ID.');
  }
  const route = qualified?.[1];
  return {
    memoryId,
    routedId: route ? `[${route}]${memoryId}` : memoryId,
    ...(route ? { route } : {}),
  };
}

function parseKinds(value: unknown): readonly KnowledgeNodeKind[] | undefined {
  const values = parseStrings(value, 6, 64);
  if (!values) return undefined;
  const allowed = new Set<KnowledgeNodeKind>(['memory', 'code_file', 'symbol', 'execution_flow', 'evidence', 'entity']);
  if (values.some((kind) => !allowed.has(kind as KnowledgeNodeKind))) {
    throw new Error('Knowledge search contains an unsupported node kind.');
  }
  return values as KnowledgeNodeKind[];
}

function parseEntityTypes(value: unknown): readonly string[] {
  const values = parseStrings(value, 16, 64) ?? [];
  if (values.some((entry) => !/^[a-z][a-z0-9_]{0,63}$/u.test(entry))) {
    throw new Error('entityTypes must be a list of lower snake case entity type names.');
  }
  return values;
}

/** Resolves the principals the host derived for a call, or undefined when it named none (the bridge then reads as `staff` plus the caller). */
export type KnowledgeAccessResolver = (context: InvocationContext) => AccessPrincipals | undefined;

/** The default access resolver: the labels the host put on the call principal's claims from the caller's credential, which a model cannot set. A malformed set is an error, never "everyone". */
export function principalAccess(context: InvocationContext): AccessPrincipals | undefined {
  const labels = context.principal.claims?.access;
  return labels === undefined ? undefined : accessPrincipals(labels as readonly string[]);
}

/** The default caller resolver: the email the host put on the call principal, which a model cannot set. */
export function principalCaller(context: InvocationContext): string | undefined {
  const email = context.principal.claims?.callerEmail;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

function parseEdgeTypes(value: unknown): readonly KnowledgeEdgeType[] | undefined {
  const values = parseStrings(value, 32, 64);
  if (!values) return undefined;
  const allowed = new Set<KnowledgeEdgeType>([
    'APPLIES_TO', 'DEPENDS_ON', 'RELATED_TO', 'CONTRADICTS', 'SUPERSEDES',
    'DERIVED_FROM', 'CONTAINS', 'IMPORTS', 'CALLS', 'IMPLEMENTS', 'PARTICIPATES_IN',
  ]);
  if (values.some((edge) => !allowed.has(edge as KnowledgeEdgeType))) {
    throw new Error('Knowledge impact contains an unsupported edge type.');
  }
  return values as KnowledgeEdgeType[];
}

function parseStrings(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new Error('Expected a bounded string array.');
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > maxLength) {
      throw new Error('Expected a bounded non-empty string.');
    }
    return entry.trim();
  });
}

function parseDirection(value: unknown): 'inbound' | 'outbound' | 'both' {
  if (value === 'inbound' || value === 'outbound' || value === 'both') return value;
  throw new Error('Knowledge impact direction must be inbound, outbound, or both.');
}

function throwIfCancelled(context: InvocationContext): void {
  if (!context.signal?.aborted) return;
  throw context.signal.reason ?? new Error('Knowledge invocation was cancelled.');
}
