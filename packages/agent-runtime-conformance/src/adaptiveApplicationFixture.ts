import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationContext, RuntimeExecResponse } from '@marshal/agent-runtime-core';
import {
  MarshalUiClient,
  REACT_UI_PAYLOAD_TOOL_NAME,
  REACT_UI_RENDERER_VERSION,
  UI_ACTION_TOOL_NAME,
  createReactUiCapabilities,
  type UiActionExecutionRequest,
  type UiApplicationManifest,
  type UiAuthoringProfile,
  type UiDisplayMode,
  type UiProtocolMessage,
  type UiProtocolTransport,
} from '@marshal/agent-runtime-ui';
import type { JsonRecord } from './contracts.js';
import type {
  AdaptiveApplicationConformanceCaseName,
  AdaptiveApplicationConformanceEnvironment,
  AdaptiveApplicationConformanceFixture,
  AdaptiveApplicationHostProfile,
  AdaptiveApplicationHostSession,
  AdaptiveApplicationObservations,
  AdaptiveApplicationResourceFactory,
  AdaptiveApplicationResourcePort,
  AdaptiveApplicationScope,
} from './adaptiveApplicationContracts.js';

const PRIMARY_SCOPE: AdaptiveApplicationScope = { name: 'primary' };
const ISOLATED_SCOPE: AdaptiveApplicationScope = { name: 'isolated' };

export const ADAPTIVE_APPLICATION_MANIFEST: UiApplicationManifest = {
  version: '1.0.0',
  presentationModes: ['inline', 'fullscreen', 'pip'],
  actions: [
    {
      id: 'acknowledge',
      version: '1.0.0',
      title: 'Acknowledge incident',
      target: { kind: 'capability', capability: 'incidents.acknowledge' },
      inputSchema: {
        type: 'object',
        properties: { incidentId: { type: 'string', minLength: 1 } },
        required: ['incidentId'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { acknowledged: { type: 'boolean' } },
        required: ['acknowledged'],
        additionalProperties: false,
      },
      allowedScopes: ['project'],
      requiredPermissions: ['incidents.write'],
      risk: 'write',
      idempotency: 'required',
    },
  ],
  tools: [
    {
      id: 'incident-read',
      name: 'incidents.get',
      inputSchema: {
        type: 'object',
        properties: { incidentId: { type: 'string' } },
        required: ['incidentId'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ],
  localState: { scope: 'project', schemaVersion: '1.0.0' },
  authoritativeState: {
    capability: 'incidents.get',
    resourceId: 'incident-board',
    version: '7',
  },
  authoringProfile: { id: 'portable-react', version: '1.0.0' },
};

const ADAPTIVE_APPLICATION_AUTHORING_PROFILE: UiAuthoringProfile = {
  id: 'portable-react',
  version: '1.0.0',
  portable: true,
  packageImports: [],
  designTokens: { 'color.text.primary': 'var(--color-text-primary)' },
  templates: ['incident-control'],
  authoringGuidance: 'Use custom standards-first React with MCP Apps host context.',
  accessibilityRequirements: ['Meet WCAG 2.2 AA.'],
  layoutConstraints: ['Keep inline usable at 320 CSS pixels.'],
  requiredHostCapabilities: ['serverTools', 'serverResources'],
  optionalHostExtensions: [],
};

export const ADAPTIVE_APPLICATION_FALLBACK = {
  summary: 'Incident INC-42 is open with high severity; acknowledgment is available.',
  details: {
    incidentId: 'INC-42',
    status: 'open',
    severity: 'high',
    availableAction: 'acknowledge',
  },
} as const;

export interface AdaptiveApplicationFixtureOptions {
  readonly name?: string;
  readonly resourceFactory?: AdaptiveApplicationResourceFactory;
}

/** Standards-only fixture by default; adapters replace only the resource-plane edge. */
export function createAdaptiveApplicationConformanceFixture(
  options: AdaptiveApplicationFixtureOptions = {},
): AdaptiveApplicationConformanceFixture {
  return {
    name: options.name ?? 'standards-only-mcp-apps',
    create: (caseName) => createEnvironment(caseName, options.resourceFactory),
  };
}

async function createEnvironment(
  _caseName: AdaptiveApplicationConformanceCaseName,
  resourceFactory?: AdaptiveApplicationResourceFactory,
): Promise<AdaptiveApplicationConformanceEnvironment> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-adaptive-conformance-'));
  const workspacePath = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  const sourcePath = join(workspacePath, 'App.tsx');
  await mkdir(workspacePath, { recursive: true });
  await writeFile(
    sourcePath,
    "export default function App(props){return <main><h1>{props.title}</h1><p>{props.status}</p></main>}",
    'utf8',
  );

  let compileInvocations = 0;
  let renderBindingInvocations = 0;
  let displayInvocations = 0;
  let actionExecutions = 0;
  let toolExecutions = 0;
  let sequence = 0;
  const authorizationRequests: JsonRecord[] = [];
  const sessions = new Set<AdaptiveApplicationHostSession>();
  let current = await boot();

  const environment: AdaptiveApplicationConformanceEnvironment = {
    manifest: ADAPTIVE_APPLICATION_MANIFEST,
    fallback: ADAPTIVE_APPLICATION_FALLBACK,
    rendererVersion: REACT_UI_RENDERER_VERSION,
    async provision(scope = PRIMARY_SCOPE) {
      const context = invocationContext(scope);
      compileInvocations += 1;
      const compiled = await current.bundle.provider.invoke(
        'ui.compile',
        {
          entryPath: 'App.tsx',
          title: 'Incident control',
          authoringProfile: ADAPTIVE_APPLICATION_MANIFEST.authoringProfile,
        },
        context,
      );
      const component = record(record(compiled.output).component);
      renderBindingInvocations += 1;
      const rendered = await current.bundle.provider.invoke(
        'ui.render',
        {
          componentId: requiredString(component.id, 'component.id'),
          props: { title: 'Incident INC-42', status: 'open' },
          fallback: ADAPTIVE_APPLICATION_FALLBACK,
          application: ADAPTIVE_APPLICATION_MANIFEST,
        },
        context,
      );
      const render = record(record(rendered.output).render);
      const app = record(record(rendered.output).mcpApp);
      return {
        renderId: requiredString(render.id, 'render.id'),
        componentId: requiredString(render.componentId, 'render.componentId'),
        rendererUri: requiredString(app.resourceUri, 'mcpApp.resourceUri'),
      };
    },
    listResources(scope = PRIMARY_SCOPE) {
      return current.resources.listResources(invocationContext(scope));
    },
    readResource(uri, scope = PRIMARY_SCOPE) {
      return current.resources.readResource(uri, invocationContext(scope));
    },
    rendererToolMetadata() {
      return current.resources.reactToolMetadata?.() ?? current.resources.toolMetadata();
    },
    async display(renderId, scope = PRIMARY_SCOPE) {
      displayInvocations += 1;
      return await requireResult(
        current.resources.invokeRenderTool(
          'runtime_render_component',
          { renderId },
          invocationContext(scope),
        ),
        'runtime_render_component',
      );
    },
    async payload(renderId, scope = PRIMARY_SCOPE) {
      return await requireResult(
        current.resources.invokeRenderTool(
          REACT_UI_PAYLOAD_TOOL_NAME,
          { renderId },
          invocationContext(scope),
        ),
        REACT_UI_PAYLOAD_TOOL_NAME,
      );
    },
    async updateState(renderId, key, value, scope = PRIMARY_SCOPE) {
      return await requireResult(
        current.resources.invokeRenderTool(
          'marshal_update_react_state',
          { renderId, operation: 'set', key, value },
          invocationContext(scope),
        ),
        'marshal_update_react_state',
      );
    },
    async invokeAction(renderId, input, scope = PRIMARY_SCOPE) {
      return await requireResult(
        current.resources.invokeRenderTool(
          UI_ACTION_TOOL_NAME,
          { ...input, renderId },
          invocationContext(scope),
        ),
        UI_ACTION_TOOL_NAME,
      );
    },
    async connectHost(renderId, profile, scope = PRIMARY_SCOPE) {
      const render = await current.bundle.store.getRender(renderId, invocationContext(scope));
      if (!render.application) throw new Error('Conformance render has no application manifest');
      const transport = new InProcessUiHostTransport(profile, async (name, args) => {
        return await requireResult(
          current.resources.invokeRenderTool(name, args, invocationContext(scope)),
          name,
        );
      });
      const client = await MarshalUiClient.connect({
        appInfo: { name: 'adaptive-conformance-app', version: '1.0.0' },
        application: render.application,
        renderId,
        transport,
      });
      const events: import('@marshal/agent-runtime-ui').UiLifecycleEvent[] = [];
      client.subscribe((event) => events.push(event));
      const session: AdaptiveApplicationHostSession = {
        requestDisplayMode: (mode) => client.requestDisplayMode(mode),
        sendMessage: (message) => client.sendMessage(message),
        updateModelContext: (update) => client.updateModelContext(update),
        openLink: (request) => client.openLink(request),
        reportSize: (dimensions) => client.reportSize(dimensions),
        supportsHostExtension: (namespace, method) => client.supportsHostExtension(namespace, method),
        callHostExtension: (namespace, method, args) => client.callHostExtension(namespace, method, args),
        callTool: (toolId, input) => client.callTool(toolId, input),
        callAction: (actionId, input, actionOptions) =>
          client.callAction(actionId, input, actionOptions),
        emit: (message) => transport.emit(message),
        snapshot: () => ({
          context: client.host.context as JsonRecord,
          events: [...events],
          requests: [...transport.requests],
          notifications: [...transport.notifications],
        }),
        close() {
          client.close();
          sessions.delete(session);
        },
      };
      sessions.add(session);
      return session;
    },
    async restart() {
      for (const session of [...sessions]) session.close();
      current = await boot();
    },
    inspect(): AdaptiveApplicationObservations {
      return {
        compileInvocations,
        renderBindingInvocations,
        displayInvocations,
        sourceContentDigest: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
        sourceModifiedAtMs: statSync(sourcePath).mtimeMs,
        actionExecutions,
        toolExecutions,
        authorizationRequests: authorizationRequests.map((item) => ({ ...item })),
      };
    },
    async dispose() {
      for (const session of [...sessions]) session.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return environment;

  async function boot(): Promise<{
    bundle: ReturnType<typeof createReactUiCapabilities>;
    resources: AdaptiveApplicationResourcePort;
  }> {
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot,
      authoringProfiles: [ADAPTIVE_APPLICATION_AUTHORING_PROFILE],
      hostCapabilities: { serverTools: true, serverResources: true },
      actionRuntime: {
        authorize: {
          authorize(request, context) {
            const incidentId = record(request.input).incidentId;
            authorizationRequests.push({
              renderId: request.renderId,
              actionId: request.action.id,
              target: request.action.target,
              allowedScopes: [...request.action.allowedScopes],
              requiredPermissions: [...request.action.requiredPermissions],
              requestedScope: request.scope,
              principalId: context.principal.id,
            });
            if (incidentId === 'deny') {
              return { decision: 'deny', code: 'permission_denied', reason: 'Denied by conformance policy.' };
            }
            return {
              decision: 'allow',
              grants: [...request.action.requiredPermissions],
              reason: 'Allowed by conformance policy.',
            };
          },
        },
        executor: {
          async execute(request, context) {
            actionExecutions += 1;
            return actionExecutionResponse(request, context, ++sequence);
          },
        },
        now: () => new Date('2026-08-01T00:00:00.000Z'),
        receiptId: () => `ui-action-receipt-${++sequence}`,
      },
      toolRuntime: {
        async execute(tool, input, context) {
          toolExecutions += 1;
          if (tool.name !== 'incidents.get') {
            return failedToolExecutionResponse(tool.name, context, ++sequence);
          }
          const incidentId = requiredString(record(input).incidentId, 'incidents.get.incidentId');
          return toolExecutionResponse(tool.name, { incidentId, status: 'open' }, context, ++sequence);
        },
      },
    });
    const resources = resourceFactory
      ? await resourceFactory({ react: bundle.resources, stateRoot })
      : (bundle.resources as AdaptiveApplicationResourcePort);
    return { bundle, resources };
  }
}

class InProcessUiHostTransport implements UiProtocolTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(message: UiProtocolMessage) => void>();

  constructor(
    private readonly profile: AdaptiveApplicationHostProfile,
    private readonly callTool: (name: string, args: unknown) => Promise<unknown>,
  ) {}

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.requests.push({ method, params });
    if (method === 'ui/initialize') {
      return {
        protocolVersion: '2026-01-26',
        hostCapabilities: {
          serverTools: true,
          serverResources: true,
          ...(this.profile.capabilities ?? {}),
        },
        hostContext: {
          ...(this.profile.context ?? {}),
          displayMode: this.profile.displayMode,
          availableDisplayModes: this.profile.availableDisplayModes,
        },
      } as TResult;
    }
    if (method === 'ui/request-display-mode') {
      const mode = requiredDisplayMode(record(params).mode);
      if (this.profile.deniedDisplayModes?.includes(mode)) {
        throw new Error(`Host denied ${mode}.`);
      }
      return {
        mode: this.profile.displayResponses?.[mode] ?? mode,
      } as TResult;
    }
    if (method === 'tools/call') {
      const request = record(params);
      return await this.callTool(
        requiredString(request.name, 'tools/call.name'),
        request.arguments,
      ) as TResult;
    }
    if (this.profile.requestResults && Object.prototype.hasOwnProperty.call(this.profile.requestResults, method)) {
      return this.profile.requestResults?.[method] as TResult;
    }
    return {} as TResult;
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  subscribe(listener: (message: UiProtocolMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: UiProtocolMessage): void {
    for (const listener of [...this.listeners]) listener(message);
  }
}

function invocationContext(scope: AdaptiveApplicationScope): InvocationContext {
  return {
    principal: { id: 'adaptive-conformance-agent', kind: 'agent' },
    identity: {
      harnessId: 'mcp-apps-conformance',
      installationId: 'installation-1',
      profileId: 'profile-1',
      agentId: 'adaptive-conformance-agent',
    },
    scope: {
      workspaceId: 'workspace-1',
      projectId: scope.name === 'primary' ? 'project-a' : 'project-b',
      sessionId: scope.name === 'primary' ? 'session-a' : 'session-b',
    },
  };
}

function actionExecutionResponse(
  request: UiActionExecutionRequest,
  context: InvocationContext,
  sequence: number,
): RuntimeExecResponse {
  const executionId = `adaptive-action-execution-${sequence}`;
  return {
    protocolVersion: '1.0.0',
    status: 'success',
    result: { output: { acknowledged: true } },
    receipt: {
      protocolVersion: '1.0.0',
      receiptId: `adaptive-target-receipt-${sequence}`,
      executionId,
      target: request.action.target.kind === 'capability'
        ? request.action.target.capability
        : request.action.target.executorCapability ?? 'typescript.execute',
      principalId: context.principal.id,
      scope: context.scope,
      lineage: { rootExecutionId: executionId, depth: 0 },
      status: 'success',
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: '2026-08-01T00:00:00.000Z',
      durationMs: 0,
    },
  };
}

function toolExecutionResponse(
  target: string,
  output: unknown,
  context: InvocationContext,
  sequence: number,
): RuntimeExecResponse {
  const executionId = `adaptive-tool-execution-${sequence}`;
  return {
    protocolVersion: '1.0.0',
    status: 'success',
    result: { output },
    receipt: {
      protocolVersion: '1.0.0',
      receiptId: `adaptive-tool-receipt-${sequence}`,
      executionId,
      target,
      principalId: context.principal.id,
      scope: context.scope,
      lineage: { rootExecutionId: executionId, depth: 0 },
      status: 'success',
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: '2026-08-01T00:00:00.000Z',
      durationMs: 0,
    },
  };
}

function failedToolExecutionResponse(
  target: string,
  context: InvocationContext,
  sequence: number,
): RuntimeExecResponse {
  return {
    ...toolExecutionResponse(target, undefined, context, sequence),
    status: 'failed',
    result: undefined,
    error: { code: 'unknown_tool', message: `Unknown declared tool capability ${target}.` },
  };
}

async function requireResult<T>(value: Promise<T | undefined>, operation: string): Promise<T> {
  const result = await value;
  if (result === undefined) throw new Error(`${operation} was not handled by the adaptive resource port`);
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function requiredDisplayMode(value: unknown): UiDisplayMode {
  if (value !== 'inline' && value !== 'fullscreen' && value !== 'pip') {
    throw new Error('display mode is invalid');
  }
  return value;
}

export { ISOLATED_SCOPE as ADAPTIVE_APPLICATION_ISOLATED_SCOPE };
