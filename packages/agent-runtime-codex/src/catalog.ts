import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  projectToolMetadata,
  type ManifestToolProjection,
} from '@marshal/agent-runtime-manifest';
import type {
  RuntimeCatalogEntry,
  RuntimeCatalogProvider,
} from '@marshal/agent-runtime-core';
import type { RuntimeHostProviderSource } from '@marshal/agent-runtime-host';
import { RUNTIME_TOOLS } from './protocol.js';

const CODEX_HOST_TOOL_CATALOG_PROVIDER_ID = 'marshal.codex-host-tools';
const CODEX_HOST_TOOL_CATALOG_ID_PREFIX =
  `catalog://${CODEX_HOST_TOOL_CATALOG_PROVIDER_ID}/host-tool/`;
const CODEX_HOST_TOOL_DISCOVERY_LABELS = new Set([
  'marshal.tool.discovery',
  'marshal.tool.execution',
]);

/** Projects selected model-facing Codex tools from their canonical MCP definitions. */
export function createCodexHostToolDiscoverySource(
  tools: readonly Tool[] = RUNTIME_TOOLS,
): RuntimeHostProviderSource {
  const entries = tools
    .filter(isDiscoverableHostTool)
    .map(hostToolCatalogEntry);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const catalog: RuntimeCatalogProvider = {
    id: CODEX_HOST_TOOL_CATALOG_PROVIDER_ID,
    list: () => entries,
    get: (id) => entriesById.get(id),
  };
  return () => ({ providers: [], catalog });
}

function isDiscoverableHostTool(tool: Tool): boolean {
  return toolProjection(tool.name).evalLabels.some((label) =>
    CODEX_HOST_TOOL_DISCOVERY_LABELS.has(label));
}

function hostToolCatalogEntry(tool: Tool): RuntimeCatalogEntry {
  const projection = toolProjection(tool.name);
  return {
    id: `${CODEX_HOST_TOOL_CATALOG_ID_PREFIX}${encodeURIComponent(tool.name)}`,
    kind: 'host_tool',
    title: tool.title ?? projection.title,
    description: tool.description ?? projection.description,
    tags: ['host_tool', 'codex', ...projection.evalLabels],
    action: { type: 'host_tool', toolId: tool.name },
    metadata: {
      adapterId: 'codex',
      owner: {
        type: 'adapter',
        id: 'codex',
      },
      manifestLabels: [...projection.evalLabels],
    },
  };
}

function toolProjection(name: string): ManifestToolProjection {
  const projection = projectToolMetadata(name);
  if (!projection) {
    throw new Error(`Capability manifest has no tool projection for ${name}.`);
  }
  return projection;
}
