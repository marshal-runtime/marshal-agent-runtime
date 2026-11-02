#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configuredPackageManager } from './package-manager.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = parseArguments(process.argv.slice(2));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'marshal-detached-mcp-'));
const deploymentRoot = cli.deploymentRoot ?? path.join(temporaryRoot, 'installed');
const unrelatedWorkspace = path.join(temporaryRoot, 'blank-workspace');
const isolatedWorkspace = path.join(temporaryRoot, 'isolated-workspace');
const serverEnvironment = {
  ...process.env,
  MARSHAL_RUNTIME_PERMISSION_PROFILE: 'trusted-local',
};

try {
  await Promise.all([
    mkdir(unrelatedWorkspace, { recursive: true }),
    mkdir(isolatedWorkspace, { recursive: true }),
  ]);
  if (!cli.deploymentRoot) {
    const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    const packageManager = configuredPackageManager(rootManifest);
    const deployed = spawnSync(
      process.execPath,
      [
        packageManager.cli,
        '--filter',
        '@marshal/agent-runtime-codex',
        'deploy',
        deploymentRoot,
        '--prod',
        '--legacy',
      ],
      { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (deployed.error) throw deployed.error;
    if (deployed.status !== 0) {
      throw new Error(`Detached package deployment failed:\n${deployed.stderr || deployed.stdout}`);
    }
  }

  await assertNoRepositoryPaths(deploymentRoot);
  const packageExports = await assertDetachedPackageExports(deploymentRoot);
  const nativeDelegationDependency = await assertDetachedNativeDelegationDependency(deploymentRoot);

  const cliPath = path.join(deploymentRoot, 'dist', 'cli.js');
  const first = await connect(cliPath, unrelatedWorkspace);
  let renderId;
  let firstExecutionReceiptId;
  let discoveryEvidence;
  let exactDiscoveryEvidence;
  try {
    const listed = await first.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const required of ['runtime_search', 'runtime_exec']) {
      if (!names.includes(required)) throw new Error(`Detached MCP server omitted ${required}`);
    }

    const discovered = await first.client.callTool({
      name: 'runtime_search',
      arguments: { query: 'memory', limit: 5 },
    });
    const matches = discovered.structuredContent?.matches ?? discovered.structuredContent?.result;
    if (!Array.isArray(matches) || matches.length < 1) {
      throw new Error(`Detached MCP search returned no capabilities: ${JSON.stringify(discovered.structuredContent)}`);
    }
    if (discovered.structuredContent?.detail !== 'summary') {
      throw new Error(`Broad discovery did not use compact summary detail: ${JSON.stringify(discovered.structuredContent)}`);
    }
    if (matches.some((match) =>
      match?.capability?.inputSchema !== undefined ||
      match?.capability?.outputSchema !== undefined ||
      match?.capability?.annotations !== undefined)) {
      throw new Error('Broad detached discovery leaked full schemas or annotations.');
    }
    const selectedName = matches[0]?.capability?.name;
    if (typeof selectedName !== 'string') throw new Error('Broad discovery omitted the selected capability name.');
    const exact = await first.client.callTool({
      name: 'runtime_search',
      arguments: { name: selectedName },
    });
    const exactMatch = exact.structuredContent?.matches?.[0];
    if (exact.structuredContent?.detail !== 'full' || !exactMatch?.capability?.inputSchema) {
      throw new Error(`Exact discovery omitted the full schema: ${JSON.stringify(exact.structuredContent)}`);
    }
    const summaryBytes = Buffer.byteLength(JSON.stringify(discovered.structuredContent));
    const exactBytes = Buffer.byteLength(JSON.stringify(exact.structuredContent));
    discoveryEvidence = { selectedName, broadDetail: 'summary', exactDetail: 'full', summaryBytes, exactBytes };

    const executed = await first.client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'inline_module',
        source: 'export default async (input) => ({ detached: true, input });',
        input: { value: 7 },
      },
    });
    if (executed.isError === true) {
      throw new Error(`Detached MCP execution failed: ${JSON.stringify(executed.structuredContent)}`);
    }
    const value = executed.structuredContent?.result?.output?.value;
    if (value?.detached !== true || value?.input?.value !== 7) {
      throw new Error(`Detached MCP execution returned an unexpected result: ${JSON.stringify(executed.structuredContent)}`);
    }
    firstExecutionReceiptId = executed.structuredContent?.receipt?.receiptId;
    if (typeof firstExecutionReceiptId !== 'string') {
      throw new Error(`Detached execution omitted its durable receipt: ${JSON.stringify(executed.structuredContent)}`);
    }

    const sessionId = 'detached-release-session';
    const started = await first.client.callTool({
      name: 'runtime_session_start',
      arguments: { eventId: 'detached-session-start', sessionId },
    });
    assertLifecycleReplay(started, false, 'initial session start');
    const observation = {
      eventId: 'detached-memory-write',
      sessionId,
      kind: 'user_message',
      content: 'Remember that the detached release marker is HELIOTROPE_RESTART_7F3A9.',
    };
    const observed = await first.client.callTool({ name: 'runtime_observe_turn', arguments: observation });
    assertLifecycleReplay(observed, false, 'initial memory observation');
    const replayed = await first.client.callTool({ name: 'runtime_observe_turn', arguments: observation });
    assertLifecycleReplay(replayed, true, 'same-process memory observation replay');
    const stored = await first.client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'memory.store',
        input: {
          scope: 'agent',
          content: 'The detached release marker is HELIOTROPE_RESTART_7F3A9.',
          tags: ['detached-release-smoke'],
        },
        context: { sessionId },
      },
    });
    assertSuccessful(stored, 'explicit durable memory store');

    await writeFile(
      path.join(unrelatedWorkspace, 'DetachedApp.tsx'),
      `export default function DetachedApp({ label = 'ready', marshal }) {
        return <main><h1>Detached {label}</h1><button onClick={() => marshal.requestDisplayMode('fullscreen')}>Open</button></main>;
      }`,
      'utf8',
    );
    const compiled = await first.client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'ui.compile',
        input: { entryPath: 'DetachedApp.tsx', title: 'Detached release UI' },
      },
    });
    assertSuccessful(compiled, 'detached UI compilation');
    const componentId = compiled.structuredContent?.result?.output?.component?.id;
    if (typeof componentId !== 'string') {
      throw new Error(`Detached UI compilation omitted componentId: ${JSON.stringify(compiled.structuredContent)}`);
    }
    const rendered = await first.client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'ui.render',
        input: {
          componentId,
          props: { label: 'ready' },
          fallback: { summary: 'Detached release UI ready', details: { label: 'ready' } },
          application: {
            version: '1.0.0',
            presentationModes: ['inline', 'fullscreen', 'pip'],
            actions: [],
            tools: [],
            localState: { scope: 'project', schemaVersion: '1.0.0' },
          },
        },
      },
    });
    assertSuccessful(rendered, 'detached UI render binding');
    renderId = rendered.structuredContent?.result?.output?.render?.id;
    if (typeof renderId !== 'string') {
      throw new Error(`Detached UI render omitted renderId: ${JSON.stringify(rendered.structuredContent)}`);
    }
    await assertStandardsUi(first.client, renderId);
    exactDiscoveryEvidence = await assertExactDiscoveryCatalog(first.client, renderId);
  } finally {
    await first.client.close();
  }

  const restarted = await connect(cliPath, unrelatedWorkspace);
  try {
    const replayedStart = await restarted.client.callTool({
      name: 'runtime_session_start',
      arguments: { eventId: 'detached-session-start', sessionId: 'detached-release-session' },
    });
    assertLifecycleReplay(replayedStart, true, 'cross-process session replay');
    const replayedObservation = await restarted.client.callTool({
      name: 'runtime_observe_turn',
      arguments: {
        eventId: 'detached-memory-write',
        sessionId: 'detached-release-session',
        kind: 'user_message',
        content: 'Remember that the detached release marker is HELIOTROPE_RESTART_7F3A9.',
      },
    });
    assertLifecycleReplay(replayedObservation, true, 'cross-process memory observation replay');
    const recalled = await restarted.client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'memory.search',
        input: { scope: 'agent', query: 'HELIOTROPE_RESTART_7F3A9', limit: 5 },
        context: { sessionId: 'detached-release-session' },
      },
    });
    assertSuccessful(recalled, 'restart-safe memory recall');
    if (!JSON.stringify(recalled.structuredContent).includes('HELIOTROPE_RESTART_7F3A9')) {
      throw new Error(`Detached memory did not survive restart: ${JSON.stringify(recalled.structuredContent)}`);
    }
    const secondExecution = await restarted.client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'inline_module',
        source: 'export default async () => ({ restarted: true });',
      },
    });
    assertSuccessful(secondExecution, 'post-restart execution');
    const secondExecutionReceiptId = secondExecution.structuredContent?.receipt?.receiptId;
    const receiptJournal = await readFile(
      path.join(unrelatedWorkspace, '.marshal', 'runtime', 'receipts', 'executions.jsonl'),
      'utf8',
    );
    if (
      typeof secondExecutionReceiptId !== 'string' ||
      !receiptJournal.includes(firstExecutionReceiptId) ||
      !receiptJournal.includes(secondExecutionReceiptId)
    ) {
      throw new Error('Execution receipt journal did not preserve receipts across process restart.');
    }
    await assertStandardsUi(restarted.client, renderId);
  } finally {
    await restarted.client.close();
  }

  const isolated = await connect(cliPath, isolatedWorkspace);
  try {
    const leaked = await isolated.client.callTool({
      name: 'runtime_render_component',
      arguments: { renderId },
    });
    if (leaked.isError !== true) {
      throw new Error('A render created in one workspace was visible in an isolated workspace.');
    }
  } finally {
    await isolated.client.close();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    distribution: '@marshal/agent-runtime-codex',
    deploymentRoot,
    suppliedReleaseCandidate: Boolean(cli.deploymentRoot),
    client: 'generic MCP stdio',
    workspaceOutsideRepository: true,
    repositoryPathLeak: false,
    requiredTools: ['runtime_search', 'runtime_exec'],
    executionVerified: true,
    lifecycleReplayVerified: true,
    explicitMemoryStoreVerified: true,
    restartMemoryVerified: true,
    receiptJournalVerified: true,
    standardsOnlyUiVerified: true,
    workspaceIsolationVerified: true,
    compactDiscoveryVerified: discoveryEvidence,
    exactDiscoveryVerified: exactDiscoveryEvidence,
    packageExports,
    nativeDelegationDependency,
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function connect(cliPath, workspacePath) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--workspace', workspacePath],
    cwd: workspacePath,
    env: serverEnvironment,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'marshal-detached-generic-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function assertStandardsUi(client, renderId) {
  const expectedRendererUri = 'ui://marshal-react/runtime-renderer/1.2.0/index.html';
  const listedTools = await client.listTools();
  const displayTool = listedTools.tools.find((tool) => tool.name === 'runtime_render_component');
  const resourceUri = displayTool?._meta?.ui?.resourceUri ?? displayTool?._meta?.['ui/resourceUri'];
  if (resourceUri !== expectedRendererUri) {
    throw new Error(`Stable render tool did not advertise renderer 1.2.0: ${JSON.stringify(displayTool)}`);
  }
  const resources = await client.listResources();
  if (!resources.resources.some((resource) => resource.uri === resourceUri)) {
    throw new Error(`Versioned renderer resource was not listed: ${resourceUri}`);
  }
  const resource = await client.readResource({ uri: resourceUri });
  const rendererHtml = String(resource.contents[0]?.text);
  const requiredChromeContracts = [
    'aria-label="Application controls"',
    'Picture in picture',
    'marshal/ui/chrome-action-request',
    'marshal/ui/chrome-action-cancel',
    'ui/notifications/host-context-changed',
    'ResizeObserver',
    'reportTotalHeight',
  ];
  if (
    resource.contents[0]?.mimeType !== 'text/html;profile=mcp-app' ||
    !rendererHtml.includes('ui/notifications/initialized') ||
    requiredChromeContracts.some((marker) => !rendererHtml.includes(marker))
  ) {
    throw new Error(`Renderer is not a standards-only MCP App resource: ${JSON.stringify(resource.contents[0])}`);
  }
  const displayed = await client.callTool({
    name: 'runtime_render_component',
    arguments: { renderId },
  });
  assertSuccessful(displayed, 'stable MCP Apps display');
  const structured = displayed.structuredContent;
  if (
    structured?.fallback?.summary !== 'Detached release UI ready' ||
    JSON.stringify(structured?.application?.presentationModes) !== JSON.stringify(['inline', 'fullscreen', 'pip']) ||
    structured?.render?.id !== renderId
  ) {
    throw new Error(`Stable display omitted fallback, modes, or render identity: ${JSON.stringify(structured)}`);
  }
}

function assertSuccessful(result, label) {
  if (
    result.isError === true ||
    (result.structuredContent?.status !== undefined && result.structuredContent.status !== 'success')
  ) {
    throw new Error(`${label} failed: ${JSON.stringify(result.structuredContent)}`);
  }
}

function assertLifecycleReplay(result, expected, label) {
  if (result.isError === true || result.structuredContent?.lifecycleResult?.lifecycleReceipt?.replayed !== expected) {
    throw new Error(`${label} did not report replayed=${expected}: ${JSON.stringify(result.structuredContent)}`);
  }
}

async function assertExactDiscoveryCatalog(client, renderId) {
  const skillId = 'skill://marshal.runtime/use-marshal-runtime';
  const expected = [
    { id: skillId, kind: 'skill' },
    {
      id: `catalog://marshal.runtime-resource-catalog/resource/${encodeURIComponent(skillId)}`,
      kind: 'resource',
    },
    { id: 'catalog://marshal.codex-host-tools/host-tool/runtime_exec', kind: 'host_tool' },
    { id: `ui://marshal-react/render/${renderId}`, kind: 'ui_application' },
  ];
  for (const entry of expected) {
    const result = await client.callTool({
      name: 'runtime_search',
      arguments: { catalogId: entry.id },
    });
    if (result.isError === true) {
      throw new Error(`Exact ${entry.kind} discovery failed: ${JSON.stringify(result.structuredContent)}`);
    }
    const discoveries = result.structuredContent?.discoveries;
    if (
      !Array.isArray(discoveries)
      || discoveries.length !== 1
      || discoveries[0]?.entry?.id !== entry.id
      || discoveries[0]?.entry?.kind !== entry.kind
    ) {
      throw new Error(
        `Exact ${entry.kind} discovery returned an unexpected entry: ${JSON.stringify(result.structuredContent)}`,
      );
    }
  }
  return expected;
}

function parseArguments(arguments_) {
  let deploymentRoot;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--deployment') {
      const value = arguments_[++index];
      if (!value || value.startsWith('--')) throw new Error('--deployment requires a directory.');
      deploymentRoot = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { deploymentRoot };
}

async function assertNoRepositoryPaths(root) {
  const needles = [repositoryRoot, repositoryRoot.replaceAll('\\', '/')].map((value) => value.toLowerCase());
  for (const file of await walk(root)) {
    if (!/\.(?:c?js|mjs|json|md|map)$/i.test(file)) continue;
    const content = (await readFile(file, 'utf8')).toLowerCase();
    if (needles.some((needle) => content.includes(needle))) {
      throw new Error(`Detached package contains a development-repository path: ${path.relative(root, file)}`);
    }
  }
}

async function assertDetachedPackageExports(root) {
  const rootRequire = createRequire(path.join(root, 'package.json'));
  const resolved = new Map();
  const resolveEntrypoint = async (requireFrom, specifier) => {
    const entrypoint = requireFrom.resolve(specifier);
    const rootRealPath = await realpath(root);
    const entrypointRealPath = await realpath(entrypoint);
    const relative = path.relative(rootRealPath, entrypointRealPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${specifier} resolves outside the detached deployment: ${entrypointRealPath}`);
    }
    await readFile(entrypointRealPath);
    resolved.set(specifier, {
      entrypoint: entrypointRealPath,
      relative: relative.replaceAll('\\', '/'),
    });
    return createRequire(entrypointRealPath);
  };

  const capabilitiesRequire = await resolveEntrypoint(
    rootRequire,
    '@marshal/agent-runtime-codex-capabilities',
  );
  const hostRequire = await resolveEntrypoint(rootRequire, '@marshal/agent-runtime-host');
  for (const specifier of [
    '@marshal/agent-runtime-host/lifecycle',
    '@marshal/agent-runtime-host/session-briefing',
    '@marshal/agent-runtime-host/state',
    '@marshal/runtime',
    '@marshal/runtime/host',
    '@marshal/runtime/host/lifecycle',
  ]) {
    await resolveEntrypoint(rootRequire, specifier);
  }
  for (const specifier of [
    '@marshal/agent-runtime-delegation',
    '@marshal/agent-runtime-effects',
    '@marshal/agent-runtime-ui',
    '@marshal/agent-runtime-ui/declarative',
  ]) {
    await resolveEntrypoint(capabilitiesRequire, specifier);
  }
  for (const specifier of [
    '@marshal/agent-runtime-permissions',
    '@marshal/agent-runtime-provider-artifacts',
    '@marshal/agent-runtime-provider-kit',
    '@marshal/agent-runtime-typescript',
  ]) {
    await resolveEntrypoint(hostRequire, specifier);
  }

  return Object.fromEntries(
    [...resolved].map(([specifier, value]) => [specifier, value.relative]),
  );
}

async function assertDetachedNativeDelegationDependency(root) {
  const distributionRequire = createRequire(path.join(root, 'package.json'));
  const capabilitiesEntrypoint = distributionRequire.resolve(
    '@marshal/agent-runtime-codex-capabilities',
  );
  const capabilitiesRequire = createRequire(capabilitiesEntrypoint);
  const codexManifestPath = capabilitiesRequire.resolve('@openai/codex/package.json');
  const codexManifest = JSON.parse(await readFile(codexManifestPath, 'utf8'));
  const codexCliPath = path.join(path.dirname(codexManifestPath), 'bin', 'codex.js');
  await readFile(codexCliPath);
  return {
    resolvableFromCapabilitiesPackage: true,
    version: codexManifest.version,
    cliEntrypointPresent: true,
  };
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}
