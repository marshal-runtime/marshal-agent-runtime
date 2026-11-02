import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@marshal/agent-runtime-ui': fileURLToPath(
        new URL('../agent-runtime-ui/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['__tests__/**/*.spec.ts'],
    globals: false,
    testTimeout: 20_000,
  },
});
