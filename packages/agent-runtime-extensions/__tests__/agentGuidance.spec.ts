import { describe, expect, it } from 'vitest';
import {
  buildExtensionPromptSections,
  renderExtensionPromptBlock,
  validateRuntimeExtensionManifest,
  type RuntimeExtensionLifecycleRecord,
} from '../src/index.js';

const base = {
  schemaVersion: 1,
  identity: '@fixture/guided',
  version: '1.0.0',
  entrypoint: 'dist/extension.cjs',
  moduleFormat: 'commonjs-bundle-v1',
} as const;

describe('Runtime extension agentGuidance manifest field', () => {
  it('accepts bounded guidance and preserves it verbatim, including multiline recipes', () => {
    const guidance = {
      purpose: 'Recursive engineering swarm over repo worktrees.',
      when: 'Multi-part repository work benefiting from parallel scoped workers.',
      recipe: 'swarm.runs.create {objective, scope}\n\tswarm.runs.get to observe\nswarm.runs.drive to progress',
      boundaries: 'Never for single small edits.',
    };
    expect(validateRuntimeExtensionManifest({ ...base, agentGuidance: guidance }).agentGuidance)
      .toEqual(guidance);
  });

  it('remains optional and absent manifests validate unchanged', () => {
    expect(validateRuntimeExtensionManifest(base).agentGuidance).toBeUndefined();
  });

  it('accepts partial guidance with at least one field', () => {
    expect(
      validateRuntimeExtensionManifest({ ...base, agentGuidance: { purpose: 'One-liner.' } })
        .agentGuidance,
    ).toEqual({ purpose: 'One-liner.' });
  });

  it.each([
    { name: 'non-object', agentGuidance: 'text' },
    { name: 'unknown key', agentGuidance: { purpose: 'x', extra: 'y' } },
    { name: 'empty object', agentGuidance: {} },
    { name: 'blank field', agentGuidance: { purpose: '   ' } },
    { name: 'non-string field', agentGuidance: { recipe: 42 } },
    { name: 'purpose over 300', agentGuidance: { purpose: 'p'.repeat(301) } },
    { name: 'when over 300', agentGuidance: { when: 'w'.repeat(301) } },
    { name: 'recipe over 700', agentGuidance: { recipe: 'r'.repeat(701) } },
    { name: 'boundaries over 300', agentGuidance: { boundaries: 'b'.repeat(301) } },
    { name: 'escape char', agentGuidance: { purpose: 'bad\u001Bcolor' } },
    { name: 'NUL char', agentGuidance: { purpose: 'bad\u0000null' } },
    { name: 'C1 control', agentGuidance: { purpose: 'bad\u0085char' } },
  ])('rejects $name', ({ agentGuidance }) => {
    expect(() => validateRuntimeExtensionManifest({ ...base, agentGuidance }))
      .toThrow(TypeError);
  });

  it('rejects guidance whose serialized total exceeds 1500 characters', () => {
    const agentGuidance = {
      purpose: 'p'.repeat(300),
      when: 'w'.repeat(300),
      recipe: 'r'.repeat(700),
      boundaries: 'b'.repeat(300),
    };
    expect(() => validateRuntimeExtensionManifest({ ...base, agentGuidance }))
      .toThrow(/1500 serialized characters/);
  });

  it('allows newline, carriage return, and tab whitespace', () => {
    const agentGuidance = { recipe: 'step one\r\n\tstep two\nstep three' };
    expect(validateRuntimeExtensionManifest({ ...base, agentGuidance }).agentGuidance)
      .toEqual(agentGuidance);
  });
});

function record(
  overrides: Partial<RuntimeExtensionLifecycleRecord> & Pick<RuntimeExtensionLifecycleRecord, 'identity'>,
): RuntimeExtensionLifecycleRecord {
  return {
    version: '1.0.0',
    integrity: { algorithm: 'sha256', domain: 'marshal-runtime-extension-package-v1', value: 'f'.repeat(64) },
    entrypoint: 'dist/extension.cjs',
    status: 'enabled',
    activationOrder: 0,
    configuration: {},
    request: {
      packageRoot: '/fixtures',
      integrity: { algorithm: 'sha256', domain: 'marshal-runtime-extension-package-v1', value: 'f'.repeat(64) },
    },
    health: 'healthy',
    blockReasons: [],
    dependencies: [],
    providedServices: [],
    requiredServices: [],
    providerSelections: [],
    configurationValues: {},
    providerOverrides: {},
    contractConflicts: [],
    capabilityProviderIds: [],
    ...overrides,
  } as RuntimeExtensionLifecycleRecord;
}

describe('buildExtensionPromptSections', () => {
  it('renders every healthy extension in deterministic identity order with no total cap', () => {
    const records = Array.from({ length: 40 }, (_, index) =>
      record({
        identity: `@fixture/pack-${String(index).padStart(2, '0')}`,
        agentGuidance: { purpose: `Purpose ${index}` },
      }));
    const shuffled = [...records].reverse();
    const sections = buildExtensionPromptSections(shuffled);
    expect(sections).toHaveLength(40);
    expect(sections.map((section) => section.identity)).toEqual(
      records.map((entry) => entry.identity),
    );
  });

  it('renders guidance fields, capabilities, and a details line pointing at discovery', () => {
    const [section] = buildExtensionPromptSections([
      record({
        identity: '@fixture/swarm',
        agentGuidance: {
          purpose: 'Recursive swarm runs.',
          when: 'Parallel repo work.',
          recipe: 'swarm.runs.create then swarm.runs.get',
          boundaries: 'Not for small edits.',
        },
        contributedCapabilityPrefixes: ['swarm.runs.'],
      }),
    ]);
    expect(section?.text).toContain('### @fixture/swarm v1.0.0');
    expect(section?.text).toContain('purpose: Recursive swarm runs.');
    expect(section?.text).toContain('when: Parallel repo work.');
    expect(section?.text).toContain('recipe: swarm.runs.create then swarm.runs.get');
    expect(section?.text).toContain('capabilities: swarm.runs.');
    expect(section?.text).toContain('boundaries: Not for small edits.');
    expect(section?.text).toContain('runtimeSearch {query: "swarm.runs."}');
    expect(section?.text).toContain('exact-name lookup on a returned capability');
    expect(section?.text).not.toContain('runtimeSearch {name:');
  });

  it('falls back to catalog description/title when guidance is absent', () => {
    const [section] = buildExtensionPromptSections([
      record({ identity: '@fixture/plain', description: 'Plain description.', title: 'Plain' }),
    ]);
    expect(section?.text).toContain('purpose: Plain description.');
  });

  it('represents blocked extensions as unavailable, never as usable', () => {
    const [section] = buildExtensionPromptSections([
      record({
        identity: '@fixture/broken',
        health: 'blocked',
        blockReasons: [{ code: 'dependency-missing', message: 'requires @fixture/base' }],
        agentGuidance: { purpose: 'Should not render as usable.', recipe: 'must.not.render' },
      }),
    ]);
    expect(section?.health).toBe('blocked');
    expect(section?.text).toBe(
      '### @fixture/broken v1.0.0 — unavailable: requires @fixture/base',
    );
    expect(section?.text).not.toContain('must.not.render');
  });

  it('omits disabled extensions entirely', () => {
    expect(
      buildExtensionPromptSections([
        record({ identity: '@fixture/off', health: 'disabled', status: 'disabled' }),
      ]),
    ).toEqual([]);
  });

  it('renders an empty block for no sections and a headed block otherwise', () => {
    expect(renderExtensionPromptBlock([])).toBe('');
    const sections = buildExtensionPromptSections([
      record({ identity: '@fixture/one', agentGuidance: { purpose: 'One.' } }),
    ]);
    const block = renderExtensionPromptBlock(sections);
    expect(block.startsWith('## Installed runtime extensions')).toBe(true);
    expect(block).toContain('### @fixture/one v1.0.0');
  });
});
