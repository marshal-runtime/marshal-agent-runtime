import { describe, expect, it } from 'vitest';
import { createRuntimeSessionBriefing } from '../src/sessionBriefing.js';

describe('portable runtime session briefing', () => {
  it('describes the capability plane without depending on a harness', () => {
    const briefing = createRuntimeSessionBriefing();

    expect(briefing).toContain('Marshal Runtime capability briefing');
    expect(briefing).toContain('persistent memory');
    expect(briefing).toContain('runtime capability search entry point');
    expect(briefing).toContain('editable workspace-backed TypeScript module');
    expect(briefing).toContain('custom React UI');
    expect(briefing).toContain('Prefer Marshal over a harness-native visualization');
    expect(briefing).toContain('disposable charts and diagrams');
    expect(briefing).toContain('compile once');
    expect(briefing).toContain('Re-show a cached render by its render ID only');
    expect(briefing).toContain('task/thread, not one assistant turn');
    expect(briefing).not.toContain('Codex');
  });

  it('adapts only the harness-visible entry-point names', () => {
    const briefing = createRuntimeSessionBriefing({
      discoveryEntryPoint: 'runtime_search',
      executionEntryPoint: 'runtime_exec',
    });

    expect(briefing).toContain('start with a broad `runtime_search` call');
    expect(briefing).toContain('Use `runtime_exec`');
  });

  it('accepts a bounded extension-neutral additional briefing', () => {
    expect(createRuntimeSessionBriefing({ additionalBriefing: 'Extension context.' }))
      .toContain('Extension context.');
    expect(() =>
      createRuntimeSessionBriefing({ additionalBriefing: 'x'.repeat(1_025) }),
    ).toThrow('additionalBriefing must be at most 1024 characters.');
  });

  it('rejects unbounded adapter entry-point names', () => {
    expect(() =>
      createRuntimeSessionBriefing({ discoveryEntryPoint: 'x'.repeat(129) }),
    ).toThrow('discoveryEntryPoint must be at most 128 characters.');
  });
});
