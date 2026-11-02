import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { projectToolMetadata } from '@marshal/agent-runtime-manifest';
import { RUNTIME_CATALOG_ID_MAX_LENGTH } from '@marshal/agent-runtime-core';

const CONTEXT_PROPERTIES = {
  sessionId: {
    type: 'string',
    description:
      'Optional task identity claim. It is accepted only when it matches adapter-owned transport or session state.',
  },
  threadId: {
    type: 'string',
    description:
      'Optional thread identity claim. It is accepted only when it matches adapter-owned transport or session state.',
  },
  agentId: {
    type: 'string',
    description:
      'Optional agent identity claim. Principal and agent authority remain adapter-owned.',
  },
  workspacePath: {
    type: 'string',
    description:
      'Optional workspace claim. It must match the adapter-configured workspace.',
  },
  metadata: { type: 'object', additionalProperties: true },
} as const;

export const RUNTIME_TOOLS: readonly Tool[] = [
  {
    name: 'runtime_search',
    title: manifestTool('runtime_search').title,
    description: manifestTool('runtime_search').description,
    inputSchema: {
      type: 'object',
      properties: {
        protocolVersion: {
          type: 'string',
          description: 'Runtime protocol version; defaults to 1.0.0.',
        },
        query: {
          type: 'string',
          minLength: 1,
          description: 'Natural-language or capability-name search.',
        },
        name: {
          type: 'string',
          minLength: 1,
          description:
            'Exact capability name when it is already known. Exact lookup always returns full input/output schemas.',
        },
        catalogId: {
          type: 'string',
          minLength: 1,
          maxLength: RUNTIME_CATALOG_ID_MAX_LENGTH,
          description: 'Exact non-capability catalog ID for a skill, resource, host tool, or UI application.',
        },
        detail: {
          type: 'string',
          enum: ['summary', 'full', 'compact'],
          description:
            'Broad searches default to concise summary descriptors. "compact" is accepted as a Codex-adapter compatibility alias for "summary". Set "full" only when every matching schema is required.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        tags: { type: 'array', items: { type: 'string' } },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Deprecated alias for tags.',
        },
        context: { type: 'object', properties: CONTEXT_PROPERTIES, additionalProperties: false },
      },
      anyOf: [{ required: ['query'] }, { required: ['name'] }, { required: ['catalogId'] }],
      additionalProperties: true,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: 'runtime_exec',
    title: manifestTool('runtime_exec').title,
    description: `${manifestTool('runtime_exec').description} Call shapes: operation {targetType:"operation",target:"capability.name",input:{...}}; disposable TypeScript {targetType:"inline_module",source:"export default async (input) => input",input:{...}}; editable file {targetType:"module",module:{kind:"workspace_file",path:"relative/file.ts"},input:{...},timeoutMs:60000}. Deprecated compatibility forms {operation:"capability.name"} and {target:"capability.name"} remain accepted only when targetType is omitted.`,
    inputSchema: {
      type: 'object',
      properties: {
        protocolVersion: {
          type: 'string',
          description: 'Runtime protocol version; defaults to 1.0.0.',
        },
        targetType: {
          type: 'string',
          enum: ['operation', 'inline_module', 'module'],
          description:
            'Required discriminator: operation invokes a named capability, inline_module executes disposable source, and module executes editable workspace/artifact source.',
        },
        target: {
          type: 'string',
          minLength: 1,
          description:
            'Exact capability name returned by runtime_search. Required only for targetType=operation.',
        },
        operation: {
          type: 'string',
          minLength: 1,
          description: 'Deprecated operation alias accepted when targetType is omitted.',
          deprecated: true,
        },
        source: {
          type: 'string',
          minLength: 1,
          description:
            'Complete TypeScript module source. Export a default function receiving input. Required only for targetType=inline_module.',
        },
        module: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['inline', 'workspace_file', 'artifact'],
              description: 'Source location discriminator.',
            },
            source: {
              type: 'string',
              minLength: 1,
              description: 'TypeScript source for kind=inline.',
            },
            path: {
              type: 'string',
              minLength: 1,
              description:
                'Workspace-relative editable .ts/.tsx path for kind=workspace_file, or artifact path for kind=artifact.',
            },
            scope: {
              type: 'string',
              enum: ['workspace', 'project', 'session'],
              description: 'Artifact scope for kind=artifact.',
            },
            export: {
              type: 'string',
              minLength: 1,
              description: 'Named export to invoke; defaults to the module default export.',
            },
          },
          required: ['kind'],
          oneOf: [
            { properties: { kind: { const: 'inline' } }, required: ['source'] },
            { properties: { kind: { const: 'workspace_file' } }, required: ['path'] },
            { properties: { kind: { const: 'artifact' } }, required: ['path'] },
          ],
          additionalProperties: false,
        },
        input: {
          description:
            'JSON-serializable value passed to the operation or selected TypeScript export.',
        },
        executionMode: { type: 'string', enum: ['brokered', 'trusted_node'] },
        approval: { type: 'object', additionalProperties: true },
        context: { type: 'object', properties: CONTEXT_PROPERTIES, additionalProperties: false },
      },
      oneOf: [
        {
          properties: { targetType: { const: 'operation' } },
          required: ['targetType', 'target'],
        },
        {
          properties: { targetType: { const: 'inline_module' } },
          required: ['targetType', 'source'],
        },
        {
          properties: { targetType: { const: 'module' } },
          required: ['targetType', 'module'],
        },
        {
          title: 'Deprecated operation alias',
          description:
            'Compatibility form: operation names the capability when targetType is omitted.',
          deprecated: true,
          required: ['operation'],
          not: { required: ['targetType'] },
        },
        {
          title: 'Deprecated implicit target alias',
          description:
            'Compatibility form: target names an operation when targetType and operation are omitted.',
          deprecated: true,
          required: ['target'],
          allOf: [
            { not: { required: ['targetType'] } },
            { not: { required: ['operation'] } },
          ],
        },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'runtime_session_start',
    title: manifestTool('runtime_session_start').title,
    description: manifestTool('runtime_session_start').description,
    inputSchema: {
      type: 'object',
      properties: {
        protocolVersion: { type: 'string', description: 'Defaults to 1.0.0.' },
        eventId: { type: 'string', minLength: 1, maxLength: 512 },
        sessionId: { type: 'string', minLength: 1 },
        threadId: { type: 'string', minLength: 1 },
        agentId: { type: 'string' },
        workspacePath: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'runtime_observe_turn',
    title: manifestTool('runtime_observe_turn').title,
    description: manifestTool('runtime_observe_turn').description,
    inputSchema: {
      type: 'object',
      properties: {
        protocolVersion: { type: 'string', description: 'Defaults to 1.0.0.' },
        eventId: { type: 'string', minLength: 1, maxLength: 512 },
        sessionId: { type: 'string', minLength: 1 },
        kind: { type: 'string', enum: ['user_message', 'tool_result', 'assistant_turn'] },
        content: {},
        toolName: { type: 'string' },
        agentId: { type: 'string' },
        workspacePath: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['kind', 'content'],
      additionalProperties: true,
    },
  },
  {
    name: 'runtime_session_end',
    title: manifestTool('runtime_session_end').title,
    description: manifestTool('runtime_session_end').description,
    inputSchema: {
      type: 'object',
      properties: {
        protocolVersion: { type: 'string', description: 'Defaults to 1.0.0.' },
        eventId: { type: 'string', minLength: 1, maxLength: 512 },
        sessionId: { type: 'string', minLength: 1 },
        outcome: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
      additionalProperties: true,
    },
  },
];

export function createRuntimeRenderUiTool(metadata: Record<string, unknown>): Tool {
  const projection = manifestTool('runtime_render_ui');
  return {
    name: 'runtime_render_ui',
    title: projection.title,
    description: `${projection.description} Use ui.artifacts.create first; compiled React render IDs belong to runtime_render_component.`,
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: {
          type: 'string',
          minLength: 1,
          description: 'Scoped artifact id returned by ui.artifacts.create or ui.artifacts.list.',
        },
        revision: {
          type: 'integer',
          minimum: 1,
          description: 'Immutable artifact revision returned with the render instruction.',
        },
        documentDigest: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          description: 'SHA-256 digest binding this render request to the exact document revision.',
        },
        context: { type: 'object', properties: CONTEXT_PROPERTIES, additionalProperties: false },
      },
      required: ['artifactId', 'revision', 'documentDigest'],
      additionalProperties: false,
    },
    _meta: metadata,
  };
}

export function createRuntimeRenderComponentTool(metadata: Record<string, unknown>): Tool {
  const projection = manifestTool('runtime_render_component');
  return {
    name: 'runtime_render_component',
    title: projection.title,
    description: `${projection.description} Pass only the renderId returned by ui.render; artifact IDs, component IDs, and ui:// URIs are invalid.`,
    inputSchema: {
      type: 'object',
      properties: {
        renderId: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          description: 'Reusable scoped render id returned by ui.render.',
        },
        context: { type: 'object', properties: CONTEXT_PROPERTIES, additionalProperties: false },
      },
      required: ['renderId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: metadata,
  };
}

function manifestTool(name: string): NonNullable<ReturnType<typeof projectToolMetadata>> {
  const projection = projectToolMetadata(name);
  if (!projection) throw new Error(`Capability manifest has no tool projection for ${name}.`);
  return projection;
}
