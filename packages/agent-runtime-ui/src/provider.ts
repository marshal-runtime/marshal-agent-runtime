import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityInvocationResult,
  type CapabilityProvider,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import type { ReactUiCompiler } from './compiler.js';
import type { UiApplicationManifest } from './applicationTypes.js';
import {
  authoringProfileReference,
  STANDARDS_ONLY_UI_PROFILE,
} from './authoringProfiles.js';
import { MARSHAL_UI_AUTHORING_CONTRACT } from './authoringContract.js';
import { validateUiApplicationManifest } from './applicationManifest.js';
import { listAuthoredRenderApplications } from './publishedApplications.js';
import { digest, stableStringify, workspaceRenderKey } from './store.js';
import type { ReactUiStore } from './store.js';
import type { JsonObject, ReactUiRender, UiFallback } from './types.js';
import { REACT_UI_TEMPLATE_URI } from './runtimeRenderer.js';

const VERSION = '1.0.0';
const OPERATIONS = [
  'ui.authoring.profiles.list',
  'ui.authoring.profiles.select',
  'ui.compile',
  'ui.registered.compile',
  'ui.registered.list',
  'ui.components.get',
  'ui.components.list',
  'ui.render',
  'ui.renders.get',
  'ui.renders.list',
  'ui.applications.list',
] as const;

export interface ReactUiProviderOptions {
  compiler: ReactUiCompiler;
  store: ReactUiStore;
  maxPropsBytes?: number;
}

export class ReactUiProvider implements CapabilityProvider {
  readonly id = 'portable.react-ui';
  readonly version = VERSION;

  constructor(private readonly options: ReactUiProviderOptions) {}

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
      case 'ui.authoring.profiles.list':
        return {
          output: {
            profiles: this.options.compiler.listAuthoringProfiles(),
            selection: this.options.compiler.selectAuthoringProfile(),
          },
        };
      case 'ui.authoring.profiles.select':
        return {
          output: {
            selection: this.options.compiler.selectAuthoringProfile(
              optionalAuthoringProfileRequest(args),
            ),
          },
        };
      case 'ui.compile': {
        const component = await this.options.compiler.compileWorkspace(
          {
            entryPath: stringField(args.entryPath, 'entryPath', 1_024),
            title: stringField(args.title, 'title', 256),
            description: optionalString(args.description, 'description', 2_000),
            authoringProfile: optionalAuthoringProfile(args.authoringProfile),
          },
          context,
        );
        return componentResult(await this.options.store.putComponent(component, context), name);
      }
      case 'ui.registered.compile': {
        const component = await this.options.compiler.compileRegistered(
          stringField(args.componentId, 'componentId', 256),
          context,
        );
        return componentResult(await this.options.store.putComponent(component, context), name);
      }
      case 'ui.registered.list':
        return { output: { components: this.options.compiler.listRegistered() } };
      case 'ui.components.get': {
        const component = await this.options.store.getComponent(
          stringField(args.componentId, 'componentId', 64),
          context,
        );
        return componentResult(component, name);
      }
      case 'ui.components.list': {
        const components = await this.options.store.listComponents(context);
        return {
          output: {
            components: components.map(({ html: _html, ...component }) => component),
          },
        };
      }
      case 'ui.render': {
        const component = await this.options.store.getComponent(
          stringField(args.componentId, 'componentId', 64),
          context,
        );
        const props = validateJsonObject(args.props ?? {}, 'props', this.options.maxPropsBytes);
        const fallback = validateFallback(args.fallback);
        const declaredApplication = args.application === undefined
          ? undefined
          : validateUiApplicationManifest(args.application);
        const application = declaredApplication === undefined
          ? undefined
          : bindAuthoringProfile(declaredApplication, component.authoringProfile);
        const workspaceRecipe = component.sourceKind === 'workspace_file'
          ? {
              version: '1.0.0' as const,
              entryPath: component.sourcePath,
              title: component.title,
              ...(component.description ? { description: component.description } : {}),
              ...(component.authoringProfile
                ? { authoringProfile: { id: component.authoringProfile.id, version: component.authoringProfile.version } }
                : {}),
            }
          : undefined;
        const id = workspaceRecipe
          ? workspaceRenderKey(workspaceRecipe, props, fallback, application)
          : digest(stableStringify({ componentId: component.id, props, fallback, application }));
        const render: Omit<ReactUiRender, 'scopeKey'> = {
          id,
          componentId: component.id,
          createdAt: new Date().toISOString(),
          props,
          fallback,
          resourceUri: component.resourceUri,
          toolName: `marshal_render_react_${id}`,
          ...(application ? { application } : {}),
          ...(workspaceRecipe ? {
            workspace: { ...workspaceRecipe, key: id, pollIntervalMs: 1_500 },
          } : {}),
        };
        const stored = await this.options.store.putRender(render, context);
        return renderResult(stored, component.title);
      }
      case 'ui.renders.get': {
        const render = await this.options.store.getRender(
          stringField(args.renderId, 'renderId', 64),
          context,
        );
        const component = await this.options.store.getComponent(render.componentId, context);
        return renderResult(render, component.title);
      }
      case 'ui.renders.list':
        return { output: { renders: await this.options.store.listRenders(context) } };
      case 'ui.applications.list':
        // Public bridge for hosts and agents: authored renders projected as
        // published applications (reserved owner marshal.react-ui, application
        // id = renderId), scoped exactly like every other invocation here —
        // workspace + project + principal, NOT per-session.
        return {
          output: {
            applications: await listAuthoredRenderApplications(this.options.store, context),
          },
        };
      default:
        throw new Error(`Unknown React UI capability: ${name}`);
    }
  }
}

function componentResult(
  component: Awaited<ReturnType<ReactUiStore['getComponent']>>,
  operation: string,
): CapabilityInvocationResult {
  const { html: _html, ...publicComponent } = component;
  return {
    output: { component: publicComponent },
    artifacts: [
      {
        id: component.id,
        kind: 'react_ui_component',
        uri: component.resourceUri,
        mediaType: 'text/html;profile=mcp-app',
        metadata: {
          sourceDigest: component.sourceDigest,
          bundleDigest: component.bundleDigest,
          htmlDigest: component.htmlDigest,
          sourceKind: component.sourceKind,
          authoringProfile: component.authoringProfile,
          registeredComponent: component.registeredComponent,
        },
      },
    ],
    receipt: {
      operation,
      componentId: component.id,
      sourceDigest: component.sourceDigest,
      bundleDigest: component.bundleDigest,
      htmlDigest: component.htmlDigest,
      authoringProfile: component.authoringProfile,
      registeredComponent: component.registeredComponent,
      resourceUri: component.resourceUri,
      at: new Date().toISOString(),
    },
  };
}

function renderResult(render: ReactUiRender, title: string): CapabilityInvocationResult {
  return {
    output: {
      render,
      fallback: render.fallback,
      mcpApp: {
        resourceUri: REACT_UI_TEMPLATE_URI,
        renderTool: 'runtime_render_component',
        arguments: { renderId: render.id },
        dedicatedRenderTool: render.toolName,
        title,
        note:
          render.workspace
            ? 'Call runtime_render_component with this renderId immediately. This stable card follows successful edits to its workspace source and preserves the last good revision when compilation fails.'
            : 'Call runtime_render_component with this renderId immediately. Reuse the same call to show it again; do not recompile. A harness without MCP Apps should present fallback.summary and fallback.details.',
      },
    },
    artifacts: [
      {
        id: render.id,
        kind: 'react_ui_render',
        uri: render.resourceUri,
        mediaType: 'text/html;profile=mcp-app',
        metadata: {
          componentId: render.componentId,
          renderTool: 'runtime_render_component',
          renderArguments: { renderId: render.id },
          dedicatedRenderTool: render.toolName,
          workspace: render.workspace,
        },
      },
    ],
    receipt: {
      operation: 'ui.render',
      renderId: render.id,
      componentId: render.componentId,
      resourceUri: render.resourceUri,
      renderTool: 'runtime_render_component',
      renderArguments: { renderId: render.id },
      dedicatedRenderTool: render.toolName,
      at: new Date().toISOString(),
    },
  };
}

function descriptor(name: (typeof OPERATIONS)[number]): CapabilityDescriptor {
  const permissions =
    name === 'ui.compile'
      ? [
          {
            permission: 'trusted_ui',
            risk: 'high' as const,
            reason: 'Bundles agent-authored workspace JavaScript for execution in an MCP App iframe.',
          },
        ]
      : name === 'ui.registered.compile'
        ? [
            {
              permission: 'ui.registered_component.use',
              risk: 'low' as const,
              reason: 'Uses a component whose complete immutable build graph is audited by the host.',
            },
          ]
        : [
            {
              permission: name.startsWith('ui.authoring.profiles.') ? 'ui.authoring.profiles.read' : name,
              risk: name === 'ui.render' ? ('medium' as const) : ('low' as const),
              reason: 'Reads or creates scoped, immutable UI metadata.',
            },
          ];
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: VERSION,
    title: name.replaceAll('.', ' '),
    description: description(name),
    tags: [
      'ui',
      'react',
      'mcp-apps',
      name.startsWith('ui.registered')
        ? 'audited'
        : name.startsWith('ui.authoring.profiles.')
          ? 'authoring-profile'
          : 'portable',
    ],
    inputSchema: inputSchema(name),
    outputSchema: outputSchema(name),
    permissions,
    annotations: {
      mcpApps: {
        resourceMimeType: 'text/html;profile=mcp-app',
        ...((name === 'ui.compile' || name === 'ui.render')
          ? { authoringContract: MARSHAL_UI_AUTHORING_CONTRACT }
          : {}),
      },
    },
  };
}

function outputSchema(name: (typeof OPERATIONS)[number]): JsonObject {
  const component = compiledComponentSchema();
  const render = renderSchema();
  switch (name) {
    case 'ui.authoring.profiles.list':
      return strictObject({
        profiles: { type: 'array', maxItems: 257, items: authoringProfileSchema() },
        selection: authoringProfileSelectionSchema(),
      }, ['profiles', 'selection']);
    case 'ui.authoring.profiles.select':
      return strictObject({ selection: authoringProfileSelectionSchema() }, ['selection']);
    case 'ui.compile':
    case 'ui.registered.compile':
    case 'ui.components.get':
      return strictObject({ component }, ['component']);
    case 'ui.registered.list':
      return strictObject({
        components: { type: 'array', maxItems: 10_000, items: registeredComponentSchema() },
      }, ['components']);
    case 'ui.components.list':
      return strictObject({
        components: { type: 'array', maxItems: 10_000, items: component },
      }, ['components']);
    case 'ui.render':
    case 'ui.renders.get':
      return renderResultSchema(render);
    case 'ui.renders.list':
      return strictObject({
        renders: { type: 'array', maxItems: 10_000, items: render },
      }, ['renders']);
    case 'ui.applications.list':
      return strictObject({
        applications: {
          type: 'array',
          maxItems: 10_000,
          items: strictObject({
            ownerId: { const: 'marshal.react-ui' },
            revisionId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            title: { type: 'string', maxLength: 256 },
            description: { type: 'string', maxLength: 2_000 },
            renderId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            resource: strictObject({
              uri: { type: 'string', maxLength: 512 },
              mimeType: { type: 'string', maxLength: 128 },
              name: { type: 'string', maxLength: 256 },
            }, ['uri', 'mimeType']),
            application: { type: 'object' },
            tags: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 64 } },
          }, ['ownerId', 'revisionId', 'id', 'title', 'description', 'renderId', 'resource', 'application']),
        },
      }, ['applications']);
  }
}

function strictObject(properties: JsonObject, required: readonly string[]): JsonObject {
  return { type: 'object', properties, required, additionalProperties: false };
}

function registeredComponentSchema(): JsonObject {
  return strictObject({
    id: { type: 'string', maxLength: 256 }, version: { type: 'string', maxLength: 128 },
    title: { type: 'string', maxLength: 256 }, description: { type: 'string', maxLength: 2_000 },
    entryPath: { type: 'string', maxLength: 1_024 },
    allowedPackages: { type: 'array', maxItems: 1_000, items: { type: 'string', maxLength: 512 } },
    authoringProfile: authoringProfileReferenceSchema(false),
    audit: strictObject({
      reviewedBy: { type: 'string', maxLength: 512 }, reviewedAt: { type: 'string', maxLength: 64 },
      sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      graph: buildGraphSchema(),
    }, ['reviewedBy', 'reviewedAt', 'sourceDigest', 'graph']),
  }, ['id', 'version', 'title', 'entryPath', 'audit']);
}

function compiledComponentSchema(): JsonObject {
  return strictObject({
    id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, scopeKey: { type: 'string', maxLength: 512 },
    title: { type: 'string', maxLength: 256 }, description: { type: 'string', maxLength: 2_000 },
    sourceKind: { enum: ['workspace_file', 'registered_component'] }, sourcePath: { type: 'string', maxLength: 4_096 },
    sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bundleDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    htmlDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    createdAt: { type: 'string', maxLength: 64 }, resourceUri: { type: 'string', maxLength: 8_192 },
    inputs: { type: 'array', maxItems: 10_000, items: { type: 'string', maxLength: 4_096 } },
    buildGraph: buildGraphSchema(),
    authoringProfile: authoringProfileProvenanceSchema(),
    registeredComponent: strictObject({
      id: { type: 'string', maxLength: 256 }, version: { type: 'string', maxLength: 128 }, reviewedBy: { type: 'string', maxLength: 512 },
      graphDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    }, ['id', 'version', 'reviewedBy', 'graphDigest']),
  }, ['id', 'scopeKey', 'title', 'sourceKind', 'sourcePath', 'sourceDigest', 'bundleDigest', 'htmlDigest', 'createdAt', 'resourceUri', 'inputs']);
}

function fallbackSchema(): JsonObject {
  return strictObject({
    summary: { type: 'string', maxLength: 4_000 },
    details: { type: 'object', maxProperties: 1_000 },
  }, ['summary']);
}

function renderSchema(): JsonObject {
  return strictObject({
    id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, scopeKey: { type: 'string', maxLength: 512 },
    componentId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, createdAt: { type: 'string', maxLength: 64 },
    props: { type: 'object', maxProperties: 1_000 }, fallback: fallbackSchema(),
    resourceUri: { type: 'string', maxLength: 8_192 }, toolName: { type: 'string', maxLength: 256 },
    application: applicationManifestSchema(),
    workspace: strictObject({
      version: { const: '1.0.0' }, key: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      entryPath: { type: 'string', maxLength: 4_096 }, title: { type: 'string', maxLength: 256 },
      description: { type: 'string', maxLength: 2_000 }, authoringProfile: authoringProfileReferenceSchema(false),
      pollIntervalMs: { type: 'integer', minimum: 1_000, maximum: 60_000 },
    }, ['version', 'key', 'entryPath', 'title', 'pollIntervalMs']),
  }, ['id', 'scopeKey', 'componentId', 'createdAt', 'props', 'fallback', 'resourceUri', 'toolName']);
}

function buildGraphSchema(): JsonObject {
  return strictObject({
    schemaVersion: { const: 1 },
    inputs: { type: 'array', maxItems: 10_000, items: strictObject({
      kind: { enum: ['workspace', 'package'] }, path: { type: 'string', maxLength: 4_096 },
      digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      package: strictObject({
        name: { type: 'string', maxLength: 512 }, version: { type: 'string', maxLength: 128 },
        manifestDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      }, ['name', 'version', 'manifestDigest']),
      resolution: strictObject({
        schemaVersion: { const: 1 },
        steps: { type: 'array', minItems: 1, maxItems: 256, items: strictObject({
          specifier: { type: 'string', minLength: 1, maxLength: 1_024 },
          importer: {
            oneOf: [
              strictObject({ kind: { const: 'workspace' }, path: { type: 'string', minLength: 1, maxLength: 4_096 } }, ['kind', 'path']),
              strictObject({
                kind: { const: 'package' }, path: { type: 'string', minLength: 1, maxLength: 4_096 },
                package: strictObject({
                  name: { type: 'string', maxLength: 512 }, version: { type: 'string', maxLength: 128 },
                  manifestDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                }, ['name', 'version', 'manifestDigest']),
              }, ['kind', 'path', 'package']),
            ],
          },
        }, ['specifier', 'importer']) },
      }, ['schemaVersion', 'steps']),
    }, ['kind', 'path', 'digest']) },
  }, ['schemaVersion', 'inputs']);
}

function renderResultSchema(render: JsonObject): JsonObject {
  return strictObject({
    render,
    fallback: fallbackSchema(),
    mcpApp: strictObject({
      resourceUri: { type: 'string', maxLength: 8_192 }, renderTool: { const: 'runtime_render_component' },
      arguments: strictObject({ renderId: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['renderId']),
      dedicatedRenderTool: { type: 'string', maxLength: 256 }, title: { type: 'string', maxLength: 256 },
      note: { type: 'string', maxLength: 2_000 },
    }, ['resourceUri', 'renderTool', 'arguments', 'dedicatedRenderTool', 'title', 'note']),
  }, ['render', 'fallback', 'mcpApp']);
}

function description(name: (typeof OPERATIONS)[number]): string {
  switch (name) {
    case 'ui.authoring.profiles.list':
      return 'List adapter-supplied UI authoring profiles and the profile this host selects by default. Call this before TSX authoring, then select and consume the profile package imports, guidance, accessibility requirements, and layout constraints. Profiles are compiler policy, not runtime authority.';
    case 'ui.authoring.profiles.select':
      return 'Resolve an optional authoring-profile request against the adapter\'s truthful host capabilities. Consume the returned routingGuidance and complete selected profile before authoring TSX. Unavailable profiles fall back to the standards-only profile.';
    case 'ui.compile':
      return 'Compile a workspace React/TSX file into an immutable, content-addressed MCP App. First list/select authoring profiles and author using only the selected package/guidance/accessibility/layout contract. With an application manifest, the default export receives the versioned marshal client prop for declared actions, tools, and display-mode requests. Requires trusted_ui.';
    case 'ui.registered.compile':
      return 'Compile a host-registered React component after verifying its complete audited build graph and required authoring profile.';
    case 'ui.registered.list':
      return 'List host-registered, audited React components available without agent-authored UI permission.';
    case 'ui.render':
      return 'Create an immutable render binding with props and a required structured fallback. Then call runtime_render_component once with the returned renderId; reuse that renderId without recompiling to show it again.';
    case 'ui.applications.list':
      return 'List agent-authored renders projected as published UI applications (owner marshal.react-ui, applicationId = renderId) for host surface placement via ui.application.open / ui.chat.card.show. Scope: workspace + project + principal.';
    default:
      return 'Read scoped React UI component or render metadata.';
  }
}

function inputSchema(name: (typeof OPERATIONS)[number]): JsonObject {
  const componentId = { type: 'string', pattern: '^[a-f0-9]{64}$' };
  const renderId = { type: 'string', pattern: '^[a-f0-9]{64}$' };
  switch (name) {
    case 'ui.authoring.profiles.select':
      return {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 512 },
          version: { type: 'string', minLength: 1, maxLength: 512 },
        },
        additionalProperties: false,
      };
    case 'ui.compile':
      return {
        type: 'object',
        properties: {
          entryPath: { type: 'string', description: 'Workspace-relative .tsx/.ts/.jsx/.js path.' },
          title: { type: 'string', minLength: 1, maxLength: 256 },
          description: { type: 'string', maxLength: 2_000 },
          authoringProfile: {
            ...authoringProfileReferenceSchema(true),
            description: 'Optional adapter-discovered profile request. Missing or incompatible profiles compile with marshal-standards and record fallback provenance.',
          },
        },
        required: ['entryPath', 'title'],
        additionalProperties: false,
      };
    case 'ui.registered.compile':
      return {
        type: 'object',
        properties: { componentId: { type: 'string', minLength: 1, maxLength: 256 } },
        required: ['componentId'],
        additionalProperties: false,
      };
    case 'ui.components.get':
      return {
        type: 'object',
        properties: { componentId },
        required: ['componentId'],
        additionalProperties: false,
      };
    case 'ui.renders.get':
      return {
        type: 'object',
        properties: { renderId },
        required: ['renderId'],
        additionalProperties: false,
      };
    case 'ui.render':
      return {
        type: 'object',
        properties: {
          componentId,
          props: { type: 'object', additionalProperties: true },
          fallback: {
            type: 'object',
            properties: {
              summary: { type: 'string', minLength: 1, maxLength: 4_000 },
              details: { type: 'object', additionalProperties: true },
            },
            required: ['summary'],
            additionalProperties: false,
          },
          application: {
            ...applicationManifestSchema(),
            description: 'Optional portable adaptive-application manifest. Supply the complete declared shape; use empty actions/tools arrays when none are needed.',
          },
        },
        required: ['componentId', 'fallback'],
        additionalProperties: false,
      };
    default:
      return { type: 'object', additionalProperties: false };
  }
}

function authoringProfileSchema(): JsonObject {
  return strictObject({
    id: { type: 'string', minLength: 1, maxLength: 512 },
    version: { type: 'string', minLength: 1, maxLength: 512 },
    portable: { type: 'boolean' },
    packageImports: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 512 } },
    packageVersions: {
      type: 'object',
      maxProperties: 256,
      additionalProperties: { type: 'string', minLength: 1, maxLength: 512 },
    },
    designTokens: {
      type: 'object',
      maxProperties: 1_000,
      additionalProperties: { type: 'string', maxLength: 2_000 },
    },
    templates: { type: 'array', maxItems: 1_000, items: { type: 'string', maxLength: 2_000 } },
    authoringGuidance: { type: 'string', maxLength: 20_000 },
    accessibilityRequirements: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 512 } },
    layoutConstraints: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 512 } },
    requiredHostCapabilities: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 512 } },
    optionalHostExtensions: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 512 } },
  }, [
    'id',
    'version',
    'portable',
    'packageImports',
    'designTokens',
    'templates',
    'authoringGuidance',
    'accessibilityRequirements',
    'layoutConstraints',
    'requiredHostCapabilities',
    'optionalHostExtensions',
  ]);
}

function authoringProfileReferenceSchema(versionOptional: boolean): JsonObject {
  return strictObject({
    id: { type: 'string', minLength: 1, maxLength: 512 },
    version: { type: 'string', minLength: 1, maxLength: 512 },
  }, versionOptional ? ['id'] : ['id', 'version']);
}

function authoringProfileProvenanceSchema(): JsonObject {
  return strictObject({
    id: { type: 'string', minLength: 1, maxLength: 512 },
    version: { type: 'string', minLength: 1, maxLength: 512 },
    status: { enum: ['selected', 'fallback'] },
    origin: { enum: ['explicit', 'preferred', 'standards-default', 'fallback'] },
    requested: authoringProfileReferenceSchema(true),
    packageImports: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 512 } },
    reason: { type: 'string', maxLength: 2_000 },
  }, ['id', 'version', 'status', 'origin', 'packageImports']);
}

function authoringProfileSelectionSchema(): JsonObject {
  return strictObject({
    profile: authoringProfileSchema(),
    requested: authoringProfileReferenceSchema(true),
    status: { enum: ['selected', 'fallback'] },
    origin: { enum: ['explicit', 'preferred', 'standards-default', 'fallback'] },
    routingGuidance: { type: 'string', minLength: 1, maxLength: 4_000 },
    reason: { type: 'string', maxLength: 2_000 },
  }, ['profile', 'status', 'origin', 'routingGuidance']);
}

function applicationManifestSchema(): JsonObject {
  const stateScope = { type: 'string', enum: ['session', 'project', 'workspace'] };
  const jsonSchema = { type: 'object', additionalProperties: true };
  const moduleReference = {
    oneOf: [
      {
        type: 'object',
        properties: {
          kind: { const: 'workspace_file' },
          path: { type: 'string', minLength: 1 },
          export: { type: 'string', minLength: 1 },
        },
        required: ['kind', 'path'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: 'artifact' },
          path: { type: 'string', minLength: 1 },
          scope: stateScope,
          export: { type: 'string', minLength: 1 },
        },
        required: ['kind', 'path'],
        additionalProperties: false,
      },
    ],
  };
  return {
    type: 'object',
    properties: {
      version: { const: '1.0.0' },
      presentationModes: {
        type: 'array',
        description: 'Must include inline; may also include fullscreen and pip.',
        items: { type: 'string', enum: ['inline', 'fullscreen', 'pip'] },
        minItems: 1,
        uniqueItems: true,
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            version: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
            target: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    kind: { const: 'capability' },
                    capability: { type: 'string', minLength: 1 },
                  },
                  required: ['kind', 'capability'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: {
                    kind: { const: 'module' },
                    module: moduleReference,
                    executorCapability: { type: 'string', minLength: 1 },
                  },
                  required: ['kind', 'module'],
                  additionalProperties: false,
                },
              ],
            },
            inputSchema: jsonSchema,
            outputSchema: jsonSchema,
            allowedScopes: { type: 'array', items: stateScope, minItems: 1, uniqueItems: true },
            requiredPermissions: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
            risk: { type: 'string', enum: ['read', 'write', 'external-effect'] },
            idempotency: { type: 'string', enum: ['required', 'supported', 'none'] },
          },
          required: ['id', 'version', 'target', 'inputSchema', 'outputSchema', 'allowedScopes', 'requiredPermissions', 'risk', 'idempotency'],
          additionalProperties: false,
        },
      },
      tools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            inputSchema: jsonSchema,
            outputSchema: jsonSchema,
          },
          required: ['id', 'name', 'inputSchema'],
          additionalProperties: false,
        },
      },
      localState: {
        type: 'object',
        properties: { scope: stateScope, schemaVersion: { type: 'string', minLength: 1 } },
        required: ['scope', 'schemaVersion'],
        additionalProperties: false,
      },
      authoritativeState: {
        type: 'object',
        properties: {
          capability: { type: 'string', minLength: 1 },
          resourceId: { type: 'string', minLength: 1 },
          version: { type: 'string', minLength: 1 },
        },
        required: ['capability', 'resourceId', 'version'],
        additionalProperties: false,
      },
      authoringProfile: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          version: { type: 'string', minLength: 1 },
        },
        required: ['id', 'version'],
        additionalProperties: false,
      },
    },
    required: ['version', 'presentationModes', 'actions', 'tools'],
    additionalProperties: false,
  };
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('input must be an object');
  }
  return value as JsonObject;
}

function stringField(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty`);
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return value;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : stringField(value, field, maxLength);
}

function optionalAuthoringProfile(
  value: unknown,
): { id: string; version?: string } | undefined {
  if (value === undefined) return undefined;
  const profile = asObject(value);
  const allowed = new Set(['id', 'version']);
  for (const key of Object.keys(profile)) {
    if (!allowed.has(key)) throw new Error(`authoringProfile.${key} is not supported`);
  }
  return {
    id: stringField(profile.id, 'authoringProfile.id', 512),
    ...(profile.version === undefined
      ? {}
      : { version: stringField(profile.version, 'authoringProfile.version', 512) }),
  };
}

function optionalAuthoringProfileRequest(
  value: JsonObject,
): { id: string; version?: string } | undefined {
  if (value.id === undefined) {
    if (value.version !== undefined) throw new Error('version requires an authoring profile id');
    return undefined;
  }
  return {
    id: stringField(value.id, 'id', 512),
    ...(value.version === undefined ? {} : { version: stringField(value.version, 'version', 512) }),
  };
}

function bindAuthoringProfile(
  application: UiApplicationManifest,
  provenance: Awaited<ReturnType<ReactUiStore['getComponent']>>['authoringProfile'],
): UiApplicationManifest {
  const selected = authoringProfileReference(provenance ?? STANDARDS_ONLY_UI_PROFILE);
  if (
    application.authoringProfile &&
    (application.authoringProfile.id !== selected.id ||
      application.authoringProfile.version !== selected.version)
  ) {
    throw new Error(
      `application.authoringProfile ${application.authoringProfile.id}@${application.authoringProfile.version} does not match compiled component profile ${selected.id}@${selected.version}`,
    );
  }
  return { ...application, authoringProfile: selected };
}

function validateJsonObject(value: unknown, field: string, configuredLimit?: number): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  let encoded: string;
  try {
    encoded = stableStringify(value);
  } catch {
    throw new Error(`${field} must contain JSON-serializable values`);
  }
  const limit = configuredLimit ?? 250_000;
  if (Buffer.byteLength(encoded) > limit) throw new Error(`${field} exceeds ${limit} bytes`);
  const parsed = JSON.parse(encoded) as JsonObject;
  return parsed;
}

function validateFallback(value: unknown): UiFallback {
  const fallback = validateJsonObject(value, 'fallback', 100_000);
  const summary = stringField(fallback.summary, 'fallback.summary', 4_000);
  const allowed = new Set(['summary', 'details']);
  for (const key of Object.keys(fallback)) {
    if (!allowed.has(key)) throw new Error(`fallback.${key} is not supported`);
  }
  return {
    summary,
    ...(fallback.details === undefined
      ? {}
      : { details: validateJsonObject(fallback.details, 'fallback.details', 90_000) }),
  };
}
