import { describe, it } from 'vitest';
import {
  ADAPTIVE_APPLICATION_CONFORMANCE_ASSERTIONS,
  ADAPTIVE_APPLICATION_CONFORMANCE_CASES,
  createAdaptiveApplicationConformanceFixture,
} from '../src/index.js';

describe('standards-only MCP Apps adaptive application conformance', () => {
  const fixture = createAdaptiveApplicationConformanceFixture();

  it.each(ADAPTIVE_APPLICATION_CONFORMANCE_CASES)(
    'passes the %s case through the portable resource adapter',
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
