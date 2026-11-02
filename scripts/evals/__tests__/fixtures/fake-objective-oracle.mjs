#!/usr/bin/env node

const request = JSON.parse(await readStdin());
if (process.argv.slice(2).includes('--preflight')) {
  const assertionIds = request.case.scoring.assertions
    .filter((assertion) => assertion.kind !== 'human-rubric')
    .map((assertion) => assertion.id)
    .sort();
  process.stdout.write(`${JSON.stringify({ schemaVersion: '1.0.0', ok: true, caseId: request.case.id, assertionIds })}\n`);
  process.exit(0);
}
const assertionObservations = Object.fromEntries(
  request.case.scoring.assertions
    .filter((assertion) => assertion.kind !== 'human-rubric')
    .map((assertion) => [assertion.id, {
      type: 'boolean',
      actual: true,
      grader: 'fake-deterministic-oracle',
      notes: 'Protocol fixture observation.',
    }]),
);
process.stdout.write(`${JSON.stringify({ schemaVersion: '1.0.0', assertionObservations })}\n`);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
