export type MarshalIntent = 'memory' | 'typescript' | 'ui' | 'composition';
export type MarshalRoute = 'marshal' | 'direct' | 'native_visualization';
export type RoutingExampleKind = 'direct' | 'indirect' | 'negative';

export interface ManifestToolProjection {
  readonly title: string;
  readonly description: string;
  readonly evalLabels: readonly string[];
}

export interface ManifestRouteDefinition {
  readonly intent: MarshalIntent;
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly signalPatterns: readonly string[];
  readonly evalLabel: string;
}

export interface ManifestCallbackHint {
  readonly phase:
    | 'session.start'
    | 'prompt.submit'
    | 'tool.invoke'
    | 'tool.result'
    | 'assistant.complete'
    | 'session.end'
    | 'subagent.start'
    | 'subagent.end';
  readonly purpose: string;
  readonly blocking: boolean;
  readonly injectsContext: boolean;
}

export interface ManifestRoutingExample {
  readonly id: string;
  readonly kind: RoutingExampleKind;
  readonly prompt: string;
  readonly expectedRoute: MarshalRoute;
  readonly expectedIntents: readonly MarshalIntent[];
  readonly labels: readonly string[];
}

export const MARSHAL_MANIFEST_VERSION = '1.0.0';

/** Kept deliberately below 512 characters because hosts may truncate server instructions. */
export const MARSHAL_SELECTION_PREAMBLE =
  'Use Marshal for durable memory, editable TypeScript, composed capabilities, or persistent React. Marshal—not generic visualization—owns durable custom UI. Have Brain remember explicit requests, stable preferences, standing constraints, and reusable agent discoveries even without “remember”; recall only when prior evidence is needed. Hooks only enqueue observe/reflect. In TypeScript, start independent code, Brain, agents, artifacts concurrently; await dependencies. Skip simple work and disposable charts.';

export const MARSHAL_CAPABILITY_MANIFEST = Object.freeze({
  schemaVersion: '1.0.0',
  manifestVersion: MARSHAL_MANIFEST_VERSION,
  product: {
    name: 'Marshal Runtime',
    summary:
      'Harness-neutral persistent memory, editable TypeScript, composable capabilities, artifacts, delegation, and adaptive applications.',
  },
  selectionPreamble: MARSHAL_SELECTION_PREAMBLE,
  routes: [
    {
      intent: 'memory',
      summary: 'Use the specialized Brain for scoped durable recall, remember, observation, and reflection.',
      useWhen: [
        'The user explicitly asks to remember or not forget durable information.',
        'The user states a stable preference, standing convention, identity fact, or durable constraint that is likely to help future tasks, even without asking to remember it.',
        'The request depends on preferences, facts, or decisions from earlier tasks or workspaces.',
        'The agent discovers a durable repository procedure, constraint, decision, or piece of evidence that will matter in future work; remember it without blocking independent work, but wait for finalization before any step whose correctness depends on it.',
        'The user asks to inspect, correct, delete, or audit stored memory.',
      ],
      avoidWhen: [
        'The needed fact exists in the current prompt or current transient conversation only.',
        'A finalized Brain receipt or injected result already answers the need; do not repeat the operation.',
      ],
      signalPatterns: [
        '\\b(?:remember|do not forget|don.t forget|save this for (?:later|next time))\\b',
        '\\b(?:my (?:standing|default|long[- ]term|ongoing) preference|i (?:always|generally|usually) prefer|from now on|standing (?:constraint|convention|rule))\\b',
        '\\b(?:what did (?:we|i) (?:decide|choose|say)|last task|previous task|another workspace)\\b',
        '\\b(?:discovered|learned|established|found)\\b[\\s\\S]{0,100}\\b(?:repository|repo|procedure|constraint|decision|evidence|future work)\\b',
        '\\b(?:inspect|audit|delete|correct) (?:my |the )?(?:saved )?memor(?:y|ies)\\b',
      ],
      evalLabel: 'marshal.intent.memory',
    },
    {
      intent: 'typescript',
      summary:
        'Use editable TypeScript for bounded processing, substantial intermediate data, reusable logic, or composition; pure modules need no discovery.',
      useWhen: [
        'The user asks for editable or reusable TypeScript or JavaScript logic.',
        'A parser, normalizer, matcher, migration, or substantial data transformation is clearer in code.',
        'The task benefits from rerunning edited logic or composing multiple runtime capabilities.',
      ],
      avoidWhen: [
        'One direct tool call or a simple native command is clearer.',
        'A tiny arithmetic or factual answer needs no reusable program.',
      ],
      signalPatterns: [
        '\\b(?:editable|reusable|rerun|iterate on) (?:typescript|javascript|module|script|logic)\\b',
        '\\b(?:parse|normalize|transform|migrate|deduplicate|reconcile)\\b[\\s\\S]{0,80}\\b(?:records|dataset|files|logs|json|csv|results)\\b',
        '\\b(?:substantial intermediate data|compose multiple capabilities|programmatic execution)\\b',
      ],
      evalLabel: 'marshal.intent.typescript',
    },
    {
      intent: 'ui',
      summary:
        'Use Marshal alone for custom, persistent, reusable, editable, or runtime-backed React UI; substantive operations must be declared runtime-backed actions or tools, never local simulations.',
      useWhen: [
        'The user asks for custom React, durable controls, saved state, editable source, or a reusable application.',
        'People benefit from inspecting, comparing, editing, confirming, or navigating structured results.',
        'The experience benefits from inline, fullscreen, or picture-in-picture presentation when supported.',
        'The interface exposes controls that generate, refine, apply, implement, persist, delegate, invoke a model or tool, or change authoritative source or data.',
      ],
      avoidWhen: [
        'A disposable chart, diagram, or lightweight plot needs no custom behavior or persistence.',
        'Plain text is clearer than an interface.',
      ],
      signalPatterns: [
        '\\b(?:custom|editable|persistent|reusable|runtime-backed) (?:react )?(?:ui|interface|app|application|dashboard|explorer)\\b',
        '\\b(?:saved state|fullscreen|full-screen|picture-in-picture|pip|interactive controls)\\b',
        '\\b(?:explore|compare|edit|configure|simulate)\\b[\\s\\S]{0,80}\\b(?:interactively|interface|app|controls)\\b',
        '\\b(?:interactive|visual|design)\\b[\\s\\S]{0,40}\\b(?:workspace|studio|canvas)\\b',
      ],
      evalLabel: 'marshal.intent.ui',
    },
    {
      intent: 'composition',
      summary:
        'Discover and compose capabilities when a task joins memory, artifacts, attachments, code intelligence, jobs, schedules, or bounded subagents.',
      useWhen: [
        'The task needs more than one runtime capability or reusable orchestration logic.',
        'Bounded delegation, parallel specialists, durable jobs, schedules, or artifacts materially improve the result.',
        'An application backend must safely invoke declared runtime actions.',
        'A complex application benefits from genuinely divergent directions, independent critique, or parallel verification.',
      ],
      avoidWhen: [
        'One known capability or native tool completes the task directly.',
        'Delegation would add duplication without a useful independent workstream.',
      ],
      signalPatterns: [
        '\\b(?:compose|combine|coordinate|orchestrate)\\b[\\s\\S]{0,100}\\b(?:capabilities|memory|artifacts|attachments|code intelligence|tools)\\b',
        '\\b(?:subagents?|delegate|parallel specialists?|fan[- ]out|durable job|schedule|recurring|remind)\\b',
        '\\b(?:backend action|application action|tool-backed controls)\\b',
        '\\b(?:design|product|application)\\b[\\s\\S]{0,160}\\b(?:several|multiple|meaningfully different|genuinely different)\\b[\\s\\S]{0,50}\\bdirections?\\b',
      ],
      evalLabel: 'marshal.intent.composition',
    },
  ] satisfies readonly ManifestRouteDefinition[],
  negativeRouting: {
    directPatterns: [
      '^\\s*(?:what is|calculate)\\s+[0-9+*/().% -]+\\??\\s*$',
      '^\\s*(?:show|tell) me (?:the )?(?:current time|working directory)\\??\\s*$',
      '\\b(?:one direct tool call|single direct command|simple answer only)\\b',
    ],
    nativeVisualizationPatterns: [
      '\\b(?:quick|disposable|one-off|throwaway)\\b[\\s\\S]{0,40}\\b(?:chart|diagram|plot|graph)\\b',
    ],
    evalLabels: ['marshal.route.direct', 'marshal.route.native_visualization'],
  },
  tools: {
    runtime_search: {
      title: 'Discover Marshal capabilities and catalog entries',
      description:
        'Discover Marshal runtime capabilities and additive catalog entries. Response matches remain capability results; discoveries may contain skill, resource, host_tool, or ui_application entries. For broad search, omit detail or use detail:"summary". Resolve a capability by exact name for full input/output schemas, or resolve a catalog entry by exact catalogId. Discovery actions resource_read, host_tool, and ui_render describe the next step but do not grant execution authority. Set detail:"full" only when all broad-match schemas are required. Skip discovery for pure TypeScript that calls no runtime capability.',
      evalLabels: ['marshal.tool.discovery', 'marshal.route.composition'],
    },
    runtime_exec: {
      title: 'Execute a Marshal operation or module',
      description:
        'Invoke one discovered operation or execute TypeScript from inline source, an editable workspace file, or a scoped artifact. Always provide targetType plus its required target, source, or module. Prefer modules for bounded processing, reusable logic, substantial intermediate data, or multi-capability composition; avoid them for one clearer direct call. For a module that waits on nested capabilities, explicitly set the outer timeoutMs above the longest nested wait plus execution overhead and within the advertised maximum; nested timeouts never extend the outer budget.',
      evalLabels: ['marshal.tool.execution', 'marshal.intent.typescript'],
    },
    runtime_session_start: {
      title: 'Start a Marshal lifecycle session',
      description:
        'Start one lifecycle session for the host task or thread and use any injected durable-memory context. Reuse it across assistant turns.',
      evalLabels: ['marshal.tool.lifecycle', 'marshal.intent.memory'],
    },
    runtime_observe_turn: {
      title: 'Observe a Marshal lifecycle turn',
      description:
        'Send a meaningful user message, tool result, or assistant turn to configured memory and audit lifecycle integrations.',
      evalLabels: ['marshal.tool.lifecycle', 'marshal.intent.memory'],
    },
    runtime_session_end: {
      title: 'End a Marshal lifecycle session',
      description:
        'Flush lifecycle integrations only when the host task or thread truly ends, never after an ordinary assistant response.',
      evalLabels: ['marshal.tool.lifecycle'],
    },
    runtime_render_ui: {
      title: 'Display a declarative Marshal interface',
      description:
        'Display a prepared declarative UI artifact inline using its artifact ID. Keep the structured fallback complete.',
      evalLabels: ['marshal.tool.ui', 'marshal.ui.declarative'],
    },
    runtime_render_component: {
      title: 'Display a compiled Marshal React application',
      description:
        'Display an existing compiled React render by render ID. Redisplay the same ID without rewriting source, recompiling, or creating another binding.',
      evalLabels: ['marshal.tool.ui', 'marshal.intent.ui'],
    },
  } satisfies Readonly<Record<string, ManifestToolProjection>>,
  callbacks: [
    { phase: 'session.start', purpose: 'Inject compact capability awareness and establish the task lifecycle.', blocking: true, injectsContext: true },
    { phase: 'prompt.submit', purpose: 'Durably enqueue bounded observation evidence and inject a compact manifest-derived routing hint without running a model in the hook process.', blocking: true, injectsContext: true },
    { phase: 'tool.invoke', purpose: 'Bind authoritative host task, thread, workspace, and request identity to each Marshal invocation.', blocking: true, injectsContext: false },
    { phase: 'tool.result', purpose: 'Queue bounded observation without changing the tool result.', blocking: false, injectsContext: false },
    { phase: 'assistant.complete', purpose: 'Queue the completed assistant turn for observation.', blocking: false, injectsContext: false },
    { phase: 'subagent.start', purpose: 'Give a child compact capability awareness and a scoped runtime identity.', blocking: true, injectsContext: true },
    { phase: 'subagent.end', purpose: 'Record the bounded child outcome.', blocking: false, injectsContext: false },
    { phase: 'session.end', purpose: 'Flush and close the task lifecycle.', blocking: false, injectsContext: false },
  ] satisfies readonly ManifestCallbackHint[],
  examples: [
    { id: 'memory-direct', kind: 'direct', prompt: 'Remember that release reviews use the violet checklist.', expectedRoute: 'marshal', expectedIntents: ['memory'], labels: ['marshal.intent.memory', 'marshal.routing.direct'] },
    { id: 'memory-stable-preference', kind: 'indirect', prompt: 'My standing preference is to call the final checklist the cobalt lantern and always inspect accessibility before performance.', expectedRoute: 'marshal', expectedIntents: ['memory'], labels: ['marshal.intent.memory', 'marshal.routing.indirect'] },
    { id: 'memory-indirect', kind: 'indirect', prompt: 'What did we decide about release reviews in the previous task?', expectedRoute: 'marshal', expectedIntents: ['memory'], labels: ['marshal.intent.memory', 'marshal.routing.indirect'] },
    { id: 'memory-agent-discovery', kind: 'indirect', prompt: 'During this repository task I discovered that generated schema files must be refreshed before typechecking; preserve that procedure for future work without blocking the independent test run.', expectedRoute: 'marshal', expectedIntents: ['memory'], labels: ['marshal.intent.memory', 'marshal.routing.indirect'] },
    { id: 'typescript-direct', kind: 'direct', prompt: 'Create an editable TypeScript module that normalizes these incident records and can be rerun later.', expectedRoute: 'marshal', expectedIntents: ['typescript'], labels: ['marshal.intent.typescript', 'marshal.routing.direct'] },
    { id: 'typescript-indirect', kind: 'indirect', prompt: 'Normalize these JSON records, preserve the logic so I can edit it, and rerun it on tomorrow’s export.', expectedRoute: 'marshal', expectedIntents: ['typescript'], labels: ['marshal.intent.typescript', 'marshal.routing.indirect'] },
    { id: 'ui-direct', kind: 'direct', prompt: 'Build a persistent custom React dashboard with editable source and saved state.', expectedRoute: 'marshal', expectedIntents: ['ui'], labels: ['marshal.intent.ui', 'marshal.routing.direct'] },
    { id: 'ui-indirect', kind: 'indirect', prompt: 'Let me explore and configure these options interactively in a reusable interface with saved state.', expectedRoute: 'marshal', expectedIntents: ['ui'], labels: ['marshal.intent.ui', 'marshal.routing.indirect'] },
    { id: 'composition-direct', kind: 'direct', prompt: 'Compose memory, code intelligence, and two bounded subagents in an editable orchestration module.', expectedRoute: 'marshal', expectedIntents: ['typescript', 'composition'], labels: ['marshal.intent.composition', 'marshal.routing.direct'] },
    { id: 'composition-indirect', kind: 'indirect', prompt: 'Delegate independent checks to parallel specialists, compare their results, and save the combined artifact.', expectedRoute: 'marshal', expectedIntents: ['composition'], labels: ['marshal.intent.composition', 'marshal.routing.indirect'] },
    { id: 'scheduling-direct', kind: 'direct', prompt: 'Remind me tomorrow at 09:00 to review the release checklist.', expectedRoute: 'marshal', expectedIntents: ['composition'], labels: ['marshal.intent.composition', 'marshal.capability.scheduling', 'marshal.routing.direct'] },
    { id: 'scheduling-indirect', kind: 'indirect', prompt: 'Check the release every hour until Friday and keep the recurring reminder available across tasks.', expectedRoute: 'marshal', expectedIntents: ['composition'], labels: ['marshal.intent.composition', 'marshal.capability.scheduling', 'marshal.routing.indirect'] },
    { id: 'design-studio-indirect', kind: 'indirect', prompt: 'Build me a complete interactive design workspace for this product, explore several genuinely different directions, let me compare and refine them directly, preserve the editable implementation, and make it usable here.', expectedRoute: 'marshal', expectedIntents: ['ui', 'composition'], labels: ['marshal.intent.ui', 'marshal.intent.composition', 'marshal.routing.indirect'] },
    { id: 'negative-simple', kind: 'negative', prompt: 'What is 17% of 80?', expectedRoute: 'direct', expectedIntents: [], labels: ['marshal.route.direct', 'marshal.routing.negative'] },
    { id: 'negative-command', kind: 'negative', prompt: 'Tell me the current working directory?', expectedRoute: 'direct', expectedIntents: [], labels: ['marshal.route.direct', 'marshal.routing.negative'] },
    { id: 'negative-visualization', kind: 'negative', prompt: 'Make a quick disposable bar chart of these five values.', expectedRoute: 'native_visualization', expectedIntents: [], labels: ['marshal.route.native_visualization', 'marshal.routing.negative'] },
  ] satisfies readonly ManifestRoutingExample[],
});

export type MarshalCapabilityManifest = typeof MARSHAL_CAPABILITY_MANIFEST;
