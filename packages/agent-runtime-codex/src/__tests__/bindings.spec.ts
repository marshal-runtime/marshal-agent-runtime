import { describe, expect, it, vi } from 'vitest';
import { normalizeBindings } from '../bindings.js';

describe('runtime binding normalization', () => {
  it('accepts a narrow kernel directly', () => {
    const kernel = {
      search: vi.fn(async () => []),
      execute: vi.fn(async () => ({ ok: true })),
    };

    expect(normalizeBindings(kernel).kernel).toBe(kernel);
  });

  it('accepts kernel, lifecycle, and disposer bindings', () => {
    const bindings = {
      kernel: {
        search: vi.fn(async () => []),
        execute: vi.fn(async () => ({ ok: true })),
      },
      lifecycle: {
        startSession: vi.fn(async () => undefined),
        observeTurn: vi.fn(async () => undefined),
        endSession: vi.fn(async () => undefined),
      },
      resources: {
        listResources: vi.fn(async () => []),
        readResource: vi.fn(async (uri: string) => ({ uri, text: '' })),
        toolMetadata: vi.fn(() => ({ ui: { resourceUri: 'ui://marshal/runtime' } })),
      },
      dispose: vi.fn(),
    };

    expect(normalizeBindings(bindings)).toEqual(bindings);
  });

  it('rejects modules without the command kernel port', () => {
    expect(() => normalizeBindings({ lifecycle: {} })).toThrow(
      'kernel.search() and kernel.execute()',
    );
  });
});
