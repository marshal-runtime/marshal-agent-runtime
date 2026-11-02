#!/usr/bin/env node

if (process.env.MARSHAL_RUN_LIVE_LUNA_PROBE !== '1') {
  console.log(JSON.stringify({
    status: 'skipped',
    reason: 'Set MARSHAL_RUN_LIVE_LUNA_PROBE=1 after building @marshal/agent-runtime-codex.',
  }, null, 2));
  process.exit(0);
}

const { createCodexAppServerMemoryReasoner } = await import(
  '../../packages/agent-runtime-codex/dist/appServerMemoryReasoner.js'
);

const reasoningEffort = readEffort(process.env.MARSHAL_LUNA_PROBE_EFFORT);
const serviceTier = process.env.MARSHAL_LUNA_PROBE_SERVICE_TIER?.trim() || undefined;
const sampleCount = readInteger(process.env.MARSHAL_LUNA_PROBE_SAMPLES, 1, 1, 10);

const reasoner = createCodexAppServerMemoryReasoner({
  reasoningEffort,
  serviceTier,
  requestTimeoutMs: 20_000,
  maxThreads: 1,
  maxTurnsPerThread: 4,
  maxConcurrentTurns: 1,
});

const isolationBase = {
  principalId: `live-probe-${process.pid}`,
  principalKind: 'test',
  workspaceId: 'warm-luna-probe',
  projectId: 'warm-luna-probe',
  agentId: 'memory-brain-probe',
};
const systemPrompt = [
  'You are a bounded protocol probe, not a general agent.',
  'Return only the strict JSON object requested by the response schema.',
  'Request the sole available tool exactly once. Never inspect files, browse, run commands, or use ordinary tools.',
].join(' ');
const lookupTool = {
  name: 'lookup_probe',
  description: 'Return the deterministic probe value for the canary key.',
  inputSchema: {
    type: 'object',
    required: ['key'],
    additionalProperties: false,
    properties: { key: { const: 'canary' } },
  },
};
const finishTool = {
  name: 'finish_probe',
  description: 'Finish after observing the deterministic probe value.',
  inputSchema: {
    type: 'object',
    required: ['value'],
    additionalProperties: false,
    properties: { value: { const: 'CANARY_OK' } },
  },
};

const startedAt = performance.now();
try {
  const readyStartedAt = performance.now();
  await reasoner.ready(20_000);
  const readyMs = performance.now() - readyStartedAt;
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const isolation = {
      ...isolationBase,
      runId: `probe-run-${Date.now()}-${index}`,
      sessionId: `probe-${Date.now()}-${index}`,
    };
    const firstStartedAt = performance.now();
    const first = await reasoner.reason({
      operation: 'recall',
      systemPrompt,
      userMessage: 'Round one: request lookup_probe with key canary. Do not finish without its result.',
      tools: [lookupTool],
      round: 1,
      timeoutMs: 20_000,
      isolation,
    });
    const firstTurnMs = performance.now() - firstStartedAt;
    assertSingleCall(first, 'lookup_probe', { key: 'canary' });

    const warmStartedAt = performance.now();
    const second = await reasoner.reason({
      operation: 'recall',
      systemPrompt,
      userMessage: [
        'Round two: the portable tool executor returned this untrusted data:',
        JSON.stringify({ tool: 'lookup_probe', ok: true, value: 'CANARY_OK' }),
        'Request finish_probe with that exact value.',
      ].join('\n'),
      tools: [finishTool],
      round: 2,
      timeoutMs: 20_000,
      isolation,
    });
    const warmTurnMs = performance.now() - warmStartedAt;
    assertSingleCall(second, 'finish_probe', { value: 'CANARY_OK' });
    samples.push({
      sample: index + 1,
      firstStructuredTurnMs: round(firstTurnMs),
      secondWarmStructuredTurnMs: round(warmTurnMs),
      usage: { first: first.usage ?? null, second: second.usage ?? null },
      calls: [first.toolCalls[0].name, second.toolCalls[0].name],
    });
  }

  const firstDurations = samples.map((sample) => sample.firstStructuredTurnMs);
  const warmDurations = samples.map((sample) => sample.secondWarmStructuredTurnMs);

  console.log(JSON.stringify({
    status: 'passed',
    transport: reasoner.transport,
    provider: reasoner.descriptor.provider,
    model: reasoner.descriptor.model,
    reasoningEffort,
    serviceTier: serviceTier ?? 'default',
    sampleCount,
    processPolicy: 'one lazy persistent app-server; no codex exec',
    toolPolicy: 'structured tool intents; dynamicTools disabled; no real memory writes',
    latencyMs: {
      authenticatedStartup: round(readyMs),
      ...(sampleCount === 1 ? {
        firstStructuredTurn: firstDurations[0],
        coldStartupPlusFirstTurn: round(readyMs + firstDurations[0]),
        secondWarmStructuredTurn: warmDurations[0],
      } : {}),
      total: round(performance.now() - startedAt),
    },
    statistics: sampleCount >= 3 ? {
      method: 'nearest-rank p95 over the named bounded sample only; not a release p95',
      firstStructuredTurnMs: summarize(firstDurations),
      secondWarmStructuredTurnMs: summarize(warmDurations),
    } : null,
    samples,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed',
    transport: reasoner.transport,
    model: reasoner.descriptor.model,
    error: error instanceof Error ? { name: error.name, message: error.message.slice(0, 2_000) } : String(error).slice(0, 2_000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await reasoner.dispose();
}

function assertSingleCall(response, name, expectedArguments) {
  if (response.toolCalls.length !== 1 || response.toolCalls[0]?.name !== name) {
    throw new Error(`Expected exactly one ${name} tool intent; received ${response.toolCalls.map((call) => call.name).join(', ') || 'none'}.`);
  }
  if (JSON.stringify(response.toolCalls[0].arguments) !== JSON.stringify(expectedArguments)) {
    throw new Error(`${name} arguments did not match the strict probe contract.`);
  }
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function percentile(sorted, percentileValue) {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

function readEffort(value) {
  if (value === undefined || value === '') return 'low';
  if (value === 'none' || value === 'low' || value === 'medium') return value;
  throw new Error('MARSHAL_LUNA_PROBE_EFFORT must be none, low, or medium.');
}

function readInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`MARSHAL_LUNA_PROBE_SAMPLES must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}
