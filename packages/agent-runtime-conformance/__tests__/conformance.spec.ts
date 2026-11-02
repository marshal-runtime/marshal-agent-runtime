import { describe, expect, it } from 'vitest';
import {
  AdapterConformanceError,
  assertAdapterConformance,
  assertExactLookup,
  createSelfTestConformanceFixture,
  runAdapterConformanceSuite,
  type AdapterConformanceFixture,
} from '../src/index.js';

describe('agent runtime adapter conformance', () => {
  it('passes every assertion against the independent structural self-test fixture', async () => {
    const report = await runAdapterConformanceSuite(createSelfTestConformanceFixture());

    expect(report).toMatchObject({
      adapterName: 'self-test-adapter',
      ok: true,
      passed: 12,
      failed: 0,
      skipped: 0,
    });
    expect(report.cases.every(({ status }) => status === 'passed')).toBe(true);
  });

  it('treats legacy alias assertions as opt-in', async () => {
    const fixture = createSelfTestConformanceFixture({ legacyAliases: {} });
    const report = await assertAdapterConformance(fixture);

    expect(report).toMatchObject({ ok: true, passed: 11, failed: 0, skipped: 1 });
    expect(report.cases.find(({ name }) => name === 'legacy-alias-normalization')).toMatchObject({
      status: 'skipped',
    });
  });

  it('raises a case-specific error when an adapter breaks exact lookup', async () => {
    const base = createSelfTestConformanceFixture();
    const broken: AdapterConformanceFixture = {
      ...base,
      name: 'broken-exact-lookup',
      async create(caseName) {
        const environment = await base.create(caseName);
        return {
          ...environment,
          port: {
            ...environment.port,
            search: async (request) => ({
              protocolVersion: request.protocolVersion,
              query: request.query ?? request.name ?? '',
              matches: [],
            }),
          },
        };
      },
    };

    await expect(assertExactLookup(broken)).rejects.toMatchObject({
      name: 'AdapterConformanceError',
      caseName: 'exact-lookup',
    } satisfies Partial<AdapterConformanceError>);
  });
});
