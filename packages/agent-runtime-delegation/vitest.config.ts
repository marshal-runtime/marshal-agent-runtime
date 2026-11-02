import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@marshal/agent-runtime-core': fileURLToPath(
        new URL('../agent-runtime-core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['__tests__/**/*.spec.ts'],
    globals: false,
    testTimeout: 10_000,
  },
});
