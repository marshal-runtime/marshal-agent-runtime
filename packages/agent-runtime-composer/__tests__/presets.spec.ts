import { describe, expect, it } from 'vitest';
import {
  applyRuntimeCompositionPreset,
  createRuntimePresetBind,
  createRuntimePresetBindMany,
  createRuntimePresetDecorator,
  createRuntimePresetReplace,
  createRuntimeServiceContainer,
  createRuntimeServiceToken,
  resolveRuntimeCompositionPreset,
} from '../src/index.js';

describe('runtime composition presets', () => {
  it('merges inheritance, environment, and explicit overrides in precedence order', () => {
    const token = createRuntimeServiceToken<string>('@test/presets:value');
    const base = createRuntimePresetBind('base-binding', token, { useValue: 'base' });
    const resolved = resolveRuntimeCompositionPreset(
      {
        base: {
          id: 'base',
          configuration: { nested: { value: 'base' }, list: [1] },
          services: [base],
          environment: [{ variable: 'VALUE', path: 'nested.value', parser: 'string' }],
        },
        selected: {
          id: 'selected',
          extends: ['base'],
          configuration: { nested: { other: true }, list: [2] },
          services: [],
        },
      },
      {
        presets: ['selected'],
        environment: { VALUE: 'environment' },
        overrides: { nested: { value: 'override' } },
      },
    );
    expect(resolved.configuration).toEqual({
      nested: { value: 'override', other: true },
      list: [2],
    });
    expect(resolved.services).toHaveLength(1);
  });

  it('rejects replacement without a resolved primary', () => {
    const token = createRuntimeServiceToken<string>('@test/presets:missing');
    expect(() =>
      resolveRuntimeCompositionPreset({
        p: {
          id: 'p',
          services: [createRuntimePresetReplace('replacement', token, { useValue: 'x' })],
        },
      }, { presets: ['p'] }),
    ).toThrow(/unresolved primary/);
  });

  it('applies all environment mappings after selected preset configuration', () => {
    const resolved = resolveRuntimeCompositionPreset(
      {
        base: {
          id: 'base',
          configuration: { nested: { value: 'base' } },
          environment: [
            {
              variable: 'VALUE',
              path: 'nested.value',
              parser: 'string',
            },
          ],
        },
        selected: {
          id: 'selected',
          extends: ['base'],
          configuration: { nested: { value: 'selected' } },
        },
      },
      {
        presets: ['selected'],
        environment: { VALUE: 'environment' },
      },
    );

    expect(resolved.configuration).toEqual({
      nested: { value: 'environment' },
    });
  });

  it('accepts declarative service entries without helper provenance', () => {
    const token = createRuntimeServiceToken<string>('@test/presets:declarative');
    const resolved = resolveRuntimeCompositionPreset(
      {
        declarative: {
          id: 'declarative',
          services: [
            {
              id: 'plain-binding',
              kind: 'bind',
              token,
              binding: { useValue: 'plain' },
            },
          ],
        },
      },
      { presets: ['declarative'] },
    );

    expect(resolved.services).toHaveLength(1);
    expect(resolved.services[0]?.kind).toBe('bind');
  });

  it('applies entries in order and disposes the aggregate in reverse', async () => {
    const token = createRuntimeServiceToken<string>('@test/presets:applied');
    const resolved = resolveRuntimeCompositionPreset(
      {
        applied: {
          id: 'applied',
          services: [
            createRuntimePresetBind(
              'binding',
              token,
              { useValue: 'value' },
            ),
            createRuntimePresetDecorator(
              'decorator',
              token,
              (value) => `[${value}]`,
            ),
          ],
        },
      },
      { presets: ['applied'] },
    );
    const container = createRuntimeServiceContainer();

    const handle = await applyRuntimeCompositionPreset(container, resolved);
    expect(container.get(token)).toBe('[value]');
    await handle.dispose();
    expect(container.tryGet(token)).toBeUndefined();
  });

  it('rejects cyclic or non-JSON configuration objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      resolveRuntimeCompositionPreset(
        {
          cyclic: {
            id: 'cyclic',
            configuration: cyclic as never,
          },
        },
        { presets: ['cyclic'] },
      ),
    ).toThrow(/acyclic/i);
    expect(() =>
      resolveRuntimeCompositionPreset(
        {
          dated: {
            id: 'dated',
            configuration: { value: new Date() } as never,
          },
        },
        { presets: ['dated'] },
      ),
    ).toThrow(/plain JSON objects/i);
  });

  it('rejects sparse configuration arrays before cloning', () => {
    const sparse: unknown[] = [];
    sparse.length = 10;
    expect(() =>
      resolveRuntimeCompositionPreset({
        sparse: {
          id: 'sparse',
          configuration: { values: sparse as never },
        },
      }, { presets: ['sparse'] }),
    ).toThrow(/sparse holes/i);
  });

  it('resolves every inherited tier before selected presets in request order', () => {
    const token = createRuntimeServiceToken<string>('@test/presets:tiers');
    const entry = (id: string, value: string) => createRuntimePresetBind(id, token, { useValue: value });
    const resolved = resolveRuntimeCompositionPreset(
      {
        firstParent: { id: 'firstParent', services: [entry('first-parent', 'first-parent')] },
        secondParent: { id: 'secondParent', services: [entry('second-parent', 'second-parent')] },
        first: { id: 'first', extends: ['firstParent'], services: [entry('first', 'first')] },
        second: { id: 'second', extends: ['secondParent'], services: [entry('second', 'second')] },
      },
      { presets: ['first', 'second'] },
    );

    expect(resolved.services.map(({ id }) => id)).toEqual([
      'first-parent',
      'second-parent',
      'first',
      'second',
    ]);
  });

  it('handles repeated inherited parents without duplicate expansion', () => {
    const token = createRuntimeServiceToken<string>('@test/presets:repeated-parent');
    const entry = (id: string) => createRuntimePresetBind(id, token, { useValue: id });
    const resolved = resolveRuntimeCompositionPreset(
      {
        root: { id: 'root', extends: ['shared', 'shared'] },
        shared: { id: 'shared', extends: ['base', 'base'], services: [entry('shared')] },
        base: { id: 'base', services: [entry('base')] },
      },
      { presets: ['root'] },
    );
    expect(resolved.services.map(({ id }) => id)).toEqual(['base', 'shared']);
  });

  it('rejects unknown service operations instead of treating them as replacement', () => {
    expect(() =>
      resolveRuntimeCompositionPreset({
        invalid: {
          id: 'invalid',
          services: [{
            id: 'unknown-operation',
            operation: 'unknown' as never,
            token: createRuntimeServiceToken<string>('@test/presets:unknown-operation'),
            binding: { useValue: 'value' },
          }],
        },
      }, { presets: ['invalid'] }),
    ).toThrow(/invalid operation/);
  });

  it('propagates bindMany order to the container binding', async () => {
    const token = createRuntimeServiceToken<string>('@test/presets:ordered');
    const resolved = resolveRuntimeCompositionPreset(
      {
        ordered: {
          id: 'ordered',
          services: [
            createRuntimePresetBind('primary', token, { useValue: 'primary' }),
            createRuntimePresetBindMany('late', token, { useValue: 'late' }, 20),
            createRuntimePresetBindMany('early', token, { useValue: 'early' }, 1),
          ],
        },
      },
      { presets: ['ordered'] },
    );
    const container = createRuntimeServiceContainer();

    await applyRuntimeCompositionPreset(container, resolved);
    expect(container.getAll(token)).toEqual(['primary', 'early', 'late']);
  });
});
