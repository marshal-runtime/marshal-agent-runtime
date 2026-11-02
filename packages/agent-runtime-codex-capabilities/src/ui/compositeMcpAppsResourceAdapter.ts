import type {
  ReactUiMcpAppsPort,
  UiRenderToolDescriptor,
  UiRenderToolResult,
} from '@marshal/agent-runtime-ui';
import type { InvocationContext } from '../coreTypes.js';
import type { DeclarativeUiMcpAppsResourceAdapter } from './mcpAppsResourceAdapter.js';
import type {
  McpAppsResourceContent,
  McpAppsResourceDescriptor,
  McpAppsResourcePort,
  UiArtifact,
} from './types.js';

/** Thin MCP Apps composition adapter; all React compilation remains portable. */
export class CompositeMcpAppsResourceAdapter implements McpAppsResourcePort {
  readonly templateUri: string;

  constructor(
    private readonly declarative: DeclarativeUiMcpAppsResourceAdapter,
    private readonly react: ReactUiMcpAppsPort,
  ) {
    this.templateUri = declarative.templateUri;
  }

  async listResources(context: InvocationContext): Promise<McpAppsResourceDescriptor[]> {
    const [declarative, react] = await Promise.all([
      this.declarative.listResources(context),
      this.react.listResources(context),
    ]);
    return [...declarative, ...react] as McpAppsResourceDescriptor[];
  }

  async readResource(uri: string, context: InvocationContext): Promise<McpAppsResourceContent> {
    if (uri.startsWith('ui://marshal-react/')) {
      return (await this.react.readResource(uri, context)) as McpAppsResourceContent;
    }
    return this.declarative.readResource(uri, context);
  }

  descriptor(artifact: UiArtifact): McpAppsResourceDescriptor {
    return this.declarative.descriptor(artifact);
  }

  templateDescriptor(): McpAppsResourceDescriptor {
    return this.declarative.templateDescriptor();
  }

  templateContent(): McpAppsResourceContent {
    return this.declarative.templateContent();
  }

  toolMetadata(artifactOrUri?: UiArtifact | string) {
    return this.declarative.toolMetadata(artifactOrUri);
  }

  reactToolMetadata() {
    return this.react.toolMetadata();
  }

  listRenderTools(context: InvocationContext): Promise<UiRenderToolDescriptor[]> {
    return this.react.listRenderTools(context);
  }

  invokeRenderTool(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<UiRenderToolResult | undefined> {
    return this.react.invokeRenderTool(name, input, context);
  }
}
