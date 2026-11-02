import type { InvocationContext } from '@marshal/agent-runtime-core';
import type {
  UiApplicationManifest,
  UiAuthoringProfileProvenance,
  UiAuthoringProfileReference,
} from './applicationTypes.js';

export type JsonObject = Record<string, unknown>;

export interface UiFallback {
  /** Complete model/user-readable result for hosts that do not render MCP Apps. */
  summary: string;
  details?: JsonObject;
}

export interface ReactUiPackageIdentity {
  /** Package name read from the canonical package manifest. */
  name: string;
  /** Exact package version read from the canonical package manifest. */
  version: string;
  /** SHA-256 digest of the package.json bytes used to establish identity. */
  manifestDigest: string;
}

export interface ReactUiBuildInputAttestation {
  /** Workspace paths are relative to the workspace; package paths are relative to the package root. */
  path: string;
  /** SHA-256 digest of the exact bytes supplied to esbuild. */
  digest: string;
  kind: 'workspace' | 'package';
  /** Required for every package-owned or compiler-runtime input. */
  package?: ReactUiPackageIdentity;
  /** Canonical import chain used to resolve this exact package instance without absolute-path trust. */
  resolution?: ReactUiPackageResolution;
}

export interface ReactUiPackageResolutionStep {
  specifier: string;
  importer:
    | { kind: 'workspace'; path: string }
    | { kind: 'package'; path: string; package: ReactUiPackageIdentity };
}

export interface ReactUiPackageResolution {
  schemaVersion: 1;
  steps: readonly ReactUiPackageResolutionStep[];
}

/** Complete, canonical input graph for a registered React compilation. */
export interface ReactUiBuildGraphAttestation {
  schemaVersion: 1;
  inputs: readonly ReactUiBuildInputAttestation[];
}

export interface RegisteredReactComponent {
  id: string;
  version: string;
  title: string;
  description?: string;
  entryPath: string;
  allowedPackages?: readonly string[];
  authoringProfile?: UiAuthoringProfileReference;
  audit: {
    reviewedBy: string;
    reviewedAt: string;
    /** SHA-256 hex digest of the registered entry source. */
    sourceDigest: string;
    /** Full immutable esbuild graph approved by the reviewer. */
    graph: ReactUiBuildGraphAttestation;
  };
}

export interface CompiledReactComponent {
  id: string;
  scopeKey: string;
  title: string;
  description?: string;
  sourceKind: 'workspace_file' | 'registered_component';
  sourcePath: string;
  sourceDigest: string;
  bundleDigest: string;
  /** SHA-256 of the exact immutable MCP App HTML persisted by the store. */
  htmlDigest: string;
  createdAt: string;
  resourceUri: string;
  html: string;
  inputs: readonly string[];
  /** Complete immutable compiler input graph used for live-workspace drift detection. */
  buildGraph?: ReactUiBuildGraphAttestation;
  /** Compiler-selected profile and fallback provenance. Optional only for pre-profile records. */
  authoringProfile?: UiAuthoringProfileProvenance;
  registeredComponent?: { id: string; version: string; reviewedBy: string; graphDigest: string };
}

/** Durable identity and recompilation recipe for one editable workspace application. */
export interface ReactUiWorkspaceBinding {
  version: '1.0.0';
  /** Stable digest of the source identity, render binding, and application contract. */
  key: string;
  entryPath: string;
  title: string;
  description?: string;
  authoringProfile?: UiAuthoringProfileReference;
  /** Portable renderer polling cadence. Server-side refresh remains serialized and bounded. */
  pollIntervalMs: number;
}

export interface ReactUiWorkspaceRevisionStatus {
  live: true;
  status: 'current' | 'updated' | 'compile_failed';
  checkedAt: string;
  componentId: string;
  sourceDigest: string;
  bundleDigest: string;
  revision: number;
  dependencyCount: number;
  pollIntervalMs: number;
  /** Bounded diagnostic for a failed attempted revision; the returned component remains last-good. */
  diagnostic?: string;
  incompatibility?: {
    code: 'authoring_profile_unavailable' | 'authoring_profile_incompatible';
    profile: UiAuthoringProfileReference;
  };
}

export interface ReactUiRender {
  id: string;
  scopeKey: string;
  componentId: string;
  createdAt: string;
  props: JsonObject;
  fallback: UiFallback;
  resourceUri: string;
  toolName: string;
  /** Immutable authority, presentation, profile, and state contract for this render. */
  application?: UiApplicationManifest;
  /** Present only for editable workspace source. The render ID remains stable across revisions. */
  workspace?: ReactUiWorkspaceBinding;
}

export interface McpAppsResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType: 'text/html;profile=mcp-app';
  _meta: McpAppsResourceMeta;
}

export interface McpAppsResourceContent {
  uri: string;
  mimeType: 'text/html;profile=mcp-app';
  text: string;
  _meta: McpAppsResourceMeta;
}

export interface McpAppsResourceMeta {
  ui: {
    resourceUri: string;
    csp: {
      connectDomains: readonly string[];
      resourceDomains: readonly string[];
      frameDomains: readonly string[];
      baseUriDomains: readonly string[];
    };
    prefersBorder: boolean;
  };
}

/** Transport-neutral tool shape understood by MCP Apps-compatible harness adapters. */
export interface UiRenderToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
  _meta: {
    ui: {
      resourceUri?: string;
      visibility: readonly ('model' | 'app')[];
    };
    'ui/resourceUri'?: string;
    'openai/widgetAccessible'?: boolean;
    'openai/visibility'?: 'public' | 'private';
  };
}

export interface UiRenderToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: JsonObject;
  /** Private hydration data delivered to the MCP App but hidden from the model. */
  _meta?: JsonObject;
}

/**
 * Optional resource/tool plane. A harness adapter maps this to MCP resources and
 * dynamically listed render tools; it contains no Codex-specific behavior.
 */
export interface ReactUiMcpAppsPort {
  readonly templateUri: string;
  listResources(context: InvocationContext): Promise<McpAppsResourceDescriptor[]>;
  readResource(uri: string, context: InvocationContext): Promise<McpAppsResourceContent>;
  templateDescriptor(): McpAppsResourceDescriptor;
  templateContent(): McpAppsResourceContent;
  toolMetadata(): UiRenderToolDescriptor['_meta'];
  listRenderTools(context: InvocationContext): Promise<UiRenderToolDescriptor[]>;
  invokeRenderTool(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<UiRenderToolResult | undefined>;
}
