import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../../scripts/vitest-source-aliases.mjs';

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases('@marshal/agent-runtime-codex', {
      includeDevDependencies: true,
    }),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
