/** Optional host facilities. No host, editor, model, or provider implementation belongs here. */
export const UI_HOST_INTERACTION_METHOD = 'marshal/interaction' as const;
export const UI_HOST_INTERACTION_EVENT = 'ui/notifications/interaction' as const;
export const UI_HOST_FEATURES = ['workspace', 'media'] as const;
export type UiHostFeature = typeof UI_HOST_FEATURES[number];

export interface UiSourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface UiDocumentSnapshot {
  id: string;
  path: string;
  version: number;
  language: string;
  selection: UiSourceRange | null;
  visibleRanges: readonly UiSourceRange[];
  focused: boolean;
  visible: boolean;
}

export interface UiWorkspaceSnapshot {
  revision: number;
  documents: readonly UiDocumentSnapshot[];
}

export interface UiHostAnnotation {
  id: string;
  range: UiSourceRange;
  label: string;
  detail?: string;
  tone: 'info' | 'positive' | 'warning' | 'muted';
}

export type UiHostInteractionRequest =
  | { operation: 'workspace.snapshot' }
  | { operation: 'workspace.read'; documentId: string; expectedVersion: number }
  | { operation: 'workspace.reveal'; documentId: string; expectedVersion: number; range: UiSourceRange; focus?: boolean }
  | { operation: 'workspace.annotate'; documentId: string; expectedVersion: number; annotations: readonly UiHostAnnotation[] }
  | { operation: 'media.offer' }
  | { operation: 'media.answer'; connectionId: string; sdp: string }
  | { operation: 'media.send'; connectionId: string; event: Readonly<Record<string, unknown>> }
  | { operation: 'media.close'; connectionId?: string };

export type UiHostInteractionEvent =
  | { type: 'workspace'; snapshot: UiWorkspaceSnapshot }
  | { type: 'media'; connectionId: string; event: unknown }
  | { type: 'media-state'; connectionId: string; state: string };

export function validateUiHostFeatures(value: unknown): readonly UiHostFeature[] {
  if (!Array.isArray(value) || value.length > UI_HOST_FEATURES.length ||
    value.some((feature) => !UI_HOST_FEATURES.includes(feature as UiHostFeature)) ||
    new Set(value).size !== value.length) throw new Error('application.hostFeatures is invalid');
  return [...value] as UiHostFeature[];
}
