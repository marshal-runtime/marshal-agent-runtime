import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexRuntimeExtensionRoot,
  codexRuntimeExtensionRoots,
} from '../runtimePaths.js';

const originalInstalledRoot = process.env.MARSHAL_RUNTIME_EXTENSION_ROOT;
const originalDiscoveryRoots = process.env.MARSHAL_RUNTIME_EXTENSION_DISCOVERY_ROOTS;

afterEach(() => {
  restore('MARSHAL_RUNTIME_EXTENSION_ROOT', originalInstalledRoot);
  restore('MARSHAL_RUNTIME_EXTENSION_DISCOVERY_ROOTS', originalDiscoveryRoots);
});

describe('Codex runtime extension roots', () => {
  it('keeps the private install root and adds configured discovery roots', () => {
    const installed = path.resolve('/runtime-installed');
    const detected = path.resolve('/runtime-detected');
    process.env.MARSHAL_RUNTIME_EXTENSION_ROOT = installed;
    process.env.MARSHAL_RUNTIME_EXTENSION_DISCOVERY_ROOTS = [detected, installed].join(path.delimiter);

    expect(codexRuntimeExtensionRoot()).toBe(installed);
    expect(codexRuntimeExtensionRoots()).toEqual([installed, detected]);
  });

  it('rejects relative discovery roots', () => {
    process.env.MARSHAL_RUNTIME_EXTENSION_DISCOVERY_ROOTS = 'relative/extensions';
    expect(() => codexRuntimeExtensionRoots()).toThrow(
      'MARSHAL_RUNTIME_EXTENSION_DISCOVERY_ROOTS must contain only absolute paths.',
    );
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
