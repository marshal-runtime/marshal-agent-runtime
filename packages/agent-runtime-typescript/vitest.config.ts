import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.spec.ts'],
    testTimeout: 15_000,
  },
});
