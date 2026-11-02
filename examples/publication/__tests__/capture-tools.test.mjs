import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildWindowsCaptureArguments } from '../demo-capture/capture-host.mjs';
import { prepareEvidenceBundle } from '../demo-capture/prepare-evidence.mjs';
import { validMediaSignature, verifyEvidenceBundle } from '../demo-capture/verify-evidence.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');

test('design studio uses one frozen implicit prompt across eval, capture, verifier, and docs', async () => {
  const capturePlan = JSON.parse(await readFile(join(repositoryRoot, 'examples/publication/demo-capture/capture-plan.json'), 'utf8'));
  const uiCases = JSON.parse(await readFile(join(repositoryRoot, 'docs/evals/v1/cases/ui.json'), 'utf8'));
  const demo = capturePlan.demos.find((item) => item.id === 'design-studio-capstone');
  const evalCase = uiCases.cases.find((item) => item.id === 'ui-design-studio-agent-orchestration-capstone');
  const buildPhase = evalCase?.phases.find((phase) => phase.id === 'build');
  const prompt = buildPhase?.prompt;

  assert.equal(demo.frozenPrompt.source, 'docs/evals/v1/cases/ui.json#ui-design-studio-agent-orchestration-capstone/build');
  assert.deepEqual(demo.prompts, [prompt]);
  assert.equal(createHash('sha256').update(prompt).digest('hex'), demo.frozenPrompt.sha256);
  assert.doesNotMatch(prompt, /\b(?:marshal|typescript|mcp|subagents?|agents?)\b/i);

  const liveRun = await readFile(join(repositoryRoot, 'examples/publication/demo-capture/live-run-script.md'), 'utf8');
  const goal = await readFile(join(repositoryRoot, 'docs/marshal-1.0-goal.md'), 'utf8');
  assert.ok(liveRun.includes(`> ${prompt}`));
  assert.ok(goal.includes(`> ${prompt}`));
});

// TODO(#11): Example sources the test reads are missing from the checkout.
test.skip('capture preparation freezes deterministic inputs but creates no evidence or media', async (context) => {
  const target = await mkdtemp(join(tmpdir(), 'marshal-capture-tool-test-'));
  context.after(async () => {
    assert.ok(resolve(target).startsWith(resolve(tmpdir())));
    await rm(target, { recursive: true, force: true });
  });

  const prepared = await prepareEvidenceBundle(target);
  assert.equal(prepared.demoCount, 7);
  assert.match(prepared.capturePlanSha256, /^[a-f0-9]{64}$/);

  const rootEntries = await readdir(target);
  assert.ok(rootEntries.includes('CAPTURE-BUNDLE-NOT-EVIDENCE.md'));
  assert.ok(rootEntries.includes('capture-plan.snapshot.json'));

  const input = JSON.parse(await readFile(join(target, 'design-studio-capstone', 'capture-input.json'), 'utf8'));
  assert.equal(input.status, 'planned-input-not-evidence');
  assert.equal(input.capturePlanSha256, prepared.capturePlanSha256);
  assert.equal(input.prompts.length, 1);
  assert.ok(input.sources.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  const capstoneEntries = await readdir(join(target, 'design-studio-capstone'));
  assert.ok(capstoneEntries.includes('recorder.template.json'));
  assert.ok(capstoneEntries.includes('host-gates.template.json'));
  const gates = JSON.parse(await readFile(join(target, 'design-studio-capstone', 'host-gates.template.json'), 'utf8'));
  assert.ok(gates.gates.some((gate) => gate.id === 'product-restart' && gate.status === 'UNVERIFIED'));

  for (const demo of rootEntries.filter((name) => !name.includes('.'))) {
    const entries = await readdir(join(target, demo));
    assert.equal(entries.some((name) => /\.(?:gif|mp4|webm)$/i.test(name)), false);
  }

  const verification = await verifyEvidenceBundle(target, { level: 'capture' });
  assert.equal(verification.ok, false);
  assert.ok(verification.errors.some((error) => error.includes('missing or empty screen.webm')));
});

// TODO(#11): Example sources the test reads are missing from the checkout.
test.skip('Windows capture command is foreground-only, non-overwriting, and restart-safe by default', () => {
  const args = buildWindowsCaptureArguments({ output: 'C:\\evidence\\screen.webm' });
  assert.ok(args.includes('-n'));
  assert.ok(args.includes('desktop'));
  assert.ok(args.includes('libvpx-vp9'));
  assert.equal(args.includes('-y'), false);
  assert.equal(args.includes('title=Codex'), false);

  const windowArgs = buildWindowsCaptureArguments({
    output: 'C:\\evidence\\screen.webm',
    source: 'window',
    windowTitle: 'Codex',
  });
  assert.ok(windowArgs.includes('title=Codex'));
});

test('capture verifier rejects text placeholders masquerading as media', () => {
  assert.equal(validMediaSignature(Buffer.from('not video'), 'webm'), false);
  assert.equal(validMediaSignature(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('header-webm-data')]), 'webm'), true);
  assert.equal(validMediaSignature(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(7)]), 'gif'), true);
  assert.equal(validMediaSignature(Buffer.from([0, 0, 0, 20, ...Buffer.from('ftyp'), 0, 0, 0, 0]), 'mp4'), true);
});
