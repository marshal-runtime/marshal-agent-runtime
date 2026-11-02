import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadCorpus } from '../core.mjs';
import { assertOracleCoverage, evaluateObjectiveEvidence } from '../objective-oracle.mjs';

test('objective oracle exhaustively covers every non-human frozen assertion', async () => {
  const corpus = await loadCorpus();
  assert.deepEqual(assertOracleCoverage(corpus.cases), { cases: 18, objectiveAssertions: 55 });
});

test('grounded architecture assertions pass only with fixture symbols and no runtime activation', async () => {
  const item = await caseById('control-read-only-architecture-answer');
  const result = await evaluateObjectiveEvidence({
    case: item,
    outputDirectory: process.cwd(),
    phaseOutputs: [{
      id: 'request',
      output: 'runQueuedJob in public-api.mjs forwards the signal to waitForWork in queue.mjs, which registers it on the worker record in worker-process.mjs.',
    }],
    observedTools: [{ type: 'command_execution', command: 'rg waitForWork' }],
  });
  assert.equal(result.assertionObservations['answer-grounded'].actual, true);
  assert.equal(result.assertionObservations['citations-correct'].actual, true);
  assert.equal(result.assertionObservations['no-unneeded-runtime'].actual, true);

  const activated = await evaluateObjectiveEvidence({
    case: item,
    outputDirectory: process.cwd(),
    phaseOutputs: [{ id: 'request', output: 'waitForWork.' }],
    observedTools: [{ type: 'mcp_tool_call', tool: 'runtime_exec' }],
  });
  assert.equal(activated.assertionObservations['answer-grounded'].actual, false);
  assert.equal(activated.assertionObservations['no-unneeded-runtime'].actual, false);
});

test('UI host facts require explicit captured-evidence references', async () => {
  const item = await caseById('ui-inline-incident-card');
  const missing = await evaluateObjectiveEvidence({ case: item, outputDirectory: process.cwd(), hostFacts: { 'actions-safe': { actual: true } } });
  assert.equal(missing.assertionObservations['actions-safe'].actual, false);
  const grounded = await evaluateObjectiveEvidence({
    case: item,
    outputDirectory: process.cwd(),
    hostFacts: {
      'actions-safe': { actual: true, evidence: [{ kind: 'trace-event', ref: 'action-receipt-1', sha256: 'a'.repeat(64) }] },
      'state-updates': { actual: true, evidence: [{ kind: 'screenshot', ref: 'acknowledged-state.png', sha256: 'b'.repeat(64) }] },
    },
    evidenceReferences: [
      { kind: 'trace-event', ref: 'action-receipt-1', sha256: 'a'.repeat(64) },
      { kind: 'screenshot', ref: 'acknowledged-state.png', sha256: 'b'.repeat(64) },
    ],
  });
  assert.equal(grounded.assertionObservations['actions-safe'].actual, true);
  assert.equal(grounded.assertionObservations['state-updates'].actual, true);
});

test('editable enrichment requires exact fixture groups and a captured source revision', async () => {
  const item = await caseById('execution-editable-event-enrichment');
  const root = await mkdtemp(join(tmpdir(), 'marshal-objective-oracle-'));
  await writeFile(join(root, 'enrich.ts'), 'export default () => true;', 'utf8');
  const fixtureText = 'deploy-checkout-41 deploy-catalog-17 deploy-checkout-42 deploy-search-09 packages/payments packages/catalog-core packages/search-index';
  const result = await evaluateObjectiveEvidence({
    case: item,
    outputDirectory: root,
    phaseOutputs: [
      { id: 'build', output: fixtureText },
      { id: 'revise', output: 'deploy-checkout-41 deploy-catalog-17 deploy-search-09 packages/payments packages/catalog-core packages/search-index' },
    ],
    generatedFiles: [
      { name: 'build-enrich.ts', path: 'enrich.ts', mediaType: 'text/plain' },
      { name: 'revise-enrich.ts', path: 'enrich.ts', mediaType: 'text/plain' },
    ],
    trace: [{ sourceDigest: 'abc', receipt: { id: 'r1' } }],
  });
  assert.equal(result.assertionObservations['grouping-correct'].actual, true);
  assert.equal(result.assertionObservations['editable-rerunnable-source'].actual, true);
  assert.equal(result.assertionObservations['execution-provenance'].actual, true);
});

async function caseById(id) {
  const corpus = await loadCorpus();
  return corpus.cases.find((item) => item.id === id);
}
