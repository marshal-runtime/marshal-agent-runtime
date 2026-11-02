import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHistoricalRenderProbe } from '../../../scripts/verify-ui-history-recovery.mjs';

const renderId = 'a'.repeat(64);
const componentId = 'b'.repeat(64);
const bundleDigest = 'c'.repeat(64);
const tree = [{ path: 'scopes/project/render.json', bytes: 12, modifiedAtMs: 1_786_748_400_000, sha256: 'd'.repeat(64) }];
const observation = {
  renderId,
  componentId,
  bundleDigest,
  compiledHtmlBytes: 4_096,
  compiledHtmlSha256: 'e'.repeat(64),
  publicBindingDigest: 'f'.repeat(64),
  recoveryDigest: '1'.repeat(64),
  presentationModes: ['inline', 'fullscreen', 'pip'],
  actionIds: ['save'],
  toolIds: ['impact'],
  application: {
    version: '1.0.0',
    presentationModes: ['inline', 'fullscreen', 'pip'],
    actions: [{ id: 'save' }],
    tools: [{ id: 'impact' }],
  },
  storage: { view: 'evidence' },
};

test('historical UI probe separates deterministic recovery from live host claims', () => {
  const report = evaluateHistoricalRenderProbe({
    renderId,
    treeBefore: tree,
    treeAfter: tree,
    first: observation,
    afterRestart: structuredClone(observation),
    expectedStorage: { view: 'evidence' },
    requiredActions: ['save'],
    requiredTools: ['impact'],
    requiredModes: ['fullscreen', 'pip'],
  });

  assert.equal(report.status, 'passed');
  assert.ok(report.checks.every((check) => check.passed));
  assert.equal(report.afterRuntimeRestart.renderId, renderId);
  assert.ok(report.unverifiedLiveHostClaims.some((claim) => claim.includes('Codex desktop pixels')));
  assert.ok(report.unverifiedLiveHostClaims.some((claim) => claim.includes('fullscreen')));
});

test('historical UI probe fails on a changed binding, state tree, or expected state', () => {
  const report = evaluateHistoricalRenderProbe({
    renderId,
    treeBefore: tree,
    treeAfter: [{ ...tree[0], sha256: '2'.repeat(64) }],
    first: observation,
    afterRestart: { ...observation, publicBindingDigest: '3'.repeat(64), storage: { view: 'changed' } },
    expectedStorage: { view: 'evidence' },
    requiredActions: ['missing-action'],
    requiredTools: ['missing-tool'],
    requiredModes: ['pip'],
  });

  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.checks.filter((check) => !check.passed).map((check) => check.id).sort(),
    ['expected-saved-state', 'read-only-ui-state-tree', 'required-action:missing-action', 'required-tool:missing-tool', 'saved-state-recovered', 'stable-public-binding'],
  );
});
