import type { JsonObject } from '../coreTypes.js';
import type {
  UiRenderToolDescriptor,
  UiRenderToolResult,
} from '../types.js';

export type UiScalar = string | number | boolean | null;
export type UiTone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'info';

export type UiNode =
  | {
      type: 'stack';
      id: string;
      direction?: 'vertical' | 'horizontal';
      gap?: 'none' | 'small' | 'medium' | 'large';
      children: UiNode[];
    }
  | { type: 'card'; id: string; title?: string; children: UiNode[] }
  | { type: 'heading'; id: string; text: string; level?: 1 | 2 | 3 }
  | { type: 'text'; id: string; text: string; tone?: UiTone }
  | { type: 'badge'; id: string; text: string; tone?: UiTone }
  | {
      type: 'button';
      id: string;
      label: string;
      actionId: string;
      variant?: 'primary' | 'secondary' | 'danger';
    }
  | {
      type: 'input';
      id: string;
      name: string;
      label: string;
      inputType?: 'text' | 'number' | 'email';
      value?: UiScalar;
      placeholder?: string;
    }
  | {
      type: 'select';
      id: string;
      name: string;
      label: string;
      value?: UiScalar;
      options: Array<{ label: string; value: UiScalar }>;
    }
  | { type: 'progress'; id: string; value: number; label?: string }
  | { type: 'divider'; id: string }
  | {
      type: 'table';
      id: string;
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, UiScalar>>;
    };

export interface UiActionBinding {
  id: string;
  operation: string;
  input?: Record<string, UiScalar | UiScalar[]>;
  /** Maps an output field to one safe, top-level event field. */
  eventMap?: Record<string, string>;
  confirmation?: { title: string; message: string };
}

export interface DeclarativeUiDocument {
  protocolVersion: '1.0.0';
  title: string;
  description?: string;
  root: UiNode;
  actions?: UiActionBinding[];
}

export interface UiArtifact {
  id: string;
  scopeKey: string;
  revision: number;
  documentDigest: string;
  createdAt: string;
  updatedAt: string;
  document: DeclarativeUiDocument;
  resourceUri: string;
}

export interface UiArtifactRevisionReference {
  artifactId: string;
  revision: number;
  documentDigest: string;
}

export interface UiArtifactSummary {
  id: string;
  revision: number;
  documentDigest: string;
  title: string;
  description?: string;
  updatedAt: string;
  resourceUri: string;
}

export interface UiOperationInvoker {
  invoke(
    operation: string,
    input: JsonObject,
    context: import('../coreTypes.js').InvocationContext,
  ): Promise<unknown>;
}

export interface McpAppsResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType: 'text/html;profile=mcp-app';
  _meta: {
    ui: {
      resourceUri: string;
      csp: { connectDomains: []; resourceDomains: []; frameDomains: []; baseUriDomains: [] };
      prefersBorder: boolean;
    };
  };
}

export interface McpAppsResourceContent {
  uri: string;
  mimeType: 'text/html;profile=mcp-app';
  text: string;
  _meta: McpAppsResourceDescriptor['_meta'];
}

export interface McpAppsToolMetadata {
  ui: { resourceUri: string; visibility: ['model', 'app'] };
  'ui/resourceUri': string;
}

/** Minimal host port consumed by an MCP server's resource and tool handlers. */
export interface McpAppsResourcePort {
  readonly templateUri: string;
  listResources(
    context: import('../coreTypes.js').InvocationContext,
  ): Promise<McpAppsResourceDescriptor[]>;
  readResource(
    uri: string,
    context: import('../coreTypes.js').InvocationContext,
  ): Promise<McpAppsResourceContent>;
  templateDescriptor(): McpAppsResourceDescriptor;
  templateContent(): McpAppsResourceContent;
  toolMetadata(artifactOrUri?: UiArtifact | string): McpAppsToolMetadata;
  /** Metadata for the fixed compiled-React display tool, when configured. */
  reactToolMetadata?(): UiRenderToolDescriptor['_meta'];
  listRenderTools?(
    context: import('../coreTypes.js').InvocationContext,
  ): Promise<UiRenderToolDescriptor[]>;
  invokeRenderTool?(
    name: string,
    input: unknown,
    context: import('../coreTypes.js').InvocationContext,
  ): Promise<UiRenderToolResult | undefined>;
}
