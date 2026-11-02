import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['__tests__/**/*.spec.ts'],
    globals: false,
    // Git-backed lifecycle fixtures can be slow on loaded Windows CI hosts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
