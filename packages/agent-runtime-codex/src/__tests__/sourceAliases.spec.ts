import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  workspaceSourceAliasPlan,
  workspaceSourceAliases,
} from '../../../../scripts/vitest-source-aliases.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('Codex source alias integrity', () => {
  it('covers the complete internal production closure and public subpaths', () => {
    const plan = workspaceSourceAliasPlan('@marshal/agent-runtime-codex', {
      includeDevDependencies: true,
    });
    const bySpecifier = new Map(plan.map((entry) => [entry.specifier, entry.replacement]));
    const requiredSpecifiers = [
      '@marshal/agent-runtime-codex-capabilities',
      '@marshal/agent-runtime-host/lifecycle',
      '@marshal/agent-runtime-host/session-briefing',
      '@marshal/agent-runtime-host/state',
      '@marshal/agent-runtime-permissions',
      '@marshal/agent-runtime-provider-artifacts',
      '@marshal/agent-runtime-ui/declarative',
      '@marshal/runtime/host',
      '@marshal/runtime/host/lifecycle',
    ];

    for (const specifier of requiredSpecifiers) {
      expect(bySpecifier.get(specifier), specifier).toEqual(expect.any(String));
    }
    expect(bySpecifier.get('@marshal/runtime/host')).toBe(
      path.join(repositoryRoot, 'packages', 'runtime', 'src', 'host.ts'),
    );
    expect(plan.every(({ replacement }) =>
      existsSync(replacement)
      && !replacement.includes(`${path.sep}dist${path.sep}`))).toBe(true);
  });

  it('uses exact aliases with deeper public subpaths before package roots', () => {
    const plan = workspaceSourceAliasPlan('@marshal/agent-runtime-codex', {
      includeDevDependencies: true,
    });
    const aliases = workspaceSourceAliases('@marshal/agent-runtime-codex', {
      includeDevDependencies: true,
    });
    const runtimeHostIndex = plan.findIndex(({ specifier }) =>
      specifier === '@marshal/runtime/host');
    const runtimeRootIndex = plan.findIndex(({ specifier }) => specifier === '@marshal/runtime');
    const runtimeHostAlias = aliases.find(({ find }) => find.test('@marshal/runtime/host'));

    expect(runtimeHostIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeRootIndex).toBeGreaterThan(runtimeHostIndex);
    expect(runtimeHostAlias?.find.test('@marshal/runtime/host/lifecycle')).toBe(false);
    expect(runtimeHostAlias?.find.test('@marshal/runtime/host-extra')).toBe(false);
  });
});
