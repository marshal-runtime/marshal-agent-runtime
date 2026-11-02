import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('composer dependency direction', () => {
  it('depends only on core and the TypeScript compiler API and contains no state, provider, transport, or harness implementation', async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; bin?: Record<string, string> };
    expect(manifest.dependencies).toEqual({
      '@marshal/agent-runtime-core': 'workspace:*',
      typescript: '^5.3.2',
    });
    expect(manifest.bin).toBeUndefined();

    const files = (await fs.readdir(path.join(packageRoot, 'src'))).filter((file) =>
      file.endsWith('.ts'),
    );
    const source = (
      await Promise.all(files.map((file) => fs.readFile(path.join(packageRoot, 'src', file), 'utf8')))
    ).join('\n');
    const externalImports = [...source.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)]
      .map((match) => match[1]);
    expect([...new Set(externalImports)]).toEqual(['@marshal/agent-runtime-core', 'typescript']);
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/\b(?:memory|effects?|mcp|codex)\b/i);
  });
});
