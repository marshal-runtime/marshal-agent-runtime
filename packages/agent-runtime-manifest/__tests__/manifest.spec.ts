import { describe, expect, it } from 'vitest';
import {
  MARSHAL_CAPABILITY_MANIFEST,
  MARSHAL_SELECTION_PREAMBLE,
  classifyMarshalPrompt,
  projectEvalLabels,
  projectLifecycleBriefing,
  projectMcpServerInstructions,
  projectNativeCallbackHints,
  projectPromptRoutingHint,
  projectReactAuthoringReferenceMarkdown,
  projectRoutingExamples,
  projectSkillMarkdown,
  projectToolMetadata,
} from '../src/index.js';

describe('Marshal capability manifest projections', () => {
  it('keeps critical natural-routing guidance at the beginning of MCP instructions', () => {
    const instructions = projectMcpServerInstructions({
      discovery: 'runtime_search',
      execution: 'runtime_exec',
      renderComponent: 'runtime_render_component',
      extensionManager: 'runtime_extensions_manage',
    });

    expect(MARSHAL_SELECTION_PREAMBLE.length).toBeLessThanOrEqual(512);
    expect(instructions.startsWith(MARSHAL_SELECTION_PREAMBLE)).toBe(true);
    expect(instructions.slice(0, 512)).toContain('stable preferences');
    expect(instructions.slice(0, 512)).toContain('even without “remember”');
    expect(instructions.slice(0, 512)).toContain('start independent code, Brain, agents, artifacts concurrently');
    expect(instructions.slice(0, 512)).not.toContain('already handled by lifecycle hooks');
    expect(instructions).toContain('runtime_extensions_manage`({}) immediately');
    expect(instructions).toContain('Do not call Brain');
  });

  it('projects the same guidance into tools, skills, lifecycle, callbacks, and eval labels', () => {
    const instructions = projectMcpServerInstructions();
    expect(projectToolMetadata('runtime_exec')?.description).toContain('bounded processing');
    expect(projectToolMetadata('runtime_exec')?.description).toContain(
      'nested timeouts never extend the outer budget',
    );
    const searchDescription = projectToolMetadata('runtime_search')?.description;
    expect(searchDescription).toContain('Skip discovery for pure TypeScript');
    expect(searchDescription).toContain('detail:"summary"');
    expect(searchDescription).toContain('matches remain capability results');
    expect(searchDescription).toContain('discoveries may contain skill, resource, host_tool, or ui_application');
    expect(searchDescription).toContain('exact catalogId');
    expect(searchDescription).toContain('resource_read, host_tool, and ui_render');
    const skill = projectSkillMarkdown({
      discovery: 'runtime_search',
      execution: 'runtime_exec',
      renderComponent: 'runtime_render_component',
      extensionManager: 'runtime_extensions_manage',
    });
    const briefing = projectLifecycleBriefing();
    expect(skill).toContain('custom, persistent, reusable, editable, or runtime-backed UI');
    expect(skill).toContain('runtime_extensions_manage({}) immediately');
    expect(skill).toContain('Do not invoke Brain');
    expect(skill).toContain('stable preferences');
    expect(skill).toContain('Do not search before a pure TypeScript module');
    expect(skill).toContain('pass detail:"summary"');
    expect(skill).toContain('`matches`');
    expect(skill).toContain('`discoveries`');
    expect(skill).toContain('exact `catalogId`');
    expect(skill).toContain('`resource_read`, `host_tool`, and `ui_render`');
    expect(skill).toContain('Complex application fast path');
    expect(skill).toContain('retain exact returned delegation IDs');
    expect(skill).toContain('does not expose harness-side runtime.agents or runtime.schema helpers');
    expect(skill).toContain('Retain the delegationId returned by spawn');
    expect(skill).toContain('wait instead of launching replacements');
    expect(skill).toContain('runtime.delegation.wait has no timeout');
    expect(skill).toContain('Cancellation is explicit and records a failed terminal result');
    expect(skill).toContain('parentDelegationId records hierarchy only');
    expect(skill).toContain('renderer derives visible named controls');
    expect(skill).toContain('separate runtime-backed save and reopen/load actions');
    expect(skill).toContain('bind their current stateful handlers with marshal.bindActionControl');
    expect(skill).toContain('make an operation map for every visible control');
    expect(skill).toContain('actual selected item and current context');
    expect(skill).toContain("A source editor's Apply operation must update authoritative editable source");
    expect(skill).toContain('Never substitute prebuilt-card toggles, keyword matchers');
    expect(skill).toContain('render the control disabled with an honest explanation');
    expect(skill).toContain('Remind me tomorrow at 09:00');
    expect(skill).toContain('references/react-authoring.md');
    const reactAuthoring = projectReactAuthoringReferenceMarkdown();
    expect(reactAuthoring).toContain("marshal.requestDisplayMode('fullscreen')");
    expect(reactAuthoring).toContain("['fullscreen', 'pip'] as const");
    expect(reactAuthoring).toContain("requested === 'pip' ? 'Picture in picture' : 'Fullscreen'");
    expect(reactAuthoring).toContain('disabled={!available}');
    expect(reactAuthoring).toContain("marshal.host.context.availableDisplayModes.includes(requested)");
    expect(reactAuthoring).toContain("marshal.callAction<");
    expect(reactAuthoring).toContain("({ signal }) => saveWorkspace(signal)");
    expect(reactAuthoring).toContain("('load-workspace', {}, { scope: 'project', signal })");
    expect(reactAuthoring).toContain('`timed_out`');
    expect(reactAuthoring).toContain("marshal.callTool('refresh-data'");
    expect(reactAuthoring).toContain('## Semantic operation contract');
    expect(reactAuthoring).toContain('stable selected-item ID');
    expect(reactAuthoring).toContain('base digest and edited source');
    expect(reactAuthoring).toContain('success message without a backend result');
    expect(reactAuthoring).toContain('never simulate successful work locally');
    expect(reactAuthoring).toContain("import type { MarshalUiComponentProps, UiDisplayMode } from '@marshal/agent-runtime-ui'");
    expect(briefing).toContain('Use the specialized Memory Brain as the repository-intelligence and memory assistant');
    expect(briefing).toContain('launch independent deterministic work, Brain calls, agents, artifacts');
    expect(briefing).toContain('Brokered TypeScript exposes only scoped context.runtime.search/invoke');
    expect(briefing).toContain('additive `discoveries`');
    expect(briefing).toContain('exact `catalogId`');
    expect(briefing).not.toMatch(/capability[- ]only/i);
    expect(briefing).toContain('wait rather than launching replacements');
    expect(briefing).toContain('Retain the delegationId returned by spawn');
    expect(instructions).toContain('retain returned delegation IDs');
    expect(instructions).toContain('wait without replacement spawns');
    expect(instructions).toContain('additive `discoveries`');
    expect(instructions).toContain('exact `catalogId`');
    expect(instructions).not.toMatch(/capability[- ]only/i);
    expect(briefing).not.toContain('automatically store explicit');
    expect(briefing).toContain('They do not perform semantic recall');
    expect(briefing).not.toMatch(/hooks?[^.\n]*(?:memory injection|recall prior evidence)/i);
    expect(briefing).toContain('Prefer Marshal over a harness-native visualization');
    expect(briefing).toContain('using detail:"summary"');
    const callbackHints = projectNativeCallbackHints();
    expect(callbackHints.map((hint) => hint.phase)).toEqual(
      expect.arrayContaining(['session.start', 'prompt.submit', 'tool.invoke', 'subagent.start']),
    );
    expect(callbackHints.find((hint) => hint.phase === 'tool.invoke')).toMatchObject({
      blocking: true,
      injectsContext: false,
    });
    expect(callbackHints.find((hint) => hint.phase === 'prompt.submit')?.injectsContext).toBe(true);
    expect(callbackHints.map((hint) => hint.purpose).join('\n')).not.toMatch(
      /(?:recall prior evidence|memory injection)/i,
    );
    expect(projectEvalLabels()).toEqual(expect.arrayContaining([
      'marshal.intent.memory',
      'marshal.intent.typescript',
      'marshal.intent.ui',
      'marshal.intent.composition',
      'marshal.capability.scheduling',
      'marshal.route.direct',
    ]));
  });

  it('routes a direct extensions-manager request before repository intelligence', () => {
    const hint = projectPromptRoutingHint(
      'Show me the Marshal Runtime Extensions manager please',
      {
        discovery: 'runtime_search',
        execution: 'runtime_exec',
        extensionManager: 'runtime_extensions_manage',
      },
    );

    expect(hint).toContain('runtime_extensions_manage`({}) immediately');
    expect(hint).toContain('Do not invoke Brain');
    expect(hint).toContain('GitNexus');
    expect(hint).toContain('Do not narrate a plan');
  });

  it('projects prompt-time routing guidance without performing memory work', () => {
    const hint = projectPromptRoutingHint(
      'My standing preference is to call the final checklist the cobalt lantern and always inspect accessibility before performance.',
    );
    expect(hint).toContain('matches durable-memory intent');
    expect(hint).toContain('memory.brain.remember');
    expect(hint).toContain('return after durable job acceptance while completion continues in the background');
    expect(hint).toContain('lifecycle hook only queued observation');
    expect(projectPromptRoutingHint('What is 17% of 80?')).toBeUndefined();
  });

  it('routes natural delegation through returned transport identity', () => {
    const hint = projectPromptRoutingHint(
      'Delegate independent checks to parallel specialists, compare their results, and save the combined artifact.',
    );
    expect(hint).toContain('Retain the delegationId returned by spawn');
    expect(hint).toContain('parentDelegationId records hierarchy only');
  });

  it('requires substantive application controls to use real declared backends', () => {
    const prompt = 'Build me a complete interactive design workspace that turns a product brief into several genuinely different interface directions that I can select, refine, and keep editing.';
    const hint = projectPromptRoutingHint(prompt);
    const instructions = projectMcpServerInstructions();
    const briefing = projectLifecycleBriefing();
    const uiRoute = MARSHAL_CAPABILITY_MANIFEST.routes.find((route) => route.intent === 'ui');

    expect(uiRoute?.summary).toContain('declared runtime-backed actions or tools');
    expect(uiRoute?.useWhen.join('\n')).toContain('change authoritative source or data');
    expect(instructions).toContain('never local simulations');
    expect(briefing).toContain('Treat application semantics as backend contracts');
    expect(briefing).toContain('Local React state is only for presentation state');
    expect(hint).toContain('inventory every visible control');
    expect(hint).toContain('declared in application.actions or application.tools');
    expect(hint).toContain('marshal.callAction or marshal.callTool');
    expect(hint).toContain('actual selected item and current context');
    expect(hint).toContain('Empty action and tool declarations are incomplete');
    expect(hint).toContain('disable the control and explain that limitation honestly');
    expect(hint).toContain('matches capability-composition intent');
    expect(classifyMarshalPrompt(prompt).intents).toEqual(['ui', 'composition']);
  });

  it('classifies every direct, indirect, and negative golden prompt deterministically', () => {
    const examples = projectRoutingExamples();
    expect(new Set(examples.map((example) => example.kind))).toEqual(
      new Set(['direct', 'indirect', 'negative']),
    );
    expect(new Set(examples.flatMap((example) => example.expectedIntents))).toEqual(
      new Set(['memory', 'typescript', 'ui', 'composition']),
    );
    for (const example of examples) {
      expect(classifyMarshalPrompt(example.prompt, example.kind), example.id).toEqual({
        route: example.expectedRoute,
        intents: example.expectedIntents,
        labels: example.labels,
      });
    }
  });

  it('routes agent-discovered durable repository knowledge through Brain memory', () => {
    const memoryRoute = MARSHAL_CAPABILITY_MANIFEST.routes.find((route) => route.intent === 'memory');
    expect(memoryRoute?.useWhen.join('\n')).toContain('agent discovers a durable repository procedure');
    expect(classifyMarshalPrompt(
      'I discovered a repository constraint that will matter in future work.',
      'indirect',
    )).toEqual({
      route: 'marshal',
      intents: ['memory'],
      labels: ['marshal.intent.memory', 'marshal.routing.indirect'],
    });
  });

  it('routes implicit stable user preferences through Brain memory', () => {
    const prompt = 'My standing preference is to call the final checklist the cobalt lantern and always inspect accessibility before performance.';
    const memoryRoute = MARSHAL_CAPABILITY_MANIFEST.routes.find((route) => route.intent === 'memory');
    expect(memoryRoute?.useWhen.join('\n')).toContain('stable preference');
    expect(classifyMarshalPrompt(prompt, 'indirect')).toEqual({
      route: 'marshal',
      intents: ['memory'],
      labels: ['marshal.intent.memory', 'marshal.routing.indirect'],
    });
    expect(projectSkillMarkdown()).toContain(`[indirect; marshal] ${prompt}`);
  });

  it('keeps the portable manifest independent of any harness', () => {
    const serialized = JSON.stringify(MARSHAL_CAPABILITY_MANIFEST);
    expect(serialized).not.toMatch(/Codex|ChatGPT|Claude|Electron/);
  });
});
