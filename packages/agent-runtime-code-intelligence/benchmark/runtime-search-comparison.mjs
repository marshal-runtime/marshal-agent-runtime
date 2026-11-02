import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeKernel,
  createAllowAllPermissionBroker,
} from '../../agent-runtime-core/dist/index.js';
import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
} from '../../runtime/dist/index.js';
import { InProcessQuillstoneKnowledgeIndex } from '../dist/index.js';

const includeHybrid = process.argv.includes('--hybrid');
const context = Object.freeze({
  principal: { id: 'runtime-search-benchmark', kind: 'agent' },
  scope: { workspaceId: 'runtime-search-benchmark', sessionId: 'benchmark' },
  metadata: { harness: 'benchmark' },
});

const capturedInventory = await captureRuntimeDevelopmentInventory();
const baseCapabilities = capturedInventory.capabilities;
const baseCatalogEntries = capturedInventory.catalogEntries;

const extensionCapabilities = Object.freeze([
  capability('extension.status', 'Inspect extension status',
    'List detected, installed, installing, enabled, disabled, blocked, and failed extensions.',
    ['extension', 'status', 'lifecycle']),
  capability('extension.install', 'Install a detected extension',
    'Run the trusted repository installation script, verify its built package, and install it.',
    ['extension', 'install', 'build']),
  capability('extension.enable', 'Enable an installed extension',
    'Activate an installed extension and expose its tools, skills, resources, and catalog entries.',
    ['extension', 'enable', 'activate']),
  capability('extension.disable', 'Disable an installed extension',
    'Deactivate an extension and hide its tools, skills, resources, and catalog entries.',
    ['extension', 'disable', 'deactivate']),
]);

const extensionCatalog = Object.freeze({
  id: 'skill://extension/operations',
  kind: 'skill',
  title: 'Manage runtime extensions',
  description: 'Install, enable, disable, and inspect detected runtime extensions.',
  tags: ['extension', 'skill', 'lifecycle'],
  action: { type: 'resource_read', uri: 'skill://extension/operations' },
});

const qualityQueries = Object.freeze([
  judged('runtime.schedules.create', ['capability:runtime.schedules.create']),
  judged('set up recurring work every morning', ['capability:runtime.schedules.create']),
  judged('pause a recurring schedule', ['capability:runtime.schedules.pause']),
  judged('bring back a paused schedule', ['capability:runtime.schedules.resume']),
  judged('see whether a background job finished', ['capability:runtime.jobs.status']),
  judged('stop a running background job', ['capability:runtime.jobs.cancel']),
  judged('execute an editable TypeScript file', ['capability:runtime.module.execute']),
  judged('run disposable TypeScript', ['capability:runtime.inline_module.execute']),
  judged('turn TSX into a component', ['capability:ui.compile']),
  judged('show the rendered interface', ['capability:ui.render']),
  judged('save a new authored UI application', ['capability:ui.authored.create']),
  judged('update an existing UI app', ['capability:ui.authored.update']),
  judged('write a project artifact', ['capability:artifacts.write']),
  judged('list saved artifacts', ['capability:artifacts.list']),
  judged('scheduel a recurring taks', ['capability:runtime.schedules.create']),
  judged('install a newly detected plugin', ['capability:extension.install']),
  judged('temporarily hide extension tools', ['capability:extension.disable']),
  judged('restore extension tools', ['capability:extension.enable']),
  judged('extensoin statuz', ['capability:extension.status']),
  judged('reactivate an add-on', ['capability:extension.enable']),
  judged('turn off an add-on', ['capability:extension.disable']),
  judged('build the detected unbuilt extension', ['capability:extension.install']),
  judged('run pnpm setup for a detected extension', ['capability:extension.install']),
  judged('why is an extension entrypoint missing', ['capability:extension.status']),
  judged('which extension has no install script', ['capability:extension.status']),
  judged('manage runtime extensions', [
    'capability:extension.status',
    `catalog:${extensionCatalog.id}`,
  ]),
]);

const negativeQueries = Object.freeze([
  'weather forecast for tel aviv',
  'pay an invoice with bitcoin',
]);

const disabledOnly = capability('weather.forecast', 'Forecast weather',
  'Read the current weather forecast for a city.', ['weather', 'forecast']);

const kernel = new RuntimeKernel({
  permissionBroker: createAllowAllPermissionBroker(),
  catalogProviders: [catalogProvider('runtime-benchmark-base-catalog', baseCatalogEntries)],
});
kernel.register(provider('runtime-benchmark-base', baseCapabilities));
const baseItems = [
  ...baseCapabilities.map(capabilityItem),
  ...baseCatalogEntries.map(catalogItem),
];
const quillstoneModes = [
  await createQuillstoneMode('quillstone-bm25', false, baseItems),
  ...(includeHybrid
    ? [await createQuillstoneMode('quillstone-hybrid', true, baseItems)]
    : []),
];

let extensionRegistration;
try {
  const disabledRegistration = await kernel.registerContributions({
    providers: [provider('runtime-benchmark-disabled-extension', [disabledOnly])],
  }, context);
  for (const mode of quillstoneModes) {
    await publishItems(mode, [capabilityItem(disabledOnly)], 'upsert');
  }
  const disabledBeforeRetirement = {
    lexical: (await lexicalSearch(kernel, 'weather forecast')).includes(`capability:${disabledOnly.name}`),
    ...Object.fromEntries(await Promise.all(quillstoneModes.map(async (mode) => [
      mode.name,
      (await quillstoneSearch(mode, 'weather forecast')).includes(`capability:${disabledOnly.name}`),
    ]))),
  };
  disabledRegistration.dispose();
  for (const mode of quillstoneModes) {
    await publishItems(mode, [capabilityItem(disabledOnly)], 'remove');
  }
  const disabledAfterRetirement = {
    lexical: (await lexicalSearch(kernel, 'weather forecast')).includes(`capability:${disabledOnly.name}`),
    ...Object.fromEntries(await Promise.all(quillstoneModes.map(async (mode) => [
      mode.name,
      (await quillstoneSearch(mode, 'weather forecast')).includes(`capability:${disabledOnly.name}`),
    ]))),
  };
  const before = await visibilitySnapshot(kernel, quillstoneModes);
  const kernelEnableStarted = performance.now();
  extensionRegistration = await kernel.registerContributions({
    providers: [provider('runtime-benchmark-extension', extensionCapabilities)],
    catalogProviders: [catalogProvider('runtime-benchmark-extension-catalog', [extensionCatalog])],
  }, context);
  const kernelEnableMs = performance.now() - kernelEnableStarted;
  const indexEnable = [];
  for (const mode of quillstoneModes) {
    indexEnable.push(await publishItems(mode, [
      ...extensionCapabilities.map(capabilityItem),
      catalogItem(extensionCatalog),
    ], 'upsert'));
  }
  const enabled = await visibilitySnapshot(kernel, quillstoneModes);

  const lexical = await benchmarkMode(
    'runtime-search-lexical',
    (query) => lexicalSearch(kernel, query),
    25,
  );
  const indexed = [];
  for (const mode of quillstoneModes) {
    indexed.push(await benchmarkMode(
      mode.name,
      (query) => quillstoneSearch(mode, query),
      mode.hybrid ? 3 : 8,
      { status: mode.status, buildMs: mode.buildMs },
    ));
  }

  const kernelDisableStarted = performance.now();
  extensionRegistration.dispose();
  extensionRegistration = undefined;
  const kernelDisableMs = performance.now() - kernelDisableStarted;
  const indexDisable = [];
  for (const mode of quillstoneModes) {
    indexDisable.push(await publishItems(mode, [
      ...extensionCapabilities.map(capabilityItem),
      catalogItem(extensionCatalog),
    ], 'remove'));
  }
  const after = await visibilitySnapshot(kernel, quillstoneModes);

  console.log(JSON.stringify({
    benchmark: 'runtime-search-lexical-vs-quillstone-v1',
    corpus: {
      baseCapabilities: baseCapabilities.length,
      baseCatalogEntries: baseCatalogEntries.length,
      inventoryDigest: capturedInventory.digest,
      enabledExtensionCapabilities: extensionCapabilities.length,
      enabledExtensionCatalogEntries: 1,
      deliberatelyDisabledCapabilities: [disabledOnly.name],
      queries: qualityQueries.length,
    },
    enablement: {
      before,
      enable: {
        kernelMs: round(kernelEnableMs),
        quillstoneMs: Object.fromEntries(indexEnable.map((duration, index) => [
          quillstoneModes[index].name,
          round(duration),
        ])),
      },
      enabled,
      disable: {
        kernelMs: round(kernelDisableMs),
        quillstoneMs: Object.fromEntries(indexDisable.map((duration, index) => [
          quillstoneModes[index].name,
          round(duration),
        ])),
      },
      after,
      disabledRetirement: {
        before: disabledBeforeRetirement,
        after: disabledAfterRetirement,
      },
    },
    results: [lexical, ...indexed],
  }, null, 2));
} finally {
  extensionRegistration?.dispose();
  await Promise.all(quillstoneModes.map(async (mode) => {
    await mode.index.close();
    await rm(mode.root, { recursive: true, force: true });
  }));
}

function capability(name, title, description, tags) {
  return Object.freeze({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    title,
    description,
    tags: Object.freeze(tags),
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });
}

function provider(id, capabilities) {
  return Object.freeze({
    id,
    version: '1.0.0',
    async list() { return capabilities; },
    async invoke() { return { output: {} }; },
  });
}

function catalogProvider(id, entries) {
  return Object.freeze({
    id,
    async list() { return entries; },
    async get(entryId) { return entries.find((entry) => entry.id === entryId); },
  });
}

function judged(query, relevant) {
  return Object.freeze({ query, relevant: Object.freeze(relevant) });
}

function capabilityItem(value) {
  const title = value.title ?? value.name;
  const tags = value.tags ?? [];
  return {
    id: `capability:${value.name}`,
    title,
    body: [
      `kind capability`,
      `name ${value.name}`,
      `title ${title}`,
      `description ${value.description}`,
      `tags ${tags.join(' ')}`,
    ].join('\n'),
  };
}

function catalogItem(value) {
  const tags = value.tags ?? [];
  return {
    id: `catalog:${value.id}`,
    title: value.title,
    body: [
      'kind catalog skill',
      `id ${value.id}`,
      `title ${value.title}`,
      `description ${value.description}`,
      `tags ${tags.join(' ')}`,
    ].join('\n'),
  };
}

async function captureRuntimeDevelopmentInventory() {
  const parent = benchmarkRootParent();
  const workspacePath = await mkdtemp(path.join(parent, '.qscw-'));
  const protectedLifecycleResultRoot = await mkdtemp(path.join(parent, '.qscp-'));
  let runtime;
  try {
    runtime = await createAgentRuntime({
      workspacePath,
      protectedLifecycleResultRoot,
      extensions: false,
      codeIntelligence: false,
      providerSources: [createRuntimeBuiltinsSource({
        artifacts: true,
        effects: true,
        scheduling: true,
        typescript: true,
        reactUi: true,
        declarativeUi: true,
      })],
    });
    const response = await runtime.kernel.search({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: '',
      detail: 'full',
      limit: 10_000,
    }, {});
    const capabilities = Object.freeze(response.matches.map((match) => {
      const { provider: _provider, ...descriptor } = match.capability;
      return Object.freeze(descriptor);
    }).sort((left, right) => left.name.localeCompare(right.name)));
    const catalogEntries = Object.freeze((response.discoveries ?? [])
      .map((match) => Object.freeze(match.entry))
      .sort((left, right) => left.id.localeCompare(right.id)));
    return Object.freeze({
      capabilities,
      catalogEntries,
      digest: createHash('sha256')
        .update(JSON.stringify({ capabilities, catalogEntries }))
        .digest('hex'),
    });
  } finally {
    await runtime?.dispose();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(protectedLifecycleResultRoot, { recursive: true, force: true });
  }
}

function benchmarkRootParent() {
  return process.env.MARSHAL_RUNTIME_SEARCH_BENCH_ROOT
    ?? (process.platform === 'win32' ? path.parse(process.cwd()).root : tmpdir());
}

async function createQuillstoneMode(name, hybrid, initialItems) {
  const benchmarkParent = benchmarkRootParent();
  const root = await mkdtemp(path.join(benchmarkParent, '.qsb-'));
  const projectRoot = path.join(root, 'project');
  const projectionRoot = path.join(root, 'projections');
  const dataRoot = path.join(root, 'data');
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(projectionRoot, { recursive: true }),
  ]);
  const mode = {
    name,
    hybrid,
    root,
    projectionRoot,
    paths: new Map(),
    identities: new Map(),
    index: new InProcessQuillstoneKnowledgeIndex({
      projectRoot,
      projectionRoot,
      dataRoot,
      indexMode: 'memory-only',
      ...(hybrid ? { embeddingsEnabled: true } : { embeddingProvider: null }),
    }),
  };
  await writeItems(mode, initialItems);
  const started = performance.now();
  mode.status = await mode.index.rebuild();
  mode.buildMs = performance.now() - started;
  return mode;
}

async function writeItems(mode, items) {
  for (const item of items) {
    const filePath = path.join(mode.projectionRoot, `${digest(item.id)}.memory.md`);
    const memoryId = `bench-${digest(item.id)}`;
    await writeFile(filePath, [
      '---',
      `id: ${memoryId}`,
      'scope: runtime-search-benchmark',
      'state: active',
      '---',
      `# ${item.title}`,
      '',
      item.body,
      '',
    ].join('\n'), 'utf8');
    mode.paths.set(item.id, filePath);
    mode.identities.set(memoryId, item.id);
  }
}

async function publishItems(mode, items, operation) {
  const started = performance.now();
  if (operation === 'upsert') {
    await writeItems(mode, items);
    await mode.index.publish(items.map((item) => ({
      operation: 'upsert',
      path: mode.paths.get(item.id),
    })));
  } else {
    const mutations = [];
    for (const item of items) {
      const filePath = mode.paths.get(item.id);
      if (!filePath) continue;
      await unlink(filePath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      mutations.push({
        operation: 'remove',
        path: filePath,
        identity: `bench-${digest(item.id)}`,
      });
      mode.paths.delete(item.id);
    }
    await mode.index.publish(mutations);
  }
  return performance.now() - started;
}

async function lexicalSearch(activeKernel, query) {
  const response = await activeKernel.runtimeSearch({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    query,
    detail: 'summary',
    limit: 10,
  }, context);
  return [
    ...response.matches.map((match) => `capability:${match.capability.name}`),
    ...(response.discoveries ?? []).map((match) => `catalog:${match.entry.id}`),
  ].slice(0, 10);
}

async function quillstoneSearch(mode, query) {
  const response = await mode.index.search({ query, limit: 10 });
  return response.hits.map((hit) => {
    const memoryId = hit.node.memoryId ?? hit.node.name;
    return mode.identities.get(memoryId) ?? memoryId;
  });
}

async function visibilitySnapshot(activeKernel, modes) {
  const lexicalCapability = await lexicalSearch(activeKernel, 'install detected extension');
  const lexicalCatalog = await activeKernel.runtimeSearch({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    query: 'manage runtime extensions',
    limit: 10,
  }, context);
  return {
    lexical: {
      capability: lexicalCapability.includes('capability:extension.install'),
      catalog: (lexicalCatalog.discoveries ?? [])
        .some((match) => match.entry.id === extensionCatalog.id),
    },
    ...Object.fromEntries(await Promise.all(modes.map(async (mode) => {
      const results = await quillstoneSearch(mode, 'install manage runtime extensions');
      return [mode.name, {
        capability: results.includes('capability:extension.install'),
        catalog: results.includes(`catalog:${extensionCatalog.id}`),
      }];
    }))),
  };
}

async function benchmarkMode(name, search, repetitions, indexInfo) {
  const judgedResults = [];
  const coldDurations = [];
  const warmDurations = [];
  for (const entry of qualityQueries) {
    const first = await timed(() => search(entry.query));
    coldDurations.push(first.duration);
    judgedResults.push({
      query: entry.query,
      relevant: entry.relevant,
      rank: firstRelevantRank(first.value, entry.relevant),
      ndcg10: ndcgAt(first.value, entry.relevant, 10),
      top3: first.value.slice(0, 3),
    });
    for (let repeat = 1; repeat < repetitions; repeat += 1) {
      warmDurations.push((await timed(() => search(entry.query))).duration);
    }
  }
  const negativeResults = [];
  for (const query of negativeQueries) {
    const result = await timed(() => search(query));
    coldDurations.push(result.duration);
    negativeResults.push({ query, hitCount: result.value.length, top3: result.value.slice(0, 3) });
  }
  const ranks = judgedResults.map((result) => result.rank);
  return {
    mode: name,
    ...(indexInfo ? {
      index: {
        state: indexInfo.status.state,
        vectorState: indexInfo.status.vectorState,
        generation: indexInfo.status.generation,
        buildMs: round(indexInfo.buildMs),
      },
    } : {}),
    metrics: {
      mrr10: round(mean(ranks.map((rank) => rank > 0 && rank <= 10 ? 1 / rank : 0))),
      ndcg10: round(mean(judgedResults.map((result) => result.ndcg10))),
      recall5: round(mean(ranks.map((rank) => rank > 0 && rank <= 5 ? 1 : 0))),
      zeroRelevantAt10: ranks.filter((rank) => rank === 0 || rank > 10).length,
      negativeQueriesWithHits: negativeResults.filter((result) => result.hitCount > 0).length,
    },
    latencyMs: {
      coldSamples: coldDurations.length,
      coldP50: round(percentile(coldDurations, 0.5)),
      coldP95: round(percentile(coldDurations, 0.95)),
      warmSamples: warmDurations.length,
      warmP50: round(percentile(warmDurations, 0.5)),
      warmP95: round(percentile(warmDurations, 0.95)),
      max: round(Math.max(...coldDurations, ...warmDurations)),
    },
    queries: judgedResults,
    negativeQueries: negativeResults,
  };
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, duration: performance.now() - started };
}

function firstRelevantRank(results, relevant) {
  const set = new Set(relevant);
  const index = results.findIndex((id) => set.has(id));
  return index < 0 ? 0 : index + 1;
}

function ndcgAt(results, relevant, limit) {
  const relevantSet = new Set(relevant);
  let gain = 0;
  for (let index = 0; index < Math.min(results.length, limit); index += 1) {
    if (relevantSet.has(results[index])) gain += 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  for (let index = 0; index < Math.min(relevant.length, limit); index += 1) {
    ideal += 1 / Math.log2(index + 2);
  }
  return ideal === 0 ? 0 : gain / ideal;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function round(value) {
  return Number(value.toFixed(3));
}
