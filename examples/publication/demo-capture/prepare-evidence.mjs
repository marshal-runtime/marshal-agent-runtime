#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const captureRoot = dirname(fileURLToPath(import.meta.url));
const publicationRoot = resolve(captureRoot, '..');
const repositoryRoot = resolve(publicationRoot, '..', '..');

export async function prepareEvidenceBundle(targetArgument) {
  if (!targetArgument) throw new Error('Usage: node prepare-evidence.mjs /absolute/empty/evidence-directory');
  if (!isAbsolute(targetArgument)) throw new Error('Evidence directory must be an absolute path.');

  const target = resolve(targetArgument);
  if (inside(target, repositoryRoot)) {
    throw new Error('Evidence bundles must live outside the source repository.');
  }
  await requireEmptyDirectory(target);

  const planText = await readFile(join(captureRoot, 'capture-plan.json'), 'utf8');
  const plan = JSON.parse(planText);
  const catalog = JSON.parse(await readFile(join(publicationRoot, 'catalog.json'), 'utf8'));
  const planHash = sha256(planText);
  const examples = new Map(catalog.examples.map((example) => [example.id, example]));

  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'CAPTURE-BUNDLE-NOT-EVIDENCE.md'), [
    '# Prepared capture bundle — not evidence',
    '',
    'This directory contains frozen inputs and empty evidence slots. Preparation does not prove that a host run occurred.',
    'After every required file and human review is complete, delete this notice immediately before running the verifier.',
    'Deleting it is an operator declaration that the bundle is ready for verification; it is not evidence by itself.',
    '',
  ].join('\n'));
  await writeFile(join(target, 'capture-plan.snapshot.json'), planText);

  for (const demo of plan.demos) {
    const demoRoot = join(target, demo.id);
    await mkdir(demoRoot, { recursive: true });
    const sourceEntries = [];
    for (const exampleId of demo.catalogExampleIds) {
      const example = examples.get(exampleId);
      if (!example) throw new Error(`${demo.id}: unknown catalog example ${exampleId}`);
      for (const source of [...example.sources, ...example.fixtures]) {
        const absolute = join(publicationRoot, source);
        const bytes = await readFile(absolute);
        sourceEntries.push({
          exampleId,
          path: `examples/publication/${source}`.replaceAll('\\', '/'),
          bytes: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
    sourceEntries.sort((left, right) => left.path.localeCompare(right.path));
    const prompts = demo.prompts.map((prompt, index) => ({ index, text: prompt, sha256: sha256(prompt) }));
    const input = {
      schemaVersion: '1.0.0',
      status: 'planned-input-not-evidence',
      demoId: demo.id,
      capturePlanVersion: plan.version,
      capturePlanSha256: planHash,
      promptScript: demo.promptScript,
      prompts,
      sources: sourceEntries,
      requiredCaptureFiles: demo.requiredCaptureFiles,
      requiredPublicationFiles: demo.requiredPublicationFiles,
    };
    await writeFile(join(demoRoot, 'capture-input.json'), `${JSON.stringify(input, null, 2)}\n`);
    if (demo.prompts.length > 0) {
      await writeFile(join(demoRoot, 'prompt.txt'), `${demo.prompts.join('\n\n--- next fresh task ---\n\n')}\n`);
    }
    await writeFile(join(demoRoot, 'metadata.template.json'), `${JSON.stringify(metadataTemplate(demo, planHash), null, 2)}\n`);
    await writeFile(join(demoRoot, 'recorder.template.json'), `${JSON.stringify({
      schemaVersion: '1.0.0',
      evidenceClass: 'recorder-provenance-supporting-only',
      startedAt: 'REPLACE_WITH_ISO_8601',
      completedAt: 'REPLACE_WITH_ISO_8601',
      source: 'desktop',
      targetWindowTitle: 'Codex',
      output: { path: 'screen.webm', bytes: 0, sha256: 'REPLACE' },
      encoder: { executable: 'REPLACE', version: 'REPLACE', arguments: [] },
      processOutcome: { code: 'REPLACE', signal: null },
      interactionDriver: 'human',
      applicationRestartAutomated: false,
    }, null, 2)}\n`);
    if ((demo.requiredHostGates ?? []).length > 0) {
      await writeFile(join(demoRoot, 'host-gates.template.json'), `${JSON.stringify({
        schemaVersion: '1.0.0',
        evidenceClass: 'operator-observed-host-gates',
        demoId: demo.id,
        operator: 'REPLACE',
        recording: 'screen.webm',
        interactionDriver: 'human',
        gates: demo.requiredHostGates.map((id) => ({
          id,
          status: 'UNVERIFIED',
          sourceStartMs: null,
          sourceEndMs: null,
          traceRefs: [],
          receiptIds: [],
          notes: [],
        })),
      }, null, 2)}\n`);
    }
    await writeFile(join(demoRoot, 'redaction-manifest.template.json'), `${JSON.stringify({
      schemaVersion: '1.0.0',
      demoId: demo.id,
      reviewer: 'REPLACE',
      reviewed: false,
      rules: [],
      redactions: [],
      traceIntegrityPreserved: false,
    }, null, 2)}\n`);
    await writeFile(join(demoRoot, 'review.template.json'), `${JSON.stringify({
      schemaVersion: '1.0.0',
      demoId: demo.id,
      reviewer: 'REPLACE',
      continuityInspected: false,
      hostPixelsInspected: false,
      traceReceiptCorrespondenceInspected: false,
      shortEditFairToUncut: false,
      unsupportedFeatures: [],
      notes: [],
    }, null, 2)}\n`);
    await writeFile(join(demoRoot, 'derivatives.template.json'), `${JSON.stringify({
      schemaVersion: '1.0.0',
      demoId: demo.id,
      encoder: { name: 'REPLACE', version: 'REPLACE', commands: [] },
      source: { path: 'screen.webm', sha256: 'REPLACE' },
      outputs: [
        { path: 'preview.gif', sha256: 'REPLACE' },
        { path: 'short.mp4', sha256: 'REPLACE' },
      ],
      edits: [{ sourceStartMs: 0, sourceEndMs: 1, purpose: 'REPLACE' }],
    }, null, 2)}\n`);
  }

  return { target, demoCount: plan.demos.length, capturePlanSha256: planHash };
}

function metadataTemplate(demo, planHash) {
  return {
    schemaVersion: '1.0.0',
    evidenceClass: 'uncut-live',
    demoId: demo.id,
    captureAttemptId: 'REPLACE_WITH_STABLE_ATTEMPT_ID',
    edited: false,
    capturePlanSha256: planHash,
    promptHashes: demo.prompts.map((prompt) => sha256(prompt)),
    startedAt: 'REPLACE_WITH_ISO_8601',
    completedAt: 'REPLACE_WITH_ISO_8601',
    host: { name: 'REPLACE', version: 'REPLACE', operatingSystem: 'REPLACE' },
    model: { id: 'REPLACE', reasoning: 'REPLACE' },
    runtime: { packageVersion: 'REPLACE', protocolVersion: 'REPLACE', adapterVersion: 'REPLACE', pluginVersion: 'REPLACE' },
    permissionProfile: 'REPLACE',
    fixtureMode: 'recorded-offline-or-none',
    recording: {
      uncutFile: 'screen.webm',
      recorderProvenance: 'recorder.json',
      source: 'desktop',
      continuous: true,
      paused: false,
      operatorDriven: true,
      hostInteractionAutomated: false,
      applicationRestartAutomated: false,
    },
    notes: [],
  };
}

async function requireEmptyDirectory(target) {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error('Evidence target exists and is not a directory.');
    if ((await readdir(target)).length > 0) throw new Error('Evidence target must be empty.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function inside(candidate, parent) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  try {
    const result = await prepareEvidenceBundle(process.argv[2]);
    console.log(`Prepared ${result.demoCount} capture inputs at ${result.target}.`);
    console.log(`Capture plan sha256:${result.capturePlanSha256}`);
    console.log('No live evidence or media was created.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
