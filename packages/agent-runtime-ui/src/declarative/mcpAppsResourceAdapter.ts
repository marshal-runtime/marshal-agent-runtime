import type { InvocationContext } from '../coreTypes.js';
import {
  parseDeclarativeUiResourceUri,
  type DeclarativeUiStore,
} from './store.js';
import {
  DECLARATIVE_UI_TEMPLATE_URI,
  mcpAppsContent,
  mcpAppsDescriptor,
  mcpAppsTemplateContent,
  mcpAppsTemplateDescriptor,
  mcpAppsToolMetadata,
} from './renderer.js';
import type {
  McpAppsResourceContent,
  McpAppsResourceDescriptor,
  McpAppsResourcePort,
  UiArtifact,
} from './types.js';

export class DeclarativeUiMcpAppsResourceAdapter implements McpAppsResourcePort {
  readonly templateUri = DECLARATIVE_UI_TEMPLATE_URI;
  constructor(private readonly store: DeclarativeUiStore) {}

  async listResources(context: InvocationContext): Promise<McpAppsResourceDescriptor[]> {
    const summaries = await this.store.list(context);
    const artifacts = await Promise.all(
      summaries.map(async (summary) =>
        mcpAppsDescriptor(await this.store.get(summary.id, context)),
      ),
    );
    return [mcpAppsTemplateDescriptor(), ...artifacts];
  }

  async readResource(uri: string, context: InvocationContext): Promise<McpAppsResourceContent> {
    if (uri === this.templateUri) return mcpAppsTemplateContent();
    const parsed = parseDeclarativeUiResourceUri(uri);
    const artifact = await this.store.getRevision(
      parsed.id,
      parsed.revision,
      parsed.documentDigest,
      context,
    );
    if (artifact.resourceUri !== uri) throw new Error('UI resource identity validation failed');
    return mcpAppsContent(artifact);
  }

  descriptor(artifact: UiArtifact): McpAppsResourceDescriptor {
    return mcpAppsDescriptor(artifact);
  }

  templateDescriptor(): McpAppsResourceDescriptor {
    return mcpAppsTemplateDescriptor();
  }

  templateContent(): McpAppsResourceContent {
    return mcpAppsTemplateContent();
  }

  toolMetadata(artifactOrUri?: UiArtifact | string): ReturnType<typeof mcpAppsToolMetadata> {
    return mcpAppsToolMetadata(
      artifactOrUri === undefined
        ? this.templateUri
        : typeof artifactOrUri === 'string'
          ? artifactOrUri
          : artifactOrUri.resourceUri,
    );
  }
}
