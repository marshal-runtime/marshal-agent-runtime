import { describe, expect, it } from 'vitest';
import { safeAmbientEnvironment } from '../subagents/codexAppServerBackend.js';

describe('CodexAppServerBackend environment boundary', () => {
  it('keeps runtime discovery variables and drops ambient credentials by default', () => {
    const sanitized = safeAmbientEnvironment({
      PATH: 'bin',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\agent',
      CODEX_HOME: 'C:\\Users\\agent\\.codex',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });

    expect(sanitized).toMatchObject({
      PATH: 'bin',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\agent',
      CODEX_HOME: 'C:\\Users\\agent\\.codex',
    });
    expect(sanitized).not.toHaveProperty('OPENAI_API_KEY');
    expect(sanitized).not.toHaveProperty('GITHUB_TOKEN');
    expect(sanitized).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });
});
