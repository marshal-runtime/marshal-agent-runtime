import { describe, expect, it } from 'vitest';
import { validateRuntimeExtensionManifest } from '../src/index.js';

const base = {
  schemaVersion: 1,
  identity: '@fixture/installation',
  version: '1.0.0',
  entrypoint: 'dist/extension.cjs',
  moduleFormat: 'commonjs-bundle-v1',
} as const;

describe('Runtime extension installation manifest', () => {
  it('accepts an optional trusted package script contract', () => {
    expect(validateRuntimeExtensionManifest({
      ...base,
      installation: { script: 'marshal:install', packageManager: 'pnpm' },
    }).installation).toEqual({
      script: 'marshal:install',
      packageManager: 'pnpm',
    });
    expect(validateRuntimeExtensionManifest(base).installation).toBeUndefined();
  });

  it.each([
    { installation: {} },
    { installation: { script: '' } },
    { installation: { script: 'install with spaces' } },
    { installation: { script: 'build', packageManager: 'corepack' } },
    { installation: { script: 'build', command: 'anything' } },
  ])('rejects invalid installation metadata %#', (extra) => {
    expect(() => validateRuntimeExtensionManifest({ ...base, ...extra })).toThrow(
      /installation/i,
    );
  });
});
