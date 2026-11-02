import {
  MARSHAL_CAPABILITY_MANIFEST,
  MARSHAL_MANIFEST_VERSION,
  type ManifestCallbackHint,
  type ManifestRoutingExample,
  type ManifestToolProjection,
} from './manifest.js';
import { classifyMarshalPrompt } from './routing.js';

export interface MarshalProjectionEntryPoints {
  readonly discovery?: string;
  readonly execution?: string;
  readonly renderComponent?: string;
  readonly extensionManager?: string;
}

const DELEGATION_IDENTITY_GUIDANCE = 'Retain the delegationId returned by spawn for continuation and observation. parentDelegationId records hierarchy only and enables explicitly requested recursive cancellation.';
const DELEGATION_LIFECYCLE_GUIDANCE = 'runtime.delegation.wait has no timeout and resolves when the delegated work is done or failed. Cancellation is explicit and records a failed terminal result.';
const DISCOVERY_RESULT_GUIDANCE = 'Search responses keep executable capability results in `matches`; additive `discoveries` may contain `skill`, `resource`, `host_tool`, and `ui_application` entries. Resolve a capability by exact `name` for full schemas, or resolve a catalog entry by exact `catalogId`. Discovery actions `resource_read`, `host_tool`, and `ui_render` describe the next adapter or agent step without granting execution authority.';

export function projectMcpServerInstructions(
  entryPoints: MarshalProjectionEntryPoints = {},
): string {
  const names = normalizeEntryPoints(entryPoints);
  const routeDetails = MARSHAL_CAPABILITY_MANIFEST.routes.map(
    (route) => `${route.intent}: ${route.summary}`,
  );
  return [
    MARSHAL_CAPABILITY_MANIFEST.selectionPreamble,
    `When the user asks to open, show, or launch the Marshal Runtime Extensions manager, call ${names.extensionManager}({}) immediately. Do not call Brain, search capabilities, inspect repositories, run GitNexus, or narrate a plan first.`,
    `Use ${names.discovery} when runtime capability or catalog discovery is needed. ${DISCOVERY_RESULT_GUIDANCE} For broad search, omit detail or use detail:"summary"; invoke selected capabilities through ${names.execution}. Pure TypeScript with no runtime calls does not require discovery.`,
    ...routeDetails,
    `For compiled React, write editable TSX, compile once, create one render, and display it with ${names.renderComponent}; redisplay the same render ID without recompiling.`,
    `Execution shapes: ${names.execution}({targetType:"operation",target:"capability.name",input:{...}}); ${names.execution}({targetType:"inline_module",source:"export default async (input) => input",input:{...}}); ${names.execution}({targetType:"module",module:{kind:"workspace_file",path:"relative/file.ts"},input:{...},timeoutMs:60000}). For modules that wait on nested calls, explicitly choose timeoutMs above the longest nested wait plus overhead and no higher than the tool-advertised maximum; nested timeouts do not extend it.`,
    'Brokered TypeScript exposes only scoped context.runtime.search/invoke, not harness-side runtime.agents or runtime.schema helpers. For durable fan-out, discover and invoke runtime.delegation.*, retain returned delegation IDs, and wait without replacement spawns.',
    DELEGATION_IDENTITY_GUIDANCE,
    DELEGATION_LIFECYCLE_GUIDANCE,
    'When native lifecycle hooks are installed, they own session start, durable observation enqueueing, and session end; do not call lifecycle tools yourself. Brain is the repository-intelligence and memory assistant: use recall first for natural-language architecture, rationale, related-implementation, blast-radius, unfamiliar-subsystem, cross-cutting, or prior-decision questions, especially without an exact symbol. Use remember for durable user or agent discoveries.',
    `Manifest version: ${MARSHAL_MANIFEST_VERSION}.`,
  ].join(' ');
}

export function projectLifecycleBriefing(
  entryPoints: MarshalProjectionEntryPoints = {},
): string {
  const names = normalizeEntryPoints(entryPoints);
  return [
    '## Marshal Runtime capability briefing',
    '',
    MARSHAL_CAPABILITY_MANIFEST.product.summary,
    `- ${MARSHAL_CAPABILITY_MANIFEST.selectionPreamble}`,
    `- When the user asks to open, show, or launch the Marshal Runtime Extensions manager, call ${names.extensionManager}({}) immediately without Brain, discovery, repository inspection, GitNexus, or a narrated plan.`,
    `- For non-trivial work that needs runtime capabilities or catalog entries, start with a broad ${names.discovery} call using detail:"summary" (or omit detail). ${DISCOVERY_RESULT_GUIDANCE} Use detail:"full" on broad search only when every matching capability schema is necessary. Pure TypeScript does not require discovery.`,
    `- Use ${names.execution} for one discovered operation or an editable workspace-backed TypeScript module. Prefer modules for bounded processing, substantial intermediate data, reusable logic, or composition.`,
    `- Exact execution shapes: ${names.execution}({targetType:"operation",target:"capability.name",input:{...}}); ${names.execution}({targetType:"inline_module",source:"export default async (input) => input",input:{...}}); ${names.execution}({targetType:"module",module:{kind:"workspace_file",path:"relative/file.ts"},input:{...},timeoutMs:60000}). For modules that wait on nested calls, explicitly choose timeoutMs above the longest nested wait plus overhead and no higher than the tool-advertised maximum; nested timeouts do not extend it.`,
    '- Brokered TypeScript exposes only scoped context.runtime.search/invoke; never use harness-side runtime.agents or runtime.schema helpers inside the module. For resumable fan-out, invoke runtime.delegation.*, retain exact delegation IDs, and wait rather than launching replacements.',
    `- ${DELEGATION_IDENTITY_GUIDANCE}`,
    `- ${DELEGATION_LIFECYCLE_GUIDANCE}`,
    `- Use the specialized Memory Brain as the repository-intelligence and memory assistant instead of handling hierarchy, ranking, dedupe, placement, or provenance yourself. For natural-language architecture, mechanism, tradeoff, rationale, related-implementation, blast-radius, unfamiliar-subsystem, cross-cutting, or prior-decision questions—especially without an exact symbol—make ${names.execution} for memory.brain.recall with the full user question your first runtime action. Its operation and input shape are stable, so do not rediscover them first. Never infer or merely assert that Brain is unavailable: only use a fallback after that exact call returns a tool-level unavailable or unknown-tool rejection. A successful recall is synchronous and complete, not a background job. When it returns selected memories and linked paths, answer immediately and cite those paths without opening files merely to add line numbers. Inspect only returned targets when recall explicitly marks evidence missing, incomplete, contradictory, or in need of current-code verification; do not run repository-wide searches, inventories, or history sweeps. Remember, unlike recall, continues durably in the background after acceptance. Use direct repository tools for an exact known file or symbol and simple local edits. Let hooks queue ambient observe/reflect without running a model on the hook critical path.`,
    '- In editable TypeScript, launch independent deterministic work, Brain calls, agents, artifacts, and capability operations concurrently. Await only at dependency boundaries, cancel branches that become irrelevant, and preserve every scope, permission, bound, idempotency key, and receipt. Do not hide serial work inside a workflow DSL.',
    '- Keep side effects behind the broker and surface scopes, permissions, approvals, receipts, diagnostics, provenance, and fallbacks.',
    '- Use custom React UI when people benefit from inspecting, comparing, editing, confirming, or navigating structured results. Prefer Marshal over a harness-native visualization for custom, persistent, reusable, editable, runtime-backed, or portable UI; use native visualization for disposable charts and diagrams.',
    '- Treat application semantics as backend contracts. A control that claims to generate, refine, apply, implement, invoke a model/agent/tool, persist, or change authoritative source/data must call a manifest-declared action or tool backed by an editable module or capability and surface its real result and receipt. Local React state is only for presentation state; never simulate completion. If the backend is unavailable, disable the control and explain the limitation.',
    `- Compiled React fast path: write TSX once, compile once, create one render, then display it through ${names.renderComponent}. Re-show a cached render by its render ID only.`,
    '- A lifecycle session belongs to the host task/thread, not one assistant turn. Native host hooks own lifecycle session start, bounded ambient observation enqueueing, capability briefing, and session end. They do not perform semantic recall. Never call lifecycle tools yourself when those hooks are installed.',
  ].join('\n');
}

/**
 * Compact, host-neutral prompt-time guidance. This never performs an effect or
 * chooses memory content; it only makes a manifest routing match visible to the
 * working model so the model can invoke the normal brokered capability.
 */
export function projectPromptRoutingHint(
  prompt: string,
  entryPoints: MarshalProjectionEntryPoints = {},
): string | undefined {
  if (typeof prompt !== 'string' || !prompt.trim()) return undefined;
  const names = normalizeEntryPoints(entryPoints);
  if (isRuntimeExtensionsManagerPrompt(prompt)) {
    return [
      '## Marshal prompt routing hint',
      '',
      `- This prompt requests the control-plane extensions manager. Call ${names.extensionManager}({}) immediately. Do not invoke Brain, ${names.discovery}, ${names.execution}, repository tools, GitNexus, or inspect files first. Do not narrate a plan; open the manager.`,
    ].join('\n');
  }
  const decision = classifyMarshalPrompt(prompt);
  if (decision.route !== 'marshal') return undefined;
  const guidance: string[] = [];

  if (decision.intents.includes('memory')) {
    guidance.push(
      `This prompt matches durable-memory intent. The lifecycle hook only queued observation; it did not semantically remember or recall anything. If the user stated a stable preference, standing constraint, identity fact, durable decision, or explicit remember request, use ${names.discovery} to resolve memory.brain.remember and invoke it through ${names.execution} before the final response; return after durable job acceptance while completion continues in the background. If the answer depends on prior-task evidence, call ${names.execution} directly for memory.brain.recall with input {"content":"<the user question>"}; do not rediscover this stable operation first unless that direct call is rejected. Successful recall is synchronous and complete: answer from returned memory and inspect only returned linked targets when citations require it. Do not run broad repository or history searches unless recall evidence is missing or contradictory. The specialized Brain owns search, hierarchy, scope, ranking, dedupe, correction, and provenance.`,
    );
  }
  if (decision.intents.includes('typescript')) {
    guidance.push(
      `This prompt matches editable execution intent. Prefer an editable workspace-backed TypeScript module through ${names.execution} when the logic should be inspected, changed, or rerun.`,
    );
  }
  if (decision.intents.includes('ui')) {
    guidance.push(
      `This prompt matches durable custom-application intent. Use Marshal React rather than a generic visualization, preserve editable TSX and authoritative runtime-backed state, compile/render once, and display through ${names.renderComponent}. Before rendering, inventory every visible control. Any control that claims to generate, refine the selected item, apply a design system, implement or update source, invoke a model/agent/tool, persist, or change authoritative data must be declared in application.actions or application.tools and call marshal.callAction or marshal.callTool with the actual selected item and current context. Apply only the returned authoritative output and surface its receipt. Local state may manage tabs, selection, zoom, and responsive preview; it must not fake semantic success. Empty action and tool declarations are incomplete when substantive controls exist. If a backend capability is unavailable, disable the control and explain that limitation honestly.`,
    );
  }
  if (decision.intents.includes('composition')) {
    guidance.push(
      `This prompt matches capability-composition intent. For independent workstreams, author an editable TypeScript module, start independent operations concurrently, retain returned delegation IDs, cancel only work that is explicitly no longer needed, and synthesize results. ${DELEGATION_IDENTITY_GUIDANCE}`,
    );
  }

  return ['## Marshal prompt routing hint', '', ...guidance.map((line) => `- ${line}`)].join('\n');
}

export function projectSkillMarkdown(
  entryPoints: MarshalProjectionEntryPoints = {},
): string {
  const names = normalizeEntryPoints(entryPoints, false);
  const examples = MARSHAL_CAPABILITY_MANIFEST.examples
    .map((example) => `- [${example.kind}; ${example.expectedRoute}] ${example.prompt}`)
    .join('\n');
  return `---
name: use-marshal-runtime
description: Use Marshal for natural-language repository intelligence, architecture, rationale, related implementation, blast radius, unfamiliar cross-cutting code questions, prior-task recall, durable memory, editable TypeScript, capability composition, scoped artifacts, subagents, or custom persistent React UI.
---

# Use Marshal Runtime

${MARSHAL_CAPABILITY_MANIFEST.selectionPreamble}

- When the user asks to open, show, or launch the Marshal Runtime Extensions manager, call ${names.extensionManager}({}) immediately. Do not invoke Brain, ${names.discovery}, ${names.execution}, repository tools, GitNexus, or inspect files first. Do not narrate a plan; open the manager.
- Call ${names.discovery} when you need to discover or compose runtime capabilities or catalog entries. ${DISCOVERY_RESULT_GUIDANCE} For broad search, omit detail or pass detail:"summary"; use detail:"full" only when every matching capability schema is necessary. Do not search before a pure TypeScript module that makes no runtime calls.
- Call ${names.execution} for one discovered operation or an editable TypeScript module. Prefer workspace or artifact source when it should be edited, rerun, or reused; inline source is disposable.
- Exact call shapes:
  - Operation: ${names.execution}({"targetType":"operation","target":"capability.name","input":{...}})
  - Disposable TypeScript: ${names.execution}({"targetType":"inline_module","source":"export default async (input) => input","input":{...}})
  - Editable file: ${names.execution}({"targetType":"module","module":{"kind":"workspace_file","path":"relative/file.ts"},"input":{...},"timeoutMs":60000})
- For a module that waits on nested capability calls, explicitly set the outer \`timeoutMs\` above the longest nested wait plus execution overhead and no higher than the maximum advertised by ${names.execution}. An inner wait timeout does not extend the outer module budget.
- Inside brokered modules use context.runtime.search and context.runtime.invoke. The broker does not expose harness-side runtime.agents or runtime.schema helpers; examples using those surfaces are not executable inside ${names.execution} modules. For native agents, discover and invoke runtime.delegation.*, retain exact returned delegation IDs, and wait instead of launching replacements.
- ${DELEGATION_IDENTITY_GUIDANCE}
- ${DELEGATION_LIFECYCLE_GUIDANCE}
- Use the specialized Memory Brain as the repository-intelligence and memory assistant. For natural-language architecture, mechanism, tradeoff, rationale, related-implementation, blast-radius, unfamiliar-subsystem, cross-cutting, or prior-decision questions—especially without an exact symbol—make ${names.execution} for memory.brain.recall with the full user question your first runtime action. This operation and input shape are stable, so do not call ${names.discovery} first. Never infer or merely assert that Brain is unavailable: only use a fallback after that exact call returns a tool-level unavailable or unknown-tool rejection. Successful recall is synchronous and complete. When it returns selected memories and linked paths, answer immediately and cite those paths without opening files merely to add line numbers. Inspect only returned targets when recall explicitly marks evidence missing, incomplete, contradictory, or in need of current-code verification; do not run repository-wide searches, inventories, or history sweeps. Remember, unlike recall, continues durably in the background after acceptance. Use direct repository tools for an exact known file or symbol and simple local edits. Hooks only enqueue ambient observe/reflect and never run the Brain model on their critical path. The Brain owns hierarchy, ranking, dedupe, placement, correction, and provenance.
- In editable TypeScript, start independent deterministic work, Brain calls, agents, artifacts, and capability operations concurrently. Await only at dependency boundaries, cancel irrelevant branches, and preserve scopes, permissions, bounds, idempotency keys, and receipts. Do not introduce a workflow DSL.
- Native lifecycle hooks own session start, bounded ambient observation enqueueing, capability briefing, and session end. They do not perform semantic recall. Never call runtime_session_start, runtime_observe_turn, or runtime_session_end yourself when those hooks are installed.
- For custom, persistent, reusable, editable, or runtime-backed UI use Marshal alone. Write TSX, compile once, create one render, then call ${names.renderComponent}. Redisplay a cached render ID without searching, rewriting, recompiling, rerendering, or substituting another UI system.
- Keep complete structured fallbacks and report unsupported host features honestly.

## Complex application fast path

- For a substantial application, preserve separate editable frontend TSX and backend TypeScript. Local view preferences may stay local; user-authored project/workspace data, runtime effects, authoritative persistence, tools, attachments, jobs, or delegation must use declared application actions backed by capabilities or editable modules.
- Before rendering, make an operation map for every visible control. Tabs, selection, zoom, and responsive preview may remain local. Generate, refine, apply, implement, model/agent/tool invocation, persistence, and authoritative source/data changes must appear in \`application.actions\` or \`application.tools\` and call \`marshal.callAction\` or \`marshal.callTool\`. Pass the actual selected item and current context, apply only returned output, and surface receipts and failures. A source editor's Apply operation must update authoritative editable source and return its new version or digest; read-only code and local text mutation are not implementation. Never substitute prebuilt-card toggles, keyword matchers, or other local simulations for promised backend work. If no permitted backend is available, render the control disabled with an honest explanation.
- A request for three or more meaningfully different directions, parallel critiques, or independent verification requires delegation unless discovery proves the host cannot provide it. Before writing the final TSX, discover delegation, author and run an editable module, retain each returned delegation ID, wait for every useful result, and synthesize the evidence. Preserve an honest fallback when unavailable. Do not introduce a workflow DSL.
- Compile TSX once with ui.compile. Create one ui.render from its advertised schema with complete props/fallback and the exact application manifest: version 1.0.0, inline/fullscreen/PiP for a substantial workspace, actions and tools arrays, scoped state, and authoring-profile id/version. A persistent workspace must declare separate runtime-backed save and reopen/load actions and bind their current stateful handlers with marshal.bindActionControl; localStorage is only a fast local preference cache. Display the returned render ID once with ${names.renderComponent}.
- Before authoring runtime-backed React, read [the React authoring contract](references/react-authoring.md). Use its injected marshal prop and exact call shapes for declared actions, action-control bindings, declared tools, and requestDisplayMode. The portable renderer derives visible named controls for every declared non-inline mode outside authored CSS, feature-detects availability, surfaces typed outcomes, and preserves the inline fallback. Authored controls may add context but cannot replace that guaranteed chrome. Do not declare fullscreen or PiP without an operable control and a complete inline path. Subscribe to host-context changes and keep the complete inline workflow usable after unsupported, denied, or fallback results.

## Routing examples

${examples}
`;
}

/** Portable, harness-neutral reference packaged beside generated runtime skills. */
export function projectReactAuthoringReferenceMarkdown(): string {
  return `# Marshal React authoring contract

Contract version: **1.0.0**

## Injected client

When \`ui.render\` includes an application manifest, Marshal waits for the MCP
Apps handshake and passes a connected \`marshal\` client to the component's
default export. Import its public type only; do not implement raw
\`postMessage\` RPC and do not depend on a host-specific global.

\`\`\`tsx
import { useEffect, useState } from 'react';
import type { MarshalUiComponentProps, UiDisplayMode } from '@marshal/agent-runtime-ui';

type AppProps = MarshalUiComponentProps<{
  title?: string;
}>;

export default function App({ marshal, title = 'Workspace' }: AppProps) {
  const [mode, setMode] = useState<UiDisplayMode>(marshal.host.displayMode);
  const [modeStatus, setModeStatus] = useState('Ready inline.');
  const declaredModes = ['fullscreen', 'pip'] as const;

  useEffect(() => marshal.subscribe((event) => {
    if (event.type === 'host-context-changed') setMode(event.context.displayMode);
  }), [marshal]);

  async function requestMode(requested: 'fullscreen' | 'pip') {
    if (!marshal.host.context.availableDisplayModes.includes(requested)) {
      setModeStatus(requested + ' is unavailable; kept ' + mode + '.');
      return;
    }
    const result = await marshal.requestDisplayMode(requested);
    setMode(result.actual);
    setModeStatus(result.status === 'granted'
      ? 'Opened ' + result.actual + '.'
      : result.status + ': ' + (result.reason ?? 'kept ' + result.actual));
  }

  return <main>
    <h1>{title}</h1>
    <p role="status" aria-live="polite">{modeStatus}</p>
    {declaredModes.map((requested) => {
      const available = marshal.host.context.availableDisplayModes.includes(requested);
      return <button
        key={requested}
        type="button"
        onClick={() => requestMode(requested)}
        disabled={!available}
        title={available ? 'Open ' + requested : requested + ' is not supported by this host'}
      >{requested === 'pip' ? 'Picture in picture' : 'Fullscreen'}: {mode}</button>;
    })}
  </main>;
}
\`\`\`

The portable call is \`marshal.requestDisplayMode('fullscreen')\`. Marshal sends
the standard \`ui/request-display-mode\` request internally. A host may deny it,
return another mode, or omit the mode entirely, so handle \`granted\`,
\`fallback\`, \`unsupported\`, \`denied\`, and \`timed_out\` and preserve the inline path.
Request fullscreen or PiP only for a relevant workflow or user action. If the
application manifest declares either mode, keep a visible, named control for it
in the interface. Feature detection may disable the control and explain why; it
must not silently remove the declared route. Subscribe to host-context changes,
display the typed result, and keep every primary operation usable inline.

## Declared actions

An action ID used by the component must match an entry in the immutable
\`application.actions\` array passed to \`ui.render\`. Marshal validates the
input and output schemas and preserves scope, permissions, approval,
cancellation, idempotency, provenance, and receipts.

\`\`\`tsx
async function saveWorkspace(signal?: AbortSignal) {
  const result = await marshal.callAction<
    { name: string },
    { saved: boolean }
  >('save-workspace', { name }, {
    scope: 'project',
    idempotencyKey: 'save-workspace-v1',
    signal,
  });
  if (result.status === 'success') {
    console.log(result.output?.saved, result.receipt.receiptId);
  } else {
    console.error(result.status, result.error?.message);
  }
  return result;
}

async function reopenWorkspace(signal?: AbortSignal) {
  const reopened = await marshal.callAction<
    Record<string, never>,
    { found: boolean; name?: string }
  >('load-workspace', {}, { scope: 'project', signal });
  if (reopened.status === 'success' && reopened.output?.found) {
    console.log('Restored', reopened.output.name, reopened.receipt.receiptId);
  } else {
    console.error(reopened.status, reopened.error?.message ?? 'No saved workspace');
  }
  return reopened;
}

// Bind the renderer's manifest-derived controls to the same stateful handlers.
// The outer controls stay named and visible even if authored responsive CSS
// hides a toolbar, and each click still invokes exactly one owned handler.
useEffect(() => {
  const unbindSave = marshal.bindActionControl(
    'save-workspace',
    ({ signal }) => saveWorkspace(signal),
  );
  const unbindLoad = marshal.bindActionControl(
    'load-workspace',
    ({ signal }) => reopenWorkspace(signal),
  );
  return () => { unbindSave(); unbindLoad(); };
}, [marshal, saveWorkspace, reopenWorkspace]);
\`\`\`

Supply an idempotency key when the declaration says \`required\`. The requested
scope must appear in that action's \`allowedScopes\`. Treat action results as
typed outcomes; do not assume every click succeeds. A persistent app must bind
distinct Save and Reopen/Load handlers with \`marshal.bindActionControl\`. The
manifest-driven outer renderer keeps those named controls visible at narrow
widths, disables them until bound, prevents duplicate concurrent dispatch, and
shows typed pending/success/error status without guessing application state.
Always pass the binding's \`AbortSignal\` through to \`marshal.callAction\` so
outer Cancel and bounded timeout stop the actual backend request.

Declared app-visible tools use their manifest ID, not arbitrary tool names:

\`\`\`tsx
const refreshed = await marshal.callTool('refresh-data', { cursor });
\`\`\`

Only IDs declared in \`application.actions\` or \`application.tools\` are
callable from the authored app. Keep a complete structured/text fallback for
hosts that cannot render the interface.

## Semantic operation contract

Local component state is appropriate for presentation-only interactions such
as tabs, selection, zoom, disclosure, and responsive preview. It is not an
implementation of an operation that promises new or authoritative work.

Every control that claims to generate, refine, apply, implement, invoke a
model, agent, capability, or tool, persist data, or change authoritative source
must call a manifest-declared action or tool. Give that declaration bounded
input and output schemas and pass the real working context. For example:

- generation receives the current brief and constraints and returns generated
  results with provenance and a receipt;
- targeted refinement receives a stable selected-item ID, its current content,
  and the instruction, then returns an applicable patch or new version;
- source Apply receives the base digest and edited source, writes through an
  editable module or capability, and returns the new digest plus diagnostics.

Update the interface only from the typed action/tool result. A prebuilt-card
toggle, keyword matcher, local fixture swap, read-only implementation panel, or
success message without a backend result does not satisfy the declared
operation. When the required capability or permission is unavailable, keep the
control disabled or return a typed unavailable result with an honest
explanation; never simulate successful work locally.
`;
}

export function projectToolMetadata(name: string): ManifestToolProjection | undefined {
  const projection = MARSHAL_CAPABILITY_MANIFEST.tools[
    name as keyof typeof MARSHAL_CAPABILITY_MANIFEST.tools
  ];
  return projection ? { ...projection, evalLabels: [...projection.evalLabels] } : undefined;
}

export function projectNativeCallbackHints(): readonly ManifestCallbackHint[] {
  return MARSHAL_CAPABILITY_MANIFEST.callbacks.map((callback) => ({ ...callback }));
}

export function projectRoutingExamples(): readonly ManifestRoutingExample[] {
  return MARSHAL_CAPABILITY_MANIFEST.examples.map((example) => ({
    ...example,
    expectedIntents: [...example.expectedIntents],
    labels: [...example.labels],
  }));
}

export function projectEvalLabels(): readonly string[] {
  return [...new Set([
    ...MARSHAL_CAPABILITY_MANIFEST.routes.map((route) => route.evalLabel),
    ...MARSHAL_CAPABILITY_MANIFEST.negativeRouting.evalLabels,
    ...MARSHAL_CAPABILITY_MANIFEST.examples.flatMap((example) => example.labels),
    ...Object.values(MARSHAL_CAPABILITY_MANIFEST.tools).flatMap((tool) => tool.evalLabels),
  ])].sort();
}

function normalizeEntryPoints(
  entryPoints: MarshalProjectionEntryPoints,
  code = true,
): Required<MarshalProjectionEntryPoints> {
  return {
    discovery: entryPoint(entryPoints.discovery, 'the runtime capability search entry point', code),
    execution: entryPoint(entryPoints.execution, 'the runtime execution entry point', code),
    renderComponent: entryPoint(entryPoints.renderComponent, 'the host React render entry point', code),
    extensionManager: entryPoint(entryPoints.extensionManager, 'the host runtime extension manager entry point', code),
  };
}

function isRuntimeExtensionsManagerPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\b(?:open|show|launch|display)\b/.test(normalized)
    && /\bextensions?\b/.test(normalized)
    && /\bmanager\b/.test(normalized)
    && /\bmarshal\b|\bruntime\b/.test(normalized);
}

function entryPoint(value: string | undefined, fallback: string, code: boolean): string {
  const normalized = value?.trim() || fallback;
  if (normalized.length > 128) throw new Error('entry point names must be at most 128 characters.');
  return code && value?.trim() ? `\`${normalized}\`` : normalized;
}
