import { describe, expect, it } from 'vitest';
import {
  createComposerConformanceFixture,
  runAdapterConformanceSuite,
} from '../src/index.js';

describe('generic composer conformance fixture', () => {
  it('passes through the actual core kernel and composer bindings', async () => {
    const report = await runAdapterConformanceSuite(createComposerConformanceFixture());

    expect(report).toMatchObject({
      adapterName: 'generic-composer',
      ok: true,
      passed: 11,
      failed: 0,
      skipped: 1,
    });
    expect(report.cases.find(({ name }) => name === 'legacy-alias-normalization')).toMatchObject({
      status: 'skipped',
    });
  });
});
