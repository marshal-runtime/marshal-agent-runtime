import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../../scripts/vitest-source-aliases.mjs';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: workspaceSourceAliases('@marshal/agent-runtime-dsh') },
  test: { include: ['src/**/*.spec.ts'], globals: false },
});
