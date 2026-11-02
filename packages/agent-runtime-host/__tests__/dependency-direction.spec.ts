import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('host dependency direction', () => {
  it('keeps the runtime host closure infrastructure-only', async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
      bin?: Record<string, string>;
    };
    const productionDependencies = Object.keys(manifest.dependencies ?? {});
    expect(productionDependencies).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/codex/i),
    ]));
    expect(manifest.bin).toBeUndefined();
    expect(Object.keys(manifest.exports ?? {})).not.toContain('./hooks');
    expect(Object.keys(manifest.exports ?? {})).not.toContain('./lifecycle-runtime');

    const files = (await fs.readdir(path.join(packageRoot, 'src'))).filter((file) =>
      file.endsWith('.ts'),
    );
    const source = (
      await Promise.all(files.map((file) => fs.readFile(path.join(packageRoot, 'src', file), 'utf8')))
    ).join('\n');
    expect(source).not.toMatch(/codex/i);
    expect(source).not.toMatch(/@marshal\/agent-runtime-(?:provider-memory|providers)/);

    const runtimeManifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, '..', 'runtime', 'package.json'), 'utf8'),
    ) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };
    expect(runtimeManifest.exports?.['./host']).toEqual({
      types: './dist/host.d.ts',
      default: './dist/host.js',
    });
    expect(runtimeManifest.exports?.['./host/lifecycle']).toEqual({
      types: './dist/host-lifecycle.d.ts',
      default: './dist/host-lifecycle.js',
    });

  });
});
