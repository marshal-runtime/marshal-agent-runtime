import { createRequire } from 'node:module';
import type { UiAuthoringProfile, UiHostCapabilities } from '@marshal/agent-runtime-ui';

export const CODEX_OPENAI_UI_PROFILE_ID = 'openai-apps-sdk-ui';
export const CODEX_OPENAI_UI_PROFILE_VERSION = '1.0.0';
export const OPENAI_APPS_SDK_UI_VERSION = '0.2.2';

const OPENAI_UI_PACKAGE = '@openai/apps-sdk-ui';
const requireFromAdapter = createRequire(import.meta.url);

/**
 * Codex/OpenAI-specific authoring guidance supplied at the adapter edge. The
 * package is bundled by this adapter; the portable UI runtime only sees the
 * profile, resolver, and bounded dependency root ports.
 */
export const CODEX_OPENAI_UI_AUTHORING_PROFILE: UiAuthoringProfile = Object.freeze({
  id: CODEX_OPENAI_UI_PROFILE_ID,
  version: CODEX_OPENAI_UI_PROFILE_VERSION,
  portable: false,
  packageImports: [OPENAI_UI_PACKAGE],
  packageVersions: { [OPENAI_UI_PACKAGE]: OPENAI_APPS_SDK_UI_VERSION },
  designTokens: {
    'color.text.primary': 'var(--color-text-primary)',
    'color.text.secondary': 'var(--color-text-secondary)',
    'color.background.primary': 'var(--color-background-primary)',
    'color.background.secondary': 'var(--color-background-secondary)',
    'font.sans': 'var(--font-sans)',
    'font.mono': 'var(--font-mono)',
  },
  templates: [
    'compact-inline-card',
    'responsive-carousel',
    'fullscreen-workspace',
    'picture-in-picture-status',
  ],
  authoringGuidance:
    'Prefer standards-first React and MCP Apps. Import components from @openai/apps-sdk-ui/components/* and CSS from @openai/apps-sdk-ui/css, never the package root. OpenAI extensions are optional. For each declared fullscreen or PiP mode, render a visible named control; disable or explain it when unavailable, announce the typed outcome, and keep inline complete. Persistent apps expose distinct runtime-backed Save and Reopen/Load controls. Custom React/CSS remains valid.',
  accessibilityRequirements: [
    'Meet WCAG 2.2 AA; provide keyboard operation, visible focus, semantic names, sufficient contrast, and announced dynamic status.',
    'Honor reduced-motion, text zoom, and host theme variables without losing information or controls.',
  ],
  layoutConstraints: [
    'Design inline first for narrow chat containers, then progressively enhance fullscreen and picture-in-picture through negotiated display modes.',
    'Use host container dimensions and safe-area insets; avoid viewport assumptions and preserve a functional inline fallback.',
  ],
  requiredHostCapabilities: ['serverTools', 'serverResources'],
  optionalHostExtensions: [
    'openai.requestModal',
    'openai.selectFiles',
    'openai.uploadFile',
    'openai.getFileDownloadUrl',
    'openai.requestClose',
    'openai.openExternal',
    'openai.openInApp',
  ],
});

/** Capabilities the Codex MCP Apps adapter itself can truthfully project. */
export const CODEX_UI_HOST_CAPABILITIES: UiHostCapabilities = Object.freeze({
  serverTools: true,
  serverResources: true,
  extensions: {
    openai: {
      featureDetected: true,
    },
  },
});

/** Resolve only the package advertised by the Codex/OpenAI profile. */
export function resolveCodexUiPackageImport(specifier: string): string | undefined {
  if (packageNameOf(specifier) !== OPENAI_UI_PACKAGE) return undefined;
  try {
    return requireFromAdapter.resolve(specifier);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

function packageNameOf(specifier: string): string {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second ?? ''}` : first;
}
