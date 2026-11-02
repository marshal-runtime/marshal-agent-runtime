import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOracleCoverage } from './evals/objective-oracle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'evals');
const versionRoot = join(root, 'v1');
const manifest = await readJson(join(versionRoot, 'manifest.json'));
const treatments = await readJson(join(versionRoot, manifest.treatmentsFile));
const caseSets = await Promise.all(manifest.caseFiles.map((file) => readJson(join(versionRoot, file))));

for (const directory of [join(root, 'schema'), versionRoot, join(versionRoot, 'cases')]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) await readJson(join(directory, entry.name));
  }
}

assert(manifest.schemaVersion === '1.0.0' && manifest.corpusVersion === 'v1', 'Unexpected manifest version.');
assert(manifest.status === 'frozen', 'The v1 manifest must be frozen.');
assert(manifest.runPolicy?.minimumRepetitions >= 3, 'At least three repetitions are required.');

const treatmentIds = uniqueIds(treatments.treatments, 'treatment');
for (const id of Object.values(manifest.headlineComparison)) {
  assert(treatmentIds.has(id), `Unknown headline treatment: ${id}`);
}
const headline = treatments.treatments.filter((item) => item.headlineEligible);
assert(headline.length === 2, 'Exactly two treatments must be headline eligible.');
assert(headline.every((item) => !item.marshal.promptForced), 'Headline prompts cannot force Marshal.');

const caseIds = new Set();
const cases = [];
for (const set of caseSets) {
  assert(set.schemaVersion === '1.0.0', `Unexpected case schema in ${set.family}.`);
  assert(['routing', 'memory', 'execution', 'ui', 'control'].includes(set.family), `Unknown family: ${set.family}`);
  for (const item of set.cases) {
    cases.push(item);
    assert(!caseIds.has(item.id), `Duplicate case id: ${item.id}`);
    caseIds.add(item.id);
    assert(item.promptPolicy?.mentionsMarshal === false, `${item.id} names Marshal.`);
    assert(item.promptPolicy?.mentionsImplementation === false, `${item.id} specifies its implementation.`);
    assert(item.phases?.length > 0, `${item.id} has no phases.`);
    assert(item.scoring?.assertions?.length > 0, `${item.id} has no assertions.`);
    const weight = item.scoring.assertions.reduce((sum, assertion) => sum + assertion.weight, 0);
    assert(Math.abs(weight - 1) < 1e-9, `${item.id} assertion weights total ${weight}, not 1.`);
  }
}
const oracleCoverage = assertOracleCoverage(cases);

const expectedFrozen = [manifest.treatmentsFile, ...manifest.caseFiles];
assert(Object.keys(manifest.frozenFiles).length === expectedFrozen.length, 'Frozen file list is incomplete.');
for (const file of expectedFrozen) {
  const bytes = await readFile(join(versionRoot, file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert(manifest.frozenFiles[file] === digest, `Digest mismatch for ${file}.`);
}

process.stdout.write(`Validated ${caseIds.size} cases, ${oracleCoverage.objectiveAssertions} objective assertions, ${treatmentIds.size} treatments, and ${expectedFrozen.length} frozen files.\n`);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function uniqueIds(items, label) {
  assert(Array.isArray(items) && items.length > 0, `No ${label}s defined.`);
  const ids = new Set();
  for (const item of items) {
    assert(typeof item.id === 'string' && item.id.length > 0, `Invalid ${label} id.`);
    assert(!ids.has(item.id), `Duplicate ${label} id: ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
