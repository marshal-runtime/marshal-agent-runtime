import type { InvocationContext } from '@marshal/agent-runtime-core';
import type { UiApplicationManifest } from './applicationTypes.js';
import { REACT_UI_TEMPLATE_URI } from './runtimeRenderer.js';
import type { ReactUiStore } from './store.js';

export const REACT_UI_PUBLICATION_OWNER_ID = 'marshal.react-ui';
const MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Structural match for `RuntimeExtensionUiPublishedApplication` from
 * `@marshal/agent-runtime-extensions` — declared structurally here because the
 * portable UI package must not depend on the extensions package
 * (runtime-boundaries). A host can merge these entries into its published-
 * application resolution so its existing `ui.application.open` /
 * `ui.chat.card.show` capabilities place agent-authored renders on host
 * surfaces with `{extensionId: REACT_UI_PUBLICATION_OWNER_ID,
 * applicationId: <renderId>, surface?, state?, idempotencyKey}`.
 */
export interface AuthoredRenderPublishedApplication {
  readonly ownerId: string;
  readonly revisionId: string;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly renderId: string;
  readonly resource: { readonly uri: string; readonly mimeType: string; readonly name?: string };
  readonly application: UiApplicationManifest;
  readonly tags?: readonly string[];
}

const DEFAULT_APPLICATION: UiApplicationManifest = Object.freeze({
  version: '1.0.0',
  presentationModes: ['inline'],
  actions: [],
  tools: [],
}) as UiApplicationManifest;

/**
 * Project the scope's authored React renders as published-application entries.
 * `applicationId` and `revisionId` are the content-addressed render id, so a
 * placement request names one immutable render; re-rendering yields a new id.
 */
export async function listAuthoredRenderApplications(
  store: ReactUiStore,
  context: InvocationContext,
): Promise<readonly AuthoredRenderPublishedApplication[]> {
  const renders = await store.listRenders(context);
  return Promise.all(renders.map(async (render) => {
    const component = await store.getComponent(render.componentId, context);
    return Object.freeze({
      ownerId: REACT_UI_PUBLICATION_OWNER_ID,
      revisionId: render.id,
      id: render.id,
      title: component.title,
      description: render.fallback.summary,
      renderId: render.id,
      resource: { uri: REACT_UI_TEMPLATE_URI, mimeType: MIME_TYPE, name: component.title },
      application: render.application ?? DEFAULT_APPLICATION,
      tags: ['react', 'authored'] as const,
    });
  }));
}
