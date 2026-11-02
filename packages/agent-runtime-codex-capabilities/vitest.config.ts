import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@marshal/agent-runtime-conformance': fileURLToPath(
        new URL('../agent-runtime-conformance/src/index.ts', import.meta.url),
      ),
      '@marshal/agent-runtime-core': fileURLToPath(
        new URL('../agent-runtime-core/src/index.ts', import.meta.url),
      ),
      '@marshal/agent-runtime-delegation': fileURLToPath(
        new URL('../agent-runtime-delegation/src/index.ts', import.meta.url),
      ),
      '@marshal/agent-runtime-effects': fileURLToPath(
        new URL('../agent-runtime-effects/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Git worktree creation and Windows junction checks can exceed Vitest's
    // five-second default on loaded CI hosts. Serial files also prevent one
    // fixture's filesystem teardown from racing another fixture's realpath.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
