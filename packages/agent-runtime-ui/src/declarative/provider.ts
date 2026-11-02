import { randomUUID } from 'node:crypto';
import type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationContext,
  JsonObject,
  PermissionApprovalDecision,
  RuntimeError,
  RuntimeExecutionStatus,
  RuntimeExecResponse,
} from '../coreTypes.js';
import { RUNTIME_PROTOCOL_VERSION, asObject, requireString } from '../coreTypes.js';
import { UiActionDispatcher } from '../actionDispatcher.js';
import type {
  UiActionDeclaration,
  UiApplicationManifest,
} from '../applicationTypes.js';
import {
  parseDeclarativeUiResourceUri,
  type DeclarativeUiStore,
} from './store.js';
import type { DeclarativeUiMcpAppsResourceAdapter } from './mcpAppsResourceAdapter.js';
import type {
  UiActionBinding,
  UiArtifact,
  UiArtifactRevisionReference,
  UiOperationInvoker,
} from './types.js';
import { buildActionInput, validateUiEvent } from './validation.js';

const VERSION = '1.0.0';
const OPERATIONS = [
  'ui.artifacts.create',
  'ui.artifacts.update',
  'ui.artifacts.get',
  'ui.artifacts.list',
  'ui.artifacts.delete',
  'ui.actions.invoke',
] as const;

export interface DeclarativeUiProviderOptions {
  store: DeclarativeUiStore;
  resources: DeclarativeUiMcpAppsResourceAdapter;
  operationInvoker?: UiOperationInvoker;
  allowedOperations?: readonly string[];
  allowOperation?: (operation: string) => boolean;
}

export class DeclarativeUiProvider implements CapabilityProvider {
  readonly id = 'portable.declarative-ui';
  readonly version = VERSION;
  private readonly actionDispatcher?: UiActionDispatcher;

  constructor(private readonly options: DeclarativeUiProviderOptions) {
    if (options.operationInvoker) {
      this.actionDispatcher = new UiActionDispatcher({
        loadApplication: async (resourceUri, context) => {
          const reference = parseDeclarativeUiResourceUri(resourceUri);
          const artifact = await options.store.getRevision(
            reference.id,
            reference.revision,
            reference.documentDigest,
            context,
          );
          return actionApplication(artifact);
        },
        authorize: {
          authorize: () => ({
            decision: 'allow',
            reason:
              'The declarative action target was allow-listed; the target runtime still owns permission enforcement.',
          }),
        },
        executor: {
          execute: async (request, context) => {
            if (request.action.target.kind !== 'capability')
              throw new Error('Declarative UI actions may target only runtime capabilities');
            const operation = request.action.target.capability;
            try {
              const response = await options.operationInvoker!.invoke(
                operation,
                asObject(request.input, 'action input'),
                context,
              );
              return normalizeOperationResponse(response, operation, context);
            } catch (error) {
              return normalizeOperationError(error, operation, context);
            }
          },
        },
        idempotencyStore: options.store.actionIdempotencyStore,
        journalStore: options.store.actionIdempotencyStore,
      });
    }
  }

  list(): readonly CapabilityDescriptor[] {
    return OPERATIONS.map(descriptor);
  }

  get(name: string): CapabilityDescriptor | undefined {
    return OPERATIONS.includes(name as (typeof OPERATIONS)[number])
      ? descriptor(name as (typeof OPERATIONS)[number])
      : undefined;
  }

  async invoke(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<CapabilityInvocationResult> {
    const args = asObject(input);
    switch (name) {
      case 'ui.artifacts.create': {
        this.validateActionOperations(args.document);
        const artifact = await this.options.store.create(args.document, context);
        return this.artifactResult(artifact);
      }
      case 'ui.artifacts.update': {
        this.validateActionOperations(args.document);
        const artifact = await this.options.store.update(
          requireString(args.artifactId, 'artifactId', 128),
          args.document,
          context,
          optionalInteger(args.expectedRevision),
        );
        return this.artifactResult(artifact);
      }
      case 'ui.artifacts.get': {
        const reference = optionalArtifactReference(args);
        const artifact = reference
          ? await this.options.store.getRevision(
              reference.artifactId,
              reference.revision,
              reference.documentDigest,
              context,
            )
          : await this.options.store.get(
              requireString(args.artifactId, 'artifactId', 128),
              context,
            );
        return this.artifactResult(artifact);
      }
      case 'ui.artifacts.list':
        return { output: { artifacts: await this.options.store.list(context) } };
      case 'ui.artifacts.delete': {
        const artifactId = requireString(args.artifactId, 'artifactId', 128);
        return {
          output: { artifactId, deleted: await this.options.store.delete(artifactId, context) },
          receipt: { operation: name, artifactId, at: new Date().toISOString() },
        };
      }
      case 'ui.actions.invoke': {
        if (!this.actionDispatcher)
          throw new Error('No UI operation invoker is configured');
        const reference = requiredArtifactReference(args);
        const artifact = await this.options.store.getRevision(
          reference.artifactId,
          reference.revision,
          reference.documentDigest,
          context,
        );
        const actionId = requireString(args.actionId, 'actionId', 128);
        const action = artifact.document.actions?.find((candidate) => candidate.id === actionId);
        if (!action) throw new Error(`UI action ${actionId} does not exist`);
        this.assertOperationAllowed(action.operation);
        if (action.confirmation && args.confirmed !== true) {
          return {
            output: {
              status: 'confirmation_required',
              artifactId: artifact.id,
              revision: artifact.revision,
              documentDigest: artifact.documentDigest,
              actionId,
              confirmation: action.confirmation,
            },
          };
        }
        const event = validateUiEvent(args.event ?? {});
        const operationInput = buildActionInput(action, event);
        const idempotencyKey = validatedIdempotencyKey(args.idempotencyKey);
        const dispatched = await this.actionDispatcher.invoke(
          {
            renderId: artifact.resourceUri,
            actionId,
            input: operationInput,
            scope: 'session',
            idempotencyKey,
          },
          context,
        );
        const status = dispatched.status === 'success'
          ? 'completed'
          : dispatched.status === 'not_found'
            ? 'failed'
            : dispatched.status;
        const receipt = {
          ...dispatched.receipt,
          artifactId: artifact.id,
          revision: artifact.revision,
          documentDigest: artifact.documentDigest,
          operation: action.operation,
        };
        return {
          output: {
            status,
            artifactId: artifact.id,
            revision: artifact.revision,
            documentDigest: artifact.documentDigest,
            actionId,
            operation: action.operation,
            ...(status === 'completed' ? { output: dispatched.output ?? null } : {}),
            ...(dispatched.error ? { error: dispatched.error } : {}),
            ...(dispatched.approval ? { approval: dispatched.approval } : {}),
          },
          receipt,
        };
      }
      default:
        throw new Error(`Unknown declarative UI capability: ${name}`);
    }
  }

  private artifactResult(
    artifact: Awaited<ReturnType<DeclarativeUiStore['get']>>,
  ): CapabilityInvocationResult {
    const resource = this.options.resources.descriptor(artifact);
    return {
      output: {
        artifact,
        resource,
        toolMetadata: this.options.resources.toolMetadata(),
        render: {
          tool: 'runtime_render_ui',
          arguments: {
            artifactId: artifact.id,
            revision: artifact.revision,
            documentDigest: artifact.documentDigest,
          },
          resourceUri: this.options.resources.templateUri,
        },
      },
      artifacts: [
        {
          id: artifact.id,
          kind: 'agent_ui',
          uri: artifact.resourceUri,
          mediaType: resource.mimeType,
          metadata: {
            revision: artifact.revision,
            documentDigest: artifact.documentDigest,
            csp: resource._meta.ui.csp,
          },
        },
      ],
      receipt: {
        artifactId: artifact.id,
        revision: artifact.revision,
        documentDigest: artifact.documentDigest,
        resourceUri: artifact.resourceUri,
        at: new Date().toISOString(),
      },
    };
  }

  private validateActionOperations(document: unknown): void {
    if (!document || typeof document !== 'object') return;
    const actions = (document as { actions?: UiActionBinding[] }).actions ?? [];
    for (const action of actions) this.assertOperationAllowed(action.operation);
  }

  private assertOperationAllowed(operation: string): void {
    const explicitlyAllowed = this.options.allowedOperations?.includes(operation) ?? false;
    const allowedByCallback = this.options.allowOperation?.(operation) ?? false;
    if (!explicitlyAllowed && !allowedByCallback)
      throw new Error(`UI action operation ${operation} is not allow-listed`);
    if (operation.startsWith('ui.actions.'))
      throw new Error('UI actions cannot recursively invoke the UI action bridge');
  }
}

function descriptor(name: (typeof OPERATIONS)[number]): CapabilityDescriptor {
  const mutating =
    name.endsWith('create') ||
    name.endsWith('update') ||
    name.endsWith('delete') ||
    name.endsWith('invoke');
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: VERSION,
    title: name.replaceAll('.', ' '),
    description: `${name.split('.').at(-1)} a scoped declarative UI artifact. Authored HTML, JavaScript, CSS, and network access are never accepted.`,
    tags: ['ui', 'artifact', 'declarative', 'mcp-apps'],
    inputSchema: uiInputSchema(name),
    outputSchema: uiOutputSchema(name),
    permissions: [
      {
        permission: name,
        risk: mutating ? 'medium' : 'low',
        reason: mutating
          ? 'Changes scoped UI state or invokes an allow-listed host operation.'
          : 'Reads scoped UI state.',
      },
    ],
    annotations: name.startsWith('ui.artifacts.')
      ? { mcpApps: { resourceMimeType: 'text/html;profile=mcp-app' } }
      : undefined,
  };
}

function uiOutputSchema(name: (typeof OPERATIONS)[number]): JsonObject {
  switch (name) {
    case 'ui.artifacts.create':
    case 'ui.artifacts.update':
    case 'ui.artifacts.get':
      return artifactResultSchema();
    case 'ui.artifacts.list':
      return strictObject({
        artifacts: { type: 'array', maxItems: 10_000, items: artifactSummarySchema() },
      }, ['artifacts']);
    case 'ui.artifacts.delete':
      return strictObject({
        artifactId: { type: 'string', maxLength: 128 }, deleted: { type: 'boolean' },
      }, ['artifactId', 'deleted']);
    case 'ui.actions.invoke':
      return {
        type: 'object',
        properties: {
          status: {
            enum: [
              'confirmation_required',
              'completed',
              'denied',
              'cancelled',
              'approval_required',
              'failed',
            ],
          },
          artifactId: { type: 'string', maxLength: 128 },
          revision: { type: 'integer', minimum: 1 },
          documentDigest: digestSchema(),
          actionId: { type: 'string', maxLength: 128 },
          operation: { type: 'string', maxLength: 128 },
          output: {},
          confirmation: strictObject({
            title: { type: 'string', maxLength: 200 },
            message: { type: 'string', maxLength: 1_000 },
          }, ['title', 'message']),
          error: runtimeErrorSchema(),
          approval: {},
        },
        required: ['status', 'artifactId', 'revision', 'documentDigest', 'actionId'],
        additionalProperties: false,
        oneOf: [
          {
            properties: { status: { const: 'confirmation_required' } },
            required: ['confirmation'],
          },
          {
            properties: { status: { const: 'completed' } },
            required: ['operation', 'output'],
          },
          {
            properties: {
            status: { enum: ['denied', 'cancelled', 'approval_required', 'failed'] },
            },
            required: ['operation'],
          },
        ],
      };
  }
}

function strictObject(properties: JsonObject, required: readonly string[]): JsonObject {
  return { type: 'object', properties, required, additionalProperties: false };
}

type DeclarativeDocumentJsonSchema = JsonObject & { readonly $defs: JsonObject };

function artifactSchema(
  document: DeclarativeDocumentJsonSchema = declarativeDocumentSchema(),
): JsonObject {
  return strictObject({
    id: { type: 'string', maxLength: 128 }, scopeKey: { type: 'string', maxLength: 512 },
    revision: { type: 'integer', minimum: 1 }, documentDigest: digestSchema(),
    createdAt: { type: 'string', maxLength: 64 },
    updatedAt: { type: 'string', maxLength: 64 }, document,
    resourceUri: { type: 'string', maxLength: 8_192 },
  }, ['id', 'scopeKey', 'revision', 'documentDigest', 'createdAt', 'updatedAt', 'document', 'resourceUri']);
}

function artifactSummarySchema(): JsonObject {
  return strictObject({
    id: { type: 'string', maxLength: 128 }, revision: { type: 'integer', minimum: 1 },
    documentDigest: digestSchema(),
    title: { type: 'string', maxLength: 256 }, description: { type: 'string', maxLength: 2_000 },
    updatedAt: { type: 'string', maxLength: 64 }, resourceUri: { type: 'string', maxLength: 8_192 },
  }, ['id', 'revision', 'documentDigest', 'title', 'updatedAt', 'resourceUri']);
}

function artifactResultSchema(): JsonObject {
  const document = declarativeDocumentSchema();
  const stringList = { type: 'array', maxItems: 1_000, items: { type: 'string', maxLength: 8_192 } };
  return withDeclarativeDocumentDefinitions(strictObject({
    artifact: artifactSchema(document),
    resource: strictObject({
      uri: { type: 'string', maxLength: 8_192 }, name: { type: 'string', maxLength: 256 },
      description: { type: 'string', maxLength: 2_000 }, mimeType: { const: 'text/html;profile=mcp-app' },
      _meta: strictObject({ ui: strictObject({
        resourceUri: { type: 'string', maxLength: 8_192 },
        csp: strictObject({ connectDomains: stringList, resourceDomains: stringList, frameDomains: stringList, baseUriDomains: stringList }, ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains']),
        prefersBorder: { type: 'boolean' },
      }, ['resourceUri', 'csp', 'prefersBorder']) }, ['ui']),
    }, ['uri', 'name', 'mimeType', '_meta']),
    toolMetadata: strictObject({
      ui: strictObject({ resourceUri: { type: 'string', maxLength: 8_192 }, visibility: { type: 'array', maxItems: 2, items: { enum: ['model', 'app'] } } }, ['resourceUri', 'visibility']),
      'ui/resourceUri': { type: 'string', maxLength: 8_192 },
    }, ['ui', 'ui/resourceUri']),
    render: strictObject({
      tool: { const: 'runtime_render_ui' },
      arguments: strictObject({
        artifactId: { type: 'string', maxLength: 128 },
        revision: { type: 'integer', minimum: 1 },
        documentDigest: digestSchema(),
      }, ['artifactId', 'revision', 'documentDigest']),
      resourceUri: { type: 'string', maxLength: 8_192 },
    }, ['tool', 'arguments', 'resourceUri']),
  }, ['artifact', 'resource', 'toolMetadata', 'render']), document);
}

function uiInputSchema(name: (typeof OPERATIONS)[number]): JsonObject {
  const artifactId = { type: 'string', minLength: 1, maxLength: 128 };
  const document = declarativeDocumentSchema();
  switch (name) {
    case 'ui.artifacts.create':
      return withDeclarativeDocumentDefinitions({
        type: 'object',
        properties: { document },
        required: ['document'],
        additionalProperties: false,
      }, document);
    case 'ui.artifacts.update':
      return withDeclarativeDocumentDefinitions({
        type: 'object',
        properties: { artifactId, document, expectedRevision: { type: 'integer', minimum: 1 } },
        required: ['artifactId', 'document'],
        additionalProperties: false,
      }, document);
    case 'ui.artifacts.get':
      return {
        type: 'object',
        properties: {
          artifactId,
          revision: { type: 'integer', minimum: 1 },
          documentDigest: digestSchema(),
        },
        required: ['artifactId'],
        additionalProperties: false,
        oneOf: [
          {
            not: {
              anyOf: [
                { required: ['revision'] },
                { required: ['documentDigest'] },
              ],
            },
          },
          { required: ['revision', 'documentDigest'] },
        ],
      };
    case 'ui.artifacts.delete':
      return {
        type: 'object',
        properties: { artifactId },
        required: ['artifactId'],
        additionalProperties: false,
      };
    case 'ui.artifacts.list':
      return { type: 'object', additionalProperties: false };
    case 'ui.actions.invoke':
      return {
        type: 'object',
        properties: {
          artifactId,
          revision: { type: 'integer', minimum: 1 },
          documentDigest: digestSchema(),
          actionId: { type: 'string', minLength: 1, maxLength: 128 },
          event: {
            type: 'object',
            maxProperties: 32,
            propertyNames: {
              pattern:
                '^(?!(?:__proto__|prototype|constructor)$)[A-Za-z][A-Za-z0-9._-]{0,63}$',
            },
            additionalProperties: scalarOrScalarArraySchema(4_000),
          },
          confirmed: { type: 'boolean' },
          idempotencyKey: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            pattern: '^[A-Za-z0-9._:-]+$',
          },
        },
        required: [
          'artifactId',
          'revision',
          'documentDigest',
          'actionId',
          'idempotencyKey',
        ],
        additionalProperties: false,
      };
  }
}

function withDeclarativeDocumentDefinitions(
  schema: JsonObject,
  document: DeclarativeDocumentJsonSchema,
): JsonObject {
  // Local JSON Schema references resolve from the capability schema root.
  // Keep document-local definitions for authoring clients and mirror them at that root.
  return { ...schema, $defs: document.$defs };
}

/** Publish the complete recursive contract so agents do not have to infer it from validation errors. */
function declarativeDocumentSchema(): DeclarativeDocumentJsonSchema {
  const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,127}$' };
  const scalar = { type: ['string', 'number', 'boolean', 'null'] };
  const nodeBase = (type: string, properties: JsonObject, required: readonly string[]) => ({
    type: 'object',
    properties: { type: { const: type }, id, ...properties },
    required: ['type', 'id', ...required],
    additionalProperties: false,
  });
  const childNodes = { type: 'array', maxItems: 500, items: { $ref: '#/$defs/uiNode' } };
  const uiNode = {
    description:
      'A strict safe node. Every node requires a unique id; authored HTML, CSS, and JavaScript are not accepted.',
    oneOf: [
      nodeBase('stack', {
        direction: { type: 'string', enum: ['vertical', 'horizontal'] },
        gap: { type: 'string', enum: ['none', 'small', 'medium', 'large'] },
        children: childNodes,
      }, ['children']),
      nodeBase('card', { title: { type: 'string', maxLength: 1_000 }, children: childNodes }, ['children']),
      nodeBase('heading', {
        text: { type: 'string', maxLength: 32_000 },
        level: { type: 'integer', enum: [1, 2, 3] },
      }, ['text']),
      nodeBase('text', {
        text: { type: 'string', maxLength: 32_000 },
        tone: { type: 'string', enum: ['default', 'muted', 'success', 'warning', 'danger', 'info'] },
      }, ['text']),
      nodeBase('badge', {
        text: { type: 'string', maxLength: 32_000 },
        tone: { type: 'string', enum: ['default', 'muted', 'success', 'warning', 'danger', 'info'] },
      }, ['text']),
      nodeBase('button', {
        label: { type: 'string', maxLength: 1_000 },
        actionId: id,
        variant: { type: 'string', enum: ['primary', 'secondary', 'danger'] },
      }, ['label', 'actionId']),
      nodeBase('input', {
        name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$' },
        label: { type: 'string', maxLength: 1_000 },
        inputType: { type: 'string', enum: ['text', 'number', 'email'] },
        value: scalar,
        placeholder: { type: 'string', maxLength: 32_000 },
      }, ['name', 'label']),
      nodeBase('select', {
        name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$' },
        label: { type: 'string', maxLength: 1_000 },
        value: scalar,
        options: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            properties: { label: { type: 'string', maxLength: 1_000 }, value: scalar },
            required: ['label', 'value'],
            additionalProperties: false,
          },
        },
      }, ['name', 'label', 'options']),
      nodeBase('progress', {
        value: { type: 'number', minimum: 0, maximum: 100 },
        label: { type: 'string', maxLength: 1_000 },
      }, ['value']),
      nodeBase('divider', {}, []),
      nodeBase('table', {
        columns: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$' },
              label: { type: 'string', maxLength: 1_000 },
            },
            required: ['key', 'label'],
            additionalProperties: false,
          },
        },
        rows: {
          type: 'array', maxItems: 1_000,
          items: { type: 'object', additionalProperties: scalar },
        },
      }, ['columns', 'rows']),
    ],
  };
  return {
    type: 'object',
    description:
      'Strict DeclarativeUiDocument for a safe fallback UI. Prefer compiled React for custom, interactive, or runtime-backed applications.',
    properties: {
      protocolVersion: { const: '1.0.0' },
      title: { type: 'string', minLength: 1, maxLength: 256 },
      description: { type: 'string', maxLength: 2_000 },
      root: { $ref: '#/$defs/uiNode' },
      actions: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          properties: {
            id,
            operation: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{1,127}$' },
            input: { type: 'object', additionalProperties: { oneOf: [scalar, { type: 'array', maxItems: 100, items: scalar }] } },
            eventMap: { type: 'object', additionalProperties: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$' } },
            confirmation: {
              type: 'object',
              properties: {
                title: { type: 'string', maxLength: 200 },
                message: { type: 'string', maxLength: 1_000 },
              },
              required: ['title', 'message'],
              additionalProperties: false,
            },
          },
          required: ['id', 'operation'],
          additionalProperties: false,
        },
      },
    },
    required: ['protocolVersion', 'title', 'root'],
    additionalProperties: false,
    $defs: { uiNode },
  };
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new Error('expectedRevision must be a positive integer');
  return value as number;
}

function requiredArtifactReference(args: JsonObject): UiArtifactRevisionReference {
  return {
    artifactId: requireString(args.artifactId, 'artifactId', 128),
    revision: requiredPositiveInteger(args.revision, 'revision'),
    documentDigest: requiredDigest(args.documentDigest, 'documentDigest'),
  };
}

function optionalArtifactReference(args: JsonObject): UiArtifactRevisionReference | undefined {
  const supplied =
    args.revision !== undefined ||
    args.documentDigest !== undefined;
  if (!supplied) return undefined;
  return requiredArtifactReference(args);
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function requiredDigest(value: unknown, field: string): string {
  const digest = requireString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

function validatedIdempotencyKey(value: unknown): string {
  const key = requireString(value, 'idempotencyKey', 256);
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new Error('idempotencyKey is invalid');
  return key;
}

function actionApplication(artifact: UiArtifact): UiApplicationManifest {
  return {
    version: '1.0.0',
    presentationModes: ['inline'],
    tools: [],
    actions: (artifact.document.actions ?? []).map((action) =>
      actionDeclaration(action, artifact)
    ),
  };
}

function actionDeclaration(
  action: UiActionBinding,
  artifact: UiArtifact,
): UiActionDeclaration {
  return {
    id: action.id,
    version: `${artifact.revision}:${artifact.documentDigest}`,
    title: action.confirmation?.title,
    description: action.confirmation?.message,
    target: { kind: 'capability', capability: action.operation },
    inputSchema: {
      type: 'object',
      maxProperties: 256,
      additionalProperties: scalarOrScalarArraySchema(),
    },
    outputSchema: {},
    allowedScopes: ['session'],
    requiredPermissions: [action.operation],
    risk: 'external-effect',
    idempotency: 'required',
  };
}

function normalizeOperationResponse(
  value: unknown,
  operation: string,
  context: InvocationContext,
): RuntimeExecResponse {
  const mcp = isRecord(value) ? value : undefined;
  const candidate = isRecord(mcp?.structuredContent) ? mcp.structuredContent : value;
  if (mcp?.isError === true) {
    return syntheticOperationResponse(
      {
        status: 'failed',
        error: mcpError(candidate, mcp),
      },
      operation,
      context,
    );
  }
  const response = isRuntimeExecResponse(candidate)
    ? candidate
    : syntheticOperationResponse(candidate, operation, context);
  if (response.status !== 'success') return response;
  const output = response.result?.output;
  const record = isRecord(output) ? output : undefined;
  const outputStatus = typeof record?.status === 'string' ? record.status : undefined;
  if (
    !record ||
    outputStatus !== 'denied' &&
    outputStatus !== 'cancelled' &&
    outputStatus !== 'approval_required' &&
    outputStatus !== 'failed'
  ) {
    return response;
  }
  const status = outputStatus as Exclude<RuntimeExecutionStatus, 'success' | 'not_found'>;
  const receipt = { ...response.receipt, status };
  if (status === 'approval_required') {
    return {
      ...response,
      status,
      approval: outputApproval(record),
      receipt,
    };
  }

  return {
    ...response,
    status,
    error: outputError(record, status),
    receipt,
  };
}

function normalizeOperationError(
  error: unknown,
  operation: string,
  context: InvocationContext,
): RuntimeExecResponse {
  const record = isRecord(error) ? error : undefined;
  const approval = isRecord(record?.approval) ? record.approval : undefined;
  const code = typeof record?.code === 'string' ? record.code : 'ui_action_operation_failed';
  const message = error instanceof Error ? error.message : 'UI action operation failed.';
  if (approval?.decision === 'approval') {
    return syntheticOperationResponse(
      {
        status: 'approval_required',
        approval,
        message,
      },
      operation,
      context,
    );
  }
  const status =
    code === 'denied' || code === 'permission_denied'
      ? 'denied'
      : code === 'cancelled' || code === 'execution_cancelled'
        ? 'cancelled'
        : 'failed';
  return syntheticOperationResponse(
    {
      status,
      error: { code, message },
    },
    operation,
    context,
  );
}

function syntheticOperationResponse(
  output: unknown,
  operation: string,
  context: InvocationContext,
): RuntimeExecResponse {
  const record = isRecord(output) ? output : undefined;
  const declaredStatus = typeof record?.status === 'string' ? record.status : 'success';
  const status: RuntimeExecutionStatus =
    declaredStatus === 'denied' ||
    declaredStatus === 'cancelled' ||
    declaredStatus === 'approval_required' ||
    declaredStatus === 'failed'
      ? declaredStatus
      : 'success';
  const now = new Date();
  const parentExecutionId = context.executionId;
  const executionId = randomUUID();
  const lineage = parentExecutionId
    ? {
        rootExecutionId: context.lineage?.rootExecutionId ?? parentExecutionId,
        parentExecutionId,
        depth: (context.lineage?.depth ?? 0) + 1,
      }
    : { rootExecutionId: executionId, depth: 0 };
  const base = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    status,
    result: { output },
    receipt: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      receiptId: randomUUID(),
      executionId,
      target: operation,
      principalId: context.principal.id,
      identity: context.identity,
      scope: context.scope,
      lineage,
      status,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      durationMs: 0,
    },
  } satisfies RuntimeExecResponse;
  if (status === 'approval_required') {
    return {
      ...base,
      approval: outputApproval(record ?? {}),
    };
  }
  if (status !== 'success') {
    return {
      ...base,
      error: outputError(record ?? {}, status),
    };
  }
  return base;
}

const RUNTIME_STATUSES = new Set<RuntimeExecutionStatus>([
  'success',
  'not_found',
  'denied',
  'approval_required',
  'failed',
  'cancelled',
]);

function outputApproval(record: JsonObject): PermissionApprovalDecision {
  const approval = isRecord(record.approval) ? record.approval : undefined;
  return {
    decision: 'approval',
    reason:
      typeof approval?.reason === 'string'
        ? approval.reason
        : outputMessage(record, 'The action requires approval.'),
    ...(typeof approval?.approvalId === 'string'
      ? { approvalId: approval.approvalId }
      : {}),
    ...(typeof approval?.prompt === 'string' ? { prompt: approval.prompt } : {}),
    ...(typeof approval?.expiresAt === 'string'
      ? { expiresAt: approval.expiresAt }
      : {}),
  };
}

function outputError(
  record: JsonObject,
  status: 'denied' | 'cancelled' | 'failed',
): RuntimeError {
  const error = isRecord(record.error) ? record.error : undefined;
  return {
    code:
      typeof error?.code === 'string'
        ? error.code
        : `ui_action_output_${status}`,
    message:
      typeof error?.message === 'string'
        ? error.message
        : outputMessage(record, `The action ended with ${status}.`),
    ...(error && Object.hasOwn(error, 'details') ? { details: error.details } : {}),
  };
}

function outputMessage(record: JsonObject, fallback: string): string {
  return typeof record.message === 'string' && record.message.trim()
    ? record.message
    : fallback;
}

function mcpError(candidate: unknown, envelope: JsonObject): RuntimeError {
  const candidateRecord = isRecord(candidate) ? candidate : undefined;
  const nested = isRecord(candidateRecord?.error) ? candidateRecord.error : undefined;
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const firstText = content.find(
    (item): item is JsonObject =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string',
  );
  return {
    code:
      typeof nested?.code === 'string'
        ? nested.code
        : 'ui_action_mcp_error',
    message:
      typeof nested?.message === 'string'
        ? nested.message
        : typeof candidateRecord?.error === 'string'
          ? candidateRecord.error
          : typeof candidateRecord?.message === 'string'
            ? candidateRecord.message
            : typeof firstText?.text === 'string'
              ? firstText.text
              : 'The MCP operation returned an error.',
    ...(nested && Object.hasOwn(nested, 'details') ? { details: nested.details } : {}),
  };
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeExecResponse(value: unknown): value is RuntimeExecResponse {
  if (!isRecord(value) || !RUNTIME_STATUSES.has(value.status as RuntimeExecutionStatus))
    return false;
  return (
    value.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
    isRecord(value.receipt) &&
    typeof value.receipt.receiptId === 'string' &&
    typeof value.receipt.executionId === 'string'
  );
}

function digestSchema(): JsonObject {
  return { type: 'string', pattern: '^[a-f0-9]{64}$' };
}

function runtimeErrorSchema(): JsonObject {
  return strictObject({
    code: { type: 'string', maxLength: 256 },
    message: { type: 'string', maxLength: 8_192 },
    details: {},
  }, ['code', 'message']);
}

function scalarOrScalarArraySchema(maxStringLength?: number): JsonObject {
  const scalarVariants: JsonObject[] = [
    {
      type: 'string',
      ...(maxStringLength === undefined ? {} : { maxLength: maxStringLength }),
    },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
  ];
  return {
    oneOf: [
      ...scalarVariants,
      {
        type: 'array',
        maxItems: 100,
        items: { oneOf: scalarVariants },
      },
    ],
  };
}
