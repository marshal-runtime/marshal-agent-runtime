import { describe, expect, it } from 'vitest';
import { CodexAppServerBackend } from '../subagents/codexAppServerBackend.js';

const smoke = process.env.CODEX_REAL_BACKEND_SMOKE === '1' ? it : it.skip;

describe('installed Codex app-server backend', () => {
  smoke(
    'initializes and lists threads through the installed CLI',
    async () => {
      const backend = new CodexAppServerBackend({
        workspaceRoot: process.cwd(),
        requestTimeoutMs: 30_000,
      });
      try {
        const threads = await backend.list({ workspacePath: process.cwd(), limit: 1 });
        expect(Array.isArray(threads)).toBe(true);
      } finally {
        await backend.dispose();
      }
    },
    60_000,
  );
});
