import type { InvocationContext } from '@marshal/agent-runtime-core';
import { UiActionDispatcher } from './actionDispatcher.js';
import {
  UI_ACTION_TOOL_NAME,
  UI_CHROME_ACTION_REQUEST_METHOD,
  UI_DECLARED_TOOL_NAME,
  type UiActionToolInput,
  type UiDeclaredToolInput,
} from './applicationTypes.js';
import { REACT_UI_MCP_APP_MIME_TYPE } from './compiler.js';
import { UiDeclaredToolDispatcher } from './toolDispatcher.js';
import {
  REACT_UI_TEMPLATE_URI,
  LEGACY_REACT_UI_TEMPLATE_URI,
  HISTORICAL_REACT_UI_TEMPLATE_URIS,
  REACT_UI_PAYLOAD_TOOL_NAME,
  REACT_UI_STATE_TOOL_NAME,
  reactUiTemplateContent,
  reactUiTemplateDescriptor,
  reactUiToolMetadata,
} from './runtimeRenderer.js';
import type { ReactUiStorageMutation, ReactUiStore } from './store.js';
import type {
  CompiledReactComponent,
  JsonObject,
  McpAppsResourceContent,
  McpAppsResourceDescriptor,
  McpAppsResourceMeta,
  ReactUiMcpAppsPort,
  ReactUiRender,
  UiRenderToolDescriptor,
  UiRenderToolResult,
} from './types.js';
import type { ReactUiWorkspaceCoordinator } from './workspaceCoordinator.js';

export class ReactUiMcpAppsResourceAdapter implements ReactUiMcpAppsPort {
  readonly templateUri = REACT_UI_TEMPLATE_URI;
  constructor(
    private readonly store: ReactUiStore,
    private readonly actionDispatcher?: UiActionDispatcher,
    private readonly toolDispatcher?: UiDeclaredToolDispatcher,
    private readonly workspaceCoordinator?: ReactUiWorkspaceCoordinator,
  ) {}

  async listResources(context: InvocationContext): Promise<McpAppsResourceDescriptor[]> {
    return [
      reactUiTemplateDescriptor(),
      ...(await this.store.listComponents(context)).map(resourceDescriptor),
    ];
  }

  async readResource(uri: string, context: InvocationContext): Promise<McpAppsResourceContent> {
    if (
      uri === this.templateUri ||
      uri === LEGACY_REACT_UI_TEMPLATE_URI ||
      HISTORICAL_REACT_UI_TEMPLATE_URIS.includes(
        uri as (typeof HISTORICAL_REACT_UI_TEMPLATE_URIS)[number],
      )
    ) {
      return reactUiTemplateContent(uri);
    }
    const id = parseResourceUri(uri);
    const component = await this.store.getComponent(id, context);
    if (component.resourceUri !== uri) throw new Error('React UI resource URI mismatch');
    return {
      uri,
      mimeType: REACT_UI_MCP_APP_MIME_TYPE,
      text: component.html,
      _meta: resourceMeta(uri),
    };
  }

  templateDescriptor(): McpAppsResourceDescriptor {
    return reactUiTemplateDescriptor();
  }

  templateContent(): McpAppsResourceContent {
    return reactUiTemplateContent();
  }

  toolMetadata(): UiRenderToolDescriptor['_meta'] {
    return reactUiToolMetadata();
  }

  async listRenderTools(context: InvocationContext): Promise<UiRenderToolDescriptor[]> {
    const renders = await this.store.listRenders(context);
    return [
      reactUiPayloadToolDescriptor(),
      reactUiStateToolDescriptor(),
      ...(this.actionDispatcher ? [reactUiActionToolDescriptor()] : []),
      ...(this.toolDispatcher ? [reactUiDeclaredToolDescriptor()] : []),
      ...(await Promise.all(
      renders.map(async (render) => {
        const component = await this.store.getComponent(render.componentId, context);
        const name = dedicatedRenderToolName(render.id);
        return {
          name,
          title: `Render ${component.title}`,
          description: `Render the immutable ${component.title} MCP App with prepared props. The text fallback is always complete.`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          _meta: toolMetadata(render.workspace ? REACT_UI_TEMPLATE_URI : render.resourceUri),
        };
      }),
      )),
    ];
  }

  async invokeRenderTool(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<UiRenderToolResult | undefined> {
    if (name === UI_ACTION_TOOL_NAME) {
      if (!this.actionDispatcher) return undefined;
      const args = parseActionInput(input);
      const result = await this.actionDispatcher.invoke(args, context);
      return {
        content: [{ type: 'text', text: result.status === 'success' ? `Action ${args.actionId} completed.` : `Action ${args.actionId} ended with ${result.status}.` }],
        structuredContent: result as unknown as JsonObject,
      };
    }
    if (name === UI_DECLARED_TOOL_NAME) {
      if (!this.toolDispatcher) return undefined;
      const args = parseDeclaredToolInput(input);
      const result = await this.toolDispatcher.invoke(args, context);
      return {
        content: [{
          type: 'text',
          text: result.status === 'success'
            ? `Declared tool ${args.toolId} completed.`
            : `Declared tool ${args.toolId} ended with ${result.status}.`,
        }],
        structuredContent: result as unknown as JsonObject,
      };
    }
    if (name === REACT_UI_PAYLOAD_TOOL_NAME) {
      if (!isObject(input)) throw new Error(`${REACT_UI_PAYLOAD_TOOL_NAME} input must be an object`);
      const renderId = input.renderId;
      if (typeof renderId !== 'string' || !renderId) return undefined;
      if (Object.keys(input).some((key) => key !== 'renderId' && key !== 'knownComponentId')) {
        throw new Error(`${REACT_UI_PAYLOAD_TOOL_NAME} accepts only renderId and knownComponentId`);
      }
      const knownComponentId = input.knownComponentId;
      if (knownComponentId !== undefined && (typeof knownComponentId !== 'string' || !/^[a-f0-9]{64}$/.test(knownComponentId))) {
        throw new Error(`${REACT_UI_PAYLOAD_TOOL_NAME}.knownComponentId is invalid`);
      }
      const payloadRender = await this.store.getRender(renderId, context);
      const resolved = this.workspaceCoordinator
        ? await this.workspaceCoordinator.resolve(payloadRender, context)
        : { component: await this.store.getComponent(payloadRender.componentId, context) };
      const payloadComponent = resolved.component;
      const state = await this.store.getApplicationState(renderId, context);
      return {
        content: [{ type: 'text', text: 'Compiled React payload ready.' }],
        structuredContent: {
          props: payloadRender.props,
          fallback: payloadRender.fallback,
          render: {
            id: payloadRender.id,
            componentId: payloadComponent.id,
            title: payloadComponent.title,
          },
          marshal: {
            kind: 'compiled_react_ui',
            // A caller already holding this immutable, content-addressed
            // component (a live-workspace poll, a remount) gets no copy of it.
            componentHtml: knownComponentId === payloadComponent.id ? '' : payloadComponent.html,
            componentId: payloadComponent.id,
            bundleDigest: payloadComponent.bundleDigest,
            storage: state.local.values,
            state,
            application: payloadRender.application,
            workspace: resolved.workspace,
          },
        },
      };
    }
    if (name === REACT_UI_STATE_TOOL_NAME) {
      if (!isObject(input)) throw new Error(`${REACT_UI_STATE_TOOL_NAME} input must be an object`);
      const renderId = input.renderId;
      const operation = input.operation;
      if (typeof renderId !== 'string' || !renderId) return undefined;
      if (operation !== 'set' && operation !== 'remove' && operation !== 'clear') {
        throw new Error(`${REACT_UI_STATE_TOOL_NAME}.operation is invalid`);
      }
      const allowed = operation === 'set' ? ['renderId', 'operation', 'key', 'value', 'expectedVersion'] : operation === 'remove' ? ['renderId', 'operation', 'key', 'expectedVersion'] : ['renderId', 'operation', 'expectedVersion'];
      if (Object.keys(input).some((key) => !allowed.includes(key))) {
        throw new Error(`${REACT_UI_STATE_TOOL_NAME} received unexpected fields`);
      }
      const expectedVersion = input.expectedVersion === undefined
        ? undefined
        : requireInteger(input.expectedVersion, 'expectedVersion');
      const mutation: ReactUiStorageMutation = operation === 'clear'
        ? { operation: 'clear', ...(expectedVersion === undefined ? {} : { expectedVersion }) }
        : operation === 'remove'
          ? { operation: 'remove', key: requireString(input.key, 'key'), ...(expectedVersion === undefined ? {} : { expectedVersion }) }
          : {
              operation: 'set',
              key: requireString(input.key, 'key'),
              value: requireString(input.value, 'value', true),
              ...(expectedVersion === undefined ? {} : { expectedVersion }),
            };
      const values = await this.store.mutateRenderState(renderId, mutation, context);
      const state = await this.store.getApplicationState(renderId, context);
      return {
        content: [{ type: 'text', text: 'React UI state stored.' }],
        structuredContent: { stored: true, renderId, values, state: state.local },
      };
    }
    let render: ReactUiRender;
    if (name === 'runtime_render_component') {
      if (!isObject(input)) throw new Error('runtime_render_component input must be an object');
      const renderId = input.renderId;
      if (typeof renderId !== 'string' || !renderId) {
        return undefined;
      }
      if (Object.keys(input).some((key) => key !== 'renderId')) {
        throw new Error('runtime_render_component accepts only renderId for an existing render');
      }
      render = await this.store.getRender(renderId, context);
    } else if (name.startsWith('marshal_render_react_')) {
      if (input !== undefined && (!isObject(input) || Object.keys(input).length > 0)) {
        throw new Error('Dedicated React UI render tools do not accept arguments');
      }
      const renderId = name.slice('marshal_render_react_'.length);
      render = await this.store.getRender(renderId, context);
    } else {
      return undefined;
    }
    const resolved = this.workspaceCoordinator
      ? await this.workspaceCoordinator.resolve(render, context)
      : { component: await this.store.getComponent(render.componentId, context) };
    const component = resolved.component;
    return {
      content: [{ type: 'text', text: render.fallback.summary }],
      structuredContent: {
        props: render.props,
        fallback: render.fallback,
        render: {
          id: render.id,
          componentId: component.id,
          resourceUri: component.resourceUri,
          title: component.title,
        },
        application: render.application,
        workspace: resolved.workspace,
      },
      _meta: {
        marshal: {
          kind: 'compiled_react_ui',
          componentHtml: component.html,
          componentId: component.id,
          bundleDigest: component.bundleDigest,
          workspace: resolved.workspace,
        },
      },
    };
  }
}

export function reactUiPayloadToolDescriptor(): UiRenderToolDescriptor {
  return {
    name: REACT_UI_PAYLOAD_TOOL_NAME,
    title: 'Load compiled React payload',
    description: 'App-only lookup for a scoped React payload. Workspace render ids remain stable while successful compiled revisions advance immutably.',
    inputSchema: {
      type: 'object',
      properties: {
        renderId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        knownComponentId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        context: { type: 'object', additionalProperties: true },
      },
      required: ['renderId'],
      additionalProperties: false,
    },
    outputSchema: toolResultOutputSchema({
      type: 'object',
      properties: {
        props: { type: 'object', additionalProperties: true },
        fallback: { type: 'object', additionalProperties: true },
        render: { type: 'object', additionalProperties: true },
        marshal: {
          type: 'object',
          properties: {
            kind: { const: 'compiled_react_ui' },
            componentHtml: { type: 'string' },
            componentId: { type: 'string' },
            bundleDigest: { type: 'string' },
            storage: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
            state: { type: 'object', additionalProperties: true },
            application: { type: 'object', additionalProperties: true },
            workspace: { type: 'object', additionalProperties: true },
          },
          required: ['kind', 'componentHtml', 'componentId', 'bundleDigest', 'storage'],
          additionalProperties: false,
        },
      },
      required: ['props', 'fallback', 'render', 'marshal'],
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: appOnlyMetadata(),
  };
}

export function reactUiStateToolDescriptor(): UiRenderToolDescriptor {
  return {
    name: REACT_UI_STATE_TOOL_NAME,
    title: 'Store compiled React state',
    description: 'App-only scoped persistence for a compiled React render.',
    inputSchema: {
      type: 'object',
      properties: {
        renderId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        operation: { type: 'string', enum: ['set', 'remove', 'clear'] },
        key: { type: 'string', minLength: 1, maxLength: 512 },
        value: { type: 'string' },
        expectedVersion: { type: 'integer', minimum: 0 },
        context: { type: 'object', additionalProperties: true },
      },
      required: ['renderId', 'operation'],
      additionalProperties: false,
    },
    outputSchema: toolResultOutputSchema({
      type: 'object',
      properties: {
        stored: { const: true },
        renderId: { type: 'string' },
        values: { type: 'object', additionalProperties: { type: 'string' } },
        state: { type: 'object', additionalProperties: true },
      },
      required: ['stored', 'renderId'],
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: appOnlyMetadata(),
  };
}

export function reactUiActionToolDescriptor(): UiRenderToolDescriptor {
  return {
    name: UI_ACTION_TOOL_NAME,
    title: 'Invoke a declared React application action',
    description: 'App-only dispatcher for immutable, schema-validated module or capability action bindings.',
    inputSchema: {
      type: 'object',
      properties: {
        renderId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        actionId: { type: 'string', minLength: 1, maxLength: 256 },
        input: {},
        scope: { type: 'string', enum: ['session', 'project', 'workspace'] },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 512 },
        approval: { type: 'object' },
        activation: {
          type: 'object',
          properties: {
            requestId: { type: 'string', minLength: 1, maxLength: 256 },
            surface: { const: 'outer-renderer-chrome' },
            method: { const: UI_CHROME_ACTION_REQUEST_METHOD },
            activatedAt: { type: 'string', minLength: 1, maxLength: 64 },
            dispatchedAt: { type: 'string', minLength: 1, maxLength: 64 },
          },
          required: ['requestId', 'surface', 'method', 'activatedAt', 'dispatchedAt'],
          additionalProperties: false,
        },
      },
      required: ['renderId', 'actionId', 'scope'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: appOnlyMetadata(),
  };
}

export function reactUiDeclaredToolDescriptor(): UiRenderToolDescriptor {
  return {
    name: UI_DECLARED_TOOL_NAME,
    title: 'Invoke a render-declared React application tool',
    description: 'App-only server-authoritative dispatcher bound to one immutable render manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        renderId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        toolId: { type: 'string', minLength: 1, maxLength: 256 },
        input: {},
      },
      required: ['renderId', 'toolId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: appOnlyMetadata(),
  };
}

function appOnlyMetadata(): UiRenderToolDescriptor['_meta'] {
  return {
    ui: { visibility: ['app'] },
    'openai/widgetAccessible': true,
    'openai/visibility': 'private',
  };
}

function toolResultOutputSchema(successSchema: JsonObject): JsonObject {
  return {
    type: 'object',
    oneOf: [
      successSchema,
      {
        type: 'object',
        properties: {
          error: { type: 'string' },
          code: { type: 'string' },
        },
        required: ['error', 'code'],
        additionalProperties: false,
      },
    ],
  };
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${REACT_UI_STATE_TOOL_NAME}.${field} must be a string`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${REACT_UI_STATE_TOOL_NAME}.${field} must be a non-negative integer`);
  }
  return value as number;
}

function requireObject(value: unknown, field: string): JsonObject {
  if (!isObject(value)) throw new Error(`${UI_ACTION_TOOL_NAME}.${field} must be an object`);
  return value;
}

function parseActionInput(value: unknown): UiActionToolInput {
  if (!isObject(value)) throw new Error(`${UI_ACTION_TOOL_NAME} input must be an object`);
  const allowed = ['renderId', 'actionId', 'input', 'scope', 'idempotencyKey', 'approval', 'activation'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${UI_ACTION_TOOL_NAME} received unexpected fields`);
  }
  const scope = value.scope;
  if (scope !== 'session' && scope !== 'project' && scope !== 'workspace') {
    throw new Error(`${UI_ACTION_TOOL_NAME}.scope is invalid`);
  }
  return {
    renderId: requireString(value.renderId, 'renderId'),
    actionId: requireString(value.actionId, 'actionId'),
    input: value.input,
    scope,
    ...(value.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: requireString(value.idempotencyKey, 'idempotencyKey') }),
    ...(value.approval === undefined
      ? {}
      : { approval: requireObject(value.approval, 'approval') }),
    ...(value.activation === undefined ? {} : { activation: parseActionActivation(value.activation) }),
  };
}

function parseActionActivation(value: unknown): UiActionToolInput['activation'] {
  const activation = requireObject(value, 'activation');
  const allowed = ['requestId', 'surface', 'method', 'activatedAt', 'dispatchedAt'];
  if (Object.keys(activation).some((key) => !allowed.includes(key))) {
    throw new Error(`${UI_ACTION_TOOL_NAME}.activation received unexpected fields`);
  }
  if (
    activation.surface !== 'outer-renderer-chrome' ||
    activation.method !== UI_CHROME_ACTION_REQUEST_METHOD
  ) throw new Error(`${UI_ACTION_TOOL_NAME}.activation origin is invalid`);
  const activatedAt = requireString(activation.activatedAt, 'activation.activatedAt');
  const dispatchedAt = requireString(activation.dispatchedAt, 'activation.dispatchedAt');
  if (!Number.isFinite(Date.parse(activatedAt)) || !Number.isFinite(Date.parse(dispatchedAt))) {
    throw new Error(`${UI_ACTION_TOOL_NAME}.activation timestamps are invalid`);
  }
  return {
    requestId: requireString(activation.requestId, 'activation.requestId'),
    surface: 'outer-renderer-chrome',
    method: UI_CHROME_ACTION_REQUEST_METHOD,
    activatedAt,
    dispatchedAt,
  };
}

function parseDeclaredToolInput(value: unknown): UiDeclaredToolInput {
  if (!isObject(value)) throw new Error(`${UI_DECLARED_TOOL_NAME} input must be an object`);
  const allowed = ['renderId', 'toolId', 'input'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${UI_DECLARED_TOOL_NAME} received unexpected fields`);
  }
  return {
    renderId: requireString(value.renderId, 'renderId'),
    toolId: requireString(value.toolId, 'toolId'),
    input: value.input,
  };
}

function dedicatedRenderToolName(renderId: string): string {
  return `marshal_render_react_${renderId}`;
}

export function resourceDescriptor(component: CompiledReactComponent): McpAppsResourceDescriptor {
  return {
    uri: component.resourceUri,
    name: component.title,
    description: component.description,
    mimeType: REACT_UI_MCP_APP_MIME_TYPE,
    _meta: resourceMeta(component.resourceUri),
  };
}

export function resourceMeta(resourceUri: string): McpAppsResourceMeta {
  return {
    ui: {
      resourceUri,
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
      prefersBorder: true,
    },
  };
}

export function toolMetadata(resourceUri: string): UiRenderToolDescriptor['_meta'] {
  return {
    ui: { resourceUri, visibility: ['model', 'app'] },
    'ui/resourceUri': resourceUri,
  };
}

function parseResourceUri(uri: string): string {
  const match = /^ui:\/\/marshal-react\/([a-f0-9]{64})\/index\.html$/.exec(uri);
  if (!match) throw new Error('Invalid React UI resource URI');
  return match[1];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
