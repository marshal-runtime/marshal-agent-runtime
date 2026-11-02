import assert from 'node:assert/strict';
import test from 'node:test';

import { createKnowledgeIndexProvider } from '../dist/knowledge.js';

const OMER = 'user@example.com';
const withClaims = (claims) => ({ principal: { id: 'host', kind: 'agent', ...(claims ? { claims } : {}) } });

const recordingIndex = () => {
  const seen = { search: [], context: [], impact: [], status: [] };
  const empty = { generation: 1, truncated: false };
  return {
    seen,
    index: {
      search: async (request, options) => {
        seen.search.push({ request, options });
        return { hits: [], ...empty };
      },
      context: async (request, options) => {
        seen.context.push({ request, options });
        return { target: null, nodes: [], paths: [], ...empty };
      },
      impact: async (request, options) => {
        seen.impact.push({ request, options });
        return { target: null, nodes: [], paths: [], direction: 'inbound', maxDepth: 2, ...empty };
      },
      detectChanges: async () => { throw new Error('unused'); },
      upsertDocument: async () => { throw new Error('unused'); },
      removeDocument: async () => { throw new Error('unused'); },
      status: async (options) => {
        seen.status.push({ options });
        return { state: 'ready', engine: 'fake', generation: 1, nodeCount: 0, entityCount: 3 };
      },
    },
  };
};

test('Sanity: the host-set caller reaches search, context, impact and status, and entityTypes reaches search', async () => {
  const { index, seen } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  const context = withClaims({ callerEmail: OMER });
  await provider.invoke('knowledge.search', { query: 'lease', kinds: ['entity'], entityTypes: ['ticket', 'pull_request'] }, context);
  await provider.invoke('knowledge.context', { target: { kind: 'node', id: 'entity:ticket/INF-1' } }, context);
  await provider.invoke('knowledge.impact', { target: { kind: 'node', id: 'entity:ticket/INF-1' }, direction: 'inbound' }, context);
  await provider.invoke('knowledge.status', {}, context);
  assert.deepEqual(seen.search[0].request.kinds, ['entity']);
  assert.deepEqual(seen.search[0].request.entityTypes, ['ticket', 'pull_request']);
  for (const calls of [seen.search, seen.context, seen.impact, seen.status]) {
    assert.equal(calls[0].options.caller, OMER);
  }
});

test('Error Handling: the model cannot name the caller, and malformed entity types are rejected', async () => {
  const { index, seen } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  const context = withClaims({ callerEmail: OMER });
  await provider.invoke('knowledge.search', { query: 'x', caller: 'dana@example.com' }, context);
  assert.equal(seen.search[0].options.caller, OMER, 'a caller in the arguments is ignored');
  seen.search.length = 0;
  await assert.rejects(
    () => provider.invoke('knowledge.search', { query: 'x', entityTypes: ['Ticket; drop'] }, context),
    /entityTypes must be a list of lower snake case entity type names/u,
  );
  await assert.rejects(
    () => provider.invoke('knowledge.search', { query: 'x', entityTypes: 'ticket' }, context),
    /bounded string array/u,
  );
  assert.equal(seen.search.length, 0);
});

test('Edge Cases: no caller claim means no caller option, and the entity kind is accepted', async () => {
  const { index, seen } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  await provider.invoke('knowledge.search', { query: 'x', kinds: ['entity', 'memory'] }, withClaims());
  await provider.invoke('knowledge.search', { query: 'x' }, withClaims({ callerEmail: '' }));
  await provider.invoke('knowledge.status', {}, withClaims({ callerEmail: 42 }));
  assert.equal(seen.search[0].options, undefined);
  assert.equal(seen.search[1].options, undefined);
  assert.equal(seen.status[0].options, undefined);
  assert.equal(
    provider.list?.(withClaims())?.find?.((d) => d.name === 'knowledge.search')?.inputSchema?.properties?.caller,
    undefined,
    'the search schema has no caller argument',
  );
});

test('Sanity: ids reaches search as a candidate set, an empty list included', async () => {
  const { index, seen } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  const context = withClaims({ callerEmail: OMER });
  await provider.invoke('knowledge.search', { query: 'lease', ids: ['entity:ticket/INF-1', ' entity:pull_request/7 '] }, context);
  await provider.invoke('knowledge.search', { query: 'lease', ids: [] }, context);
  await provider.invoke('knowledge.search', { query: 'lease' }, context);
  assert.deepEqual(seen.search[0].request.ids, ['entity:ticket/INF-1', 'entity:pull_request/7']);
  assert.deepEqual(seen.search[1].request.ids, []);
  assert.equal('ids' in seen.search[2].request, false, 'no ids means an unbounded search');
});

test('Error Handling: malformed ids are rejected before the index is asked', async () => {
  const { index, seen } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  const context = withClaims({ callerEmail: OMER });
  for (const ids of ['entity:ticket/INF-1', [''], [42], Array(5001).fill('entity:ticket/INF-1')]) {
    await assert.rejects(
      () => provider.invoke('knowledge.search', { query: 'x', ids }, context),
      /bounded string array|bounded non-empty string/u,
    );
  }
  assert.equal(seen.search.length, 0);
});

test('Edge Cases: the search schema documents ids as a bounded array of strings', () => {
  const provider = createKnowledgeIndexProvider(recordingIndex().index);
  const ids = provider.list?.(withClaims())?.find?.((d) => d.name === 'knowledge.search')?.inputSchema?.properties?.ids;
  assert.equal(ids?.type, 'array');
  assert.equal(ids?.maxItems, 5000);
  assert.equal(ids?.items?.type, 'string');
});

test('knowledge.impact_many answers each target as knowledge.impact would alone, in order, and a failing target fails alone', async () => {
  const seen = [];
  const { index } = recordingIndex();
  index.impact = async (request, options) => {
    seen.push({ request, options });
    if (request.target.id === 'missing') throw new Error('no match for missing');
    return { target: null, nodes: [], paths: [], direction: request.direction, maxDepth: request.maxDepth, generation: 1, truncated: false };
  };
  const provider = createKnowledgeIndexProvider(index);
  const context = withClaims({ callerEmail: OMER });
  const targets = [{ kind: 'node', id: 'a' }, { kind: 'node', id: 'missing' }, { kind: 'node', id: 'c' }];
  const answer = await provider.invoke('knowledge.impact_many', { targets, direction: 'both', maxDepth: 1, limit: 100, edgeTypes: ['CALLS'] }, context);
  const results = answer.output.results;
  assert.deepEqual(results.map((entry) => entry.ok), [true, false, true]);
  assert.equal(results[1].error, 'no match for missing');
  const single = await provider.invoke('knowledge.impact', { target: targets[0], direction: 'both', maxDepth: 1, limit: 100, edgeTypes: ['CALLS'] }, context);
  assert.deepEqual(results[0].output, single.output);
  assert.deepEqual(seen.slice(0, 3).map((call) => call.request.target.id), ['a', 'missing', 'c']);
  assert.ok(seen.every((call) => call.options.caller === OMER));
  assert.deepEqual(seen[0].request.edgeTypes, ['CALLS']);
});

test('knowledge.impact_many rejects an empty or oversized target list', async () => {
  const { index } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  await assert.rejects(() => provider.invoke('knowledge.impact_many', { targets: [], direction: 'both' }, withClaims()), /targets/u);
  await assert.rejects(
    () => provider.invoke('knowledge.impact_many', { targets: Array.from({ length: 101 }, (_, at) => ({ kind: 'node', id: `n${at}` })), direction: 'both' }, withClaims()),
    /targets/u,
  );
});

test('knowledge.impact_many entries are validated by the same fields as knowledge.impact', () => {
  const provider = createKnowledgeIndexProvider(recordingIndex().index);
  const { $defs, ...single } = provider.get('knowledge.impact').outputSchema;
  const many = provider.get('knowledge.impact_many').outputSchema;
  assert.deepEqual(many.properties.results.items.properties.output, single);
  assert.deepEqual(many.$defs, $defs);
});
