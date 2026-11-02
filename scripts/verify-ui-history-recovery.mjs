#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCodexRuntime } from '../packages/agent-runtime-codex/dist/index.js';

const DIGEST = /^[a-f0-9]{64}$/;

export async function probeHistoricalRender({
  workspacePath,
  renderId,
  expectedStorage,
  requiredActions = [],
  requiredTools = [],
  requiredModes = [],
}) {
  const resolvedWorkspace = resolve(workspacePath);
  if (!DIGEST.test(renderId ?? '')) throw new Error('renderId must be a 64-character lowercase hex digest');
  const uiStateRoot = join(resolvedWorkspace, '.marshal', 'runtime', 'react-ui');
  const treeBefore = await snapshotTree(uiStateRoot);
  const first = await openHistoricalRender(resolvedWorkspace, renderId);
  const afterRestart = await openHistoricalRender(resolvedWorkspace, renderId);
  const treeAfter = await snapshotTree(uiStateRoot);
  return evaluateHistoricalRenderProbe({
    renderId,
    treeBefore,
    treeAfter,
    first,
    afterRestart,
    expectedStorage,
    requiredActions,
    requiredTools,
    requiredModes,
  });
}

export function evaluateHistoricalRenderProbe({
  renderId,
  treeBefore,
  treeAfter,
  first,
  afterRestart,
  expectedStorage,
  requiredActions = [],
  requiredTools = [],
  requiredModes = [],
}) {
  const checks = [];
  const check = (id, passed, detail) => checks.push({ id, passed: Boolean(passed), detail });
  check('compiled-react-payload', first.compiledHtmlBytes >= 1_000, `${first.compiledHtmlBytes} compiled HTML bytes`);
  check('requested-render-id', first.renderId === renderId && afterRestart.renderId === renderId, `requested ${renderId}`);
  check('immutable-component', DIGEST.test(first.componentId) && first.componentId === afterRestart.componentId, first.componentId);
  check('immutable-bundle', DIGEST.test(first.bundleDigest) && first.bundleDigest === afterRestart.bundleDigest, first.bundleDigest);
  check('stable-public-binding', first.publicBindingDigest === afterRestart.publicBindingDigest, first.publicBindingDigest);
  check('stable-recovery-envelope', first.recoveryDigest === afterRestart.recoveryDigest, first.recoveryDigest);
  check('application-manifest', Boolean(first.application), first.application ? 'present' : 'missing');
  check(
    'inline-baseline',
    first.presentationModes.includes('inline'),
    first.presentationModes.join(', ') || 'no presentation modes declared',
  );
  check('declared-actions-array', Array.isArray(first.actionIds), `${first.actionIds.length} declared actions`);
  check('declared-tools-array', Array.isArray(first.toolIds), `${first.toolIds.length} declared tools`);
  for (const actionId of requiredActions) {
    check(`required-action:${actionId}`, first.actionIds.includes(actionId), `declared actions: ${first.actionIds.join(', ') || 'none'}`);
  }
  for (const toolId of requiredTools) {
    check(`required-tool:${toolId}`, first.toolIds.includes(toolId), `declared tools: ${first.toolIds.join(', ') || 'none'}`);
  }
  for (const mode of requiredModes) {
    check(`required-mode:${mode}`, first.presentationModes.includes(mode), `declared modes: ${first.presentationModes.join(', ') || 'none'}`);
  }
  check('saved-state-recovered', sameJson(first.storage, afterRestart.storage), stableJson(first.storage));
  if (expectedStorage !== undefined) {
    check('expected-saved-state', sameJson(afterRestart.storage, expectedStorage), stableJson(afterRestart.storage));
  }
  check('read-only-ui-state-tree', sameJson(treeBefore, treeAfter), `${treeAfter.length} state files unchanged`);

  return {
    schemaVersion: '1.0.0',
    evidenceClass: 'deterministic-runtime-recovery-probe',
    renderId,
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    checks,
    firstOpen: first,
    afterRuntimeRestart: afterRestart,
    uiStateTree: { before: treeBefore, after: treeAfter },
    unverifiedLiveHostClaims: [
      'Codex desktop pixels mounted the compiled React interface',
      'a user control invoked each declared action or tool in Codex',
      'Codex granted, denied, or fell back from fullscreen and picture-in-picture requests',
      'the historical chat message reopened after a real Codex application restart',
    ],
  };
}

async function openHistoricalRender(workspacePath, renderId) {
  // This diagnostic must neither touch the adapter-wide memory database nor
  // violate the runtime invariant that memory storage lives outside a workspace.
  const scratchRoot = await mkdtemp(join(tmpdir(), 'marshal-ui-history-'));
  let runtime;
  try {
    runtime = await createCodexRuntime({ workspacePath });
    const publicResult = await runtime.resources?.callTool?.(
      'runtime_render_component',
      { renderId },
      {},
    );
    const payloadResult = await runtime.resources?.callTool?.(
      'marshal_get_react_payload',
      { renderId },
      {},
    );
    return normalizeObservation(publicResult, payloadResult);
  } finally {
    await runtime?.dispose();
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

function normalizeObservation(publicResult, payloadResult) {
  const publicStructured = record(publicResult?.structuredContent, 'public render structuredContent');
  const payloadStructured = record(payloadResult?.structuredContent, 'compiled payload structuredContent');
  const marshal = record(payloadStructured.marshal, 'compiled payload marshal envelope');
  if (marshal.kind !== 'compiled_react_ui') throw new Error('The historical payload is not a compiled React interface.');
  if (typeof marshal.componentHtml !== 'string') throw new Error('The historical compiled React HTML is missing.');
  const render = record(payloadStructured.render, 'payload render');
  const application = optionalRecord(marshal.application ?? publicStructured.application);
  const actions = Array.isArray(application?.actions) ? application.actions : [];
  const tools = Array.isArray(application?.tools) ? application.tools : [];
  const presentationModes = Array.isArray(application?.presentationModes)
    ? application.presentationModes.filter((value) => typeof value === 'string')
    : [];
  const storage = record(marshal.storage ?? {}, 'compiled payload storage');
  const publicBinding = {
    render: publicStructured.render,
    props: publicStructured.props,
    fallback: publicStructured.fallback,
    application: publicStructured.application,
  };
  const recoveryEnvelope = {
    renderId: render.id,
    componentId: marshal.componentId,
    bundleDigest: marshal.bundleDigest,
    props: payloadStructured.props,
    fallback: payloadStructured.fallback,
    application,
    storage,
  };
  return {
    renderId: render.id,
    componentId: marshal.componentId,
    bundleDigest: marshal.bundleDigest,
    compiledHtmlBytes: Buffer.byteLength(marshal.componentHtml),
    compiledHtmlSha256: sha256(marshal.componentHtml),
    publicBindingDigest: sha256(stableJson(publicBinding)),
    recoveryDigest: sha256(stableJson(recoveryEnvelope)),
    presentationModes,
    actionIds: actions.map((value) => optionalRecord(value)?.id).filter((value) => typeof value === 'string'),
    toolIds: tools.map((value) => optionalRecord(value)?.id).filter((value) => typeof value === 'string'),
    application,
    storage,
  };
}

async function snapshotTree(root) {
  const files = [];
  await visit(root, root, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function visit(root, current, files) {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) await visit(root, path, files);
    else if (entry.isFile()) {
      const info = await stat(path);
      files.push({
        path: relative(root, path).replaceAll('\\', '/'),
        bytes: info.size,
        modifiedAtMs: info.mtimeMs,
        sha256: sha256(await readFile(path)),
      });
    }
  }
}

function record(value, label) {
  const result = optionalRecord(value);
  if (!result) throw new Error(`${label} must be an object`);
  return result;
}

function optionalRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(values) {
  const positional = [];
  let outputPath;
  let expectedStoragePath;
  const requiredActions = [];
  const requiredTools = [];
  const requiredModes = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--output') outputPath = values[++index];
    else if (value === '--expect-storage') expectedStoragePath = values[++index];
    else if (value === '--require-action') requiredActions.push(values[++index]);
    else if (value === '--require-tool') requiredTools.push(values[++index]);
    else if (value === '--require-mode') requiredModes.push(values[++index]);
    else positional.push(value);
  }
  if (positional.length !== 2 || !positional[0] || !DIGEST.test(positional[1] ?? '')) {
    throw new Error('Usage: node scripts/verify-ui-history-recovery.mjs <workspace> <renderId> [--expect-storage expected.json] [--require-action id] [--require-tool id] [--require-mode inline|fullscreen|pip] [--output report.json]');
  }
  if ([...requiredActions, ...requiredTools].some((value) => !value)) throw new Error('Required action and tool IDs must be non-empty.');
  if (requiredModes.some((value) => !['inline', 'fullscreen', 'pip'].includes(value))) throw new Error('Required modes must be inline, fullscreen, or pip.');
  return { workspacePath: positional[0], renderId: positional[1], outputPath, expectedStoragePath, requiredActions, requiredTools, requiredModes };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const expectedStorage = options.expectedStoragePath
    ? JSON.parse(await readFile(resolve(options.expectedStoragePath), 'utf8'))
    : undefined;
  const report = await probeHistoricalRender({
    workspacePath: options.workspacePath,
    renderId: options.renderId,
    expectedStorage,
    requiredActions: options.requiredActions,
    requiredTools: options.requiredTools,
    requiredModes: options.requiredModes,
  });
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) await writeFile(resolve(options.outputPath), encoded, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(encoded);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
