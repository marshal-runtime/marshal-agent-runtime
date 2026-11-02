import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sibling = (name: string) =>
  fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@marshal/agent-runtime-core': sibling('agent-runtime-core'),
      '@marshal/agent-runtime-extensions': sibling('agent-runtime-extensions'),
      '@marshal/agent-runtime-code-intelligence/runtime-service': fileURLToPath(
        new URL('../agent-runtime-code-intelligence/src/runtimeService.ts', import.meta.url),
      ),
      '@marshal/agent-runtime-effects': sibling('agent-runtime-effects'),
      '@marshal/agent-runtime-permissions': sibling('agent-runtime-permissions'),
      '@marshal/agent-runtime-provider-artifacts': sibling('agent-runtime-provider-artifacts'),
      '@marshal/agent-runtime-provider-kit': sibling('agent-runtime-provider-kit'),
      '@marshal/agent-runtime-typescript': sibling('agent-runtime-typescript'),
      '@marshal/agent-runtime-host/lifecycle': fileURLToPath(
        new URL('./src/lifecycle.ts', import.meta.url),
      ),
      '@marshal/agent-runtime-host/state': fileURLToPath(
        new URL('./src/state.ts', import.meta.url),
      ),
      '@marshal/runtime/host/lifecycle': fileURLToPath(
        new URL('../runtime/src/host-lifecycle.ts', import.meta.url),
      ),
      '@marshal/runtime/host': sibling('agent-runtime-host'),
      '@marshal/runtime': sibling('runtime'),
    },
  },
  test: {
    include: ['__tests__/**/*.spec.ts'],
    globals: false,
    testTimeout: 30_000,
  },
});
