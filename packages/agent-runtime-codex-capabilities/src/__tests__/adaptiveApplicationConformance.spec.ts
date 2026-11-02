import { join } from 'node:path';
import {
  ADAPTIVE_APPLICATION_CONFORMANCE_ASSERTIONS,
  ADAPTIVE_APPLICATION_CONFORMANCE_CASES,
  createAdaptiveApplicationConformanceFixture,
} from '@marshal/agent-runtime-conformance';
import { describe, it } from 'vitest';
import { CompositeMcpAppsResourceAdapter } from '../ui/compositeMcpAppsResourceAdapter.js';
import { DeclarativeUiMcpAppsResourceAdapter } from '../ui/mcpAppsResourceAdapter.js';
import { DeclarativeUiStore } from '../ui/store.js';

describe('Codex composite MCP Apps adaptive application conformance', () => {
  const fixture = createAdaptiveApplicationConformanceFixture({
    name: 'codex-composite-mcp-apps',
    resourceFactory({ react, stateRoot }) {
      const declarative = new DeclarativeUiMcpAppsResourceAdapter(
        new DeclarativeUiStore({
          storageRoot: join(stateRoot, 'codex-declarative-ui'),
        }),
      );
      return new CompositeMcpAppsResourceAdapter(declarative, react);
    },
  });

  it.each(ADAPTIVE_APPLICATION_CONFORMANCE_CASES)(
    'passes the %s case through the Codex composite resource adapter',
    async (caseName) => {
      const environment = await fixture.create(caseName);
      try {
        await ADAPTIVE_APPLICATION_CONFORMANCE_ASSERTIONS[caseName](environment);
      } finally {
        await environment.dispose();
      }
    },
    60_000,
  );
});
