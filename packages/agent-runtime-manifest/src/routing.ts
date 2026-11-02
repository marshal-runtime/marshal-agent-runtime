import {
  MARSHAL_CAPABILITY_MANIFEST,
  type MarshalIntent,
  type MarshalRoute,
  type RoutingExampleKind,
} from './manifest.js';

export interface MarshalRoutingDecision {
  readonly route: MarshalRoute;
  readonly intents: readonly MarshalIntent[];
  readonly labels: readonly string[];
}

/** Deterministic reference oracle for golden prompts and eval labeling. */
export function classifyMarshalPrompt(
  prompt: string,
  kind?: RoutingExampleKind,
): MarshalRoutingDecision {
  const normalized = boundedPrompt(prompt);
  const exact = MARSHAL_CAPABILITY_MANIFEST.examples.find(
    (example) => example.prompt.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
  );
  if (exact) {
    return { route: exact.expectedRoute, intents: exact.expectedIntents, labels: exact.labels };
  }

  const nativeVisualization = matchesAny(
    normalized,
    MARSHAL_CAPABILITY_MANIFEST.negativeRouting.nativeVisualizationPatterns,
  );
  if (nativeVisualization) {
    return {
      route: 'native_visualization',
      intents: [],
      labels: ['marshal.route.native_visualization', `marshal.routing.${kind ?? 'unlabeled'}`],
    };
  }
  const direct = matchesAny(
    normalized,
    MARSHAL_CAPABILITY_MANIFEST.negativeRouting.directPatterns,
  );
  if (direct) {
    return {
      route: 'direct',
      intents: [],
      labels: ['marshal.route.direct', `marshal.routing.${kind ?? 'unlabeled'}`],
    };
  }

  const intents = MARSHAL_CAPABILITY_MANIFEST.routes
    .filter((route) => matchesAny(normalized, route.signalPatterns))
    .map((route) => route.intent);
  return {
    route: intents.length > 0 ? 'marshal' : 'direct',
    intents,
    labels: intents.length > 0
      ? [
          ...intents.map((intent) => `marshal.intent.${intent}`),
          `marshal.routing.${kind ?? 'unlabeled'}`,
        ]
      : ['marshal.route.direct', `marshal.routing.${kind ?? 'unlabeled'}`],
  };
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, 'iu').test(value));
}

function boundedPrompt(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('prompt must be non-empty.');
  if (value.length > 20_000) throw new TypeError('prompt must be at most 20000 characters.');
  return value.normalize('NFKC').trim();
}
