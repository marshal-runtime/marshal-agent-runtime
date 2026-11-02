import type { RuntimeExtensionLifecycleRecord } from './services.js';

/**
 * Canonical renderer for per-extension agent-prompt sections. Hosts call this
 * with `RuntimeExtensionLifecycleService.list()` output and embed the result
 * verbatim as the extension layer of an agent system prompt. Single owner:
 * hosts must not fork the rendering rules — divergence between prompt
 * renderers is a contract violation (see prompt-implementation contract).
 *
 * Rules (deterministic):
 * - Records are sorted by identity ascending (byte order).
 * - `health === 'healthy'` renders a full block from `agentGuidance`,
 *   falling back to catalog `title`/`description` when guidance is absent.
 * - `health === 'blocked'` renders a one-line degraded entry naming the first
 *   block reason — the extension exists but must not be claimed usable.
 * - `health === 'disabled'` (and anything else) renders nothing: disabled
 *   extensions stay discoverable through runtimeListExtensions only.
 * - Every healthy/blocked extension gets its section; there is no total cap.
 *   Boundedness comes from the manifest-validated field caps.
 */
export interface ExtensionPromptSection {
  readonly identity: string;
  readonly version: string;
  readonly health: 'healthy' | 'blocked';
  readonly text: string;
}

export function buildExtensionPromptSections(
  records: readonly RuntimeExtensionLifecycleRecord[],
): readonly ExtensionPromptSection[] {
  return [...records]
    .sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0))
    .flatMap((record): readonly ExtensionPromptSection[] => {
      if (record.health === 'blocked') {
        const reason = record.blockReasons[0]?.message?.trim() || 'blocked by the runtime';
        return [{
          identity: record.identity,
          version: record.version,
          health: 'blocked' as const,
          text: `### ${record.identity} v${record.version} — unavailable: ${clip(reason, 300)}`,
        }];
      }
      if (record.health !== 'healthy') return [];
      const guidance = record.agentGuidance;
      const purpose = guidance?.purpose?.trim()
        || record.description?.trim()
        || record.title?.trim()
        || 'No description provided.';
      const capabilities = (record.contributedCapabilityPrefixes ?? []).slice(0, 16);
      const firstCapability = capabilities[0];
      const lines = [
        `### ${record.identity} v${record.version}`,
        `purpose: ${clip(purpose, 300)}`,
        ...(guidance?.when ? [`when: ${clip(guidance.when, 300)}`] : []),
        ...(guidance?.recipe ? [`recipe: ${clip(guidance.recipe, 700)}`] : []),
        ...(capabilities.length > 0 ? [`capabilities: ${capabilities.join(', ')}`] : []),
        ...(guidance?.boundaries ? [`boundaries: ${clip(guidance.boundaries, 300)}`] : []),
        // contributedCapabilityPrefixes are name PREFIXES, not exact capability
        // names — an exact-name lookup on a prefix finds nothing. Guide the
        // agent to a query search first, exact-name only on a returned name.
        `details: ${firstCapability
          ? `runtimeSearch {query: "${firstCapability}"} to list capabilities, then exact-name lookup on a returned capability for its full schema; runtimeReadResource for docs`
          : 'runtimeSearch by topic for capabilities; runtimeReadResource for docs'}`,
      ];
      return [{
        identity: record.identity,
        version: record.version,
        health: 'healthy' as const,
        text: lines.join('\n'),
      }];
    });
}

/** Join sections into the final prompt layer. Empty input renders nothing. */
export function renderExtensionPromptBlock(
  sections: readonly ExtensionPromptSection[],
): string {
  if (sections.length === 0) return '';
  return ['## Installed runtime extensions', ...sections.map((section) => section.text)].join('\n\n');
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
