import assert from 'node:assert/strict';
import test from 'node:test';

import { createKnowledgeIndexProvider } from '../dist/knowledge.js';

const context = { principal: { id: 'agent-1', kind: 'agent' } };

const code = (name) => ({ id: `symbol:${name}`, kind: 'symbol', name, path: `src/${name}.ts` });
const memory = (memoryId) => ({
  id: `Memory:${memoryId}`,
  kind: 'memory',
  name: memoryId,
  memoryId,
  scope: 'scope-0123456789abcdef',
  state: 'active',
});

const indexOver = (nodes) => ({
  search: async (request) => {
    const offset = request.offset ?? 0;
    const page = nodes.slice(offset, offset + request.limit);
    return {
      hits: page.map((node, position) => ({ node, rank: offset + position + 1, explanationPaths: [] })),
      generation: 7,
      truncated: offset + page.length < nodes.length,
    };
  },
  context: async () => { throw new Error('unused'); },
  impact: async () => { throw new Error('unused'); },
  detectChanges: async () => { throw new Error('unused'); },
  upsertDocument: async () => { throw new Error('unused'); },
  removeDocument: async () => { throw new Error('unused'); },
  status: async () => ({ state: 'ready', engine: 'fake', generation: 7, nodeCount: nodes.length }),
});

test('the authorizer of one search page gets one shared batch with every memory id of the page primed first', async () => {
  const nodes = [code('alpha'), memory('m-1'), memory('m-2'), code('beta'), memory('m-3')];
  const calls = [];
  const authorize = async (node, _context, batch) => {
    calls.push({ id: node.id, batch, idsAtCall: batch ? [...batch.ids] : undefined });
    return node;
  };
  const provider = createKnowledgeIndexProvider(indexOver(nodes), undefined, authorize);
  const { output } = await provider.invoke('knowledge.search', { query: 'release', limit: 10 }, context);

  assert.deepEqual(output.hits.map(({ node }) => node.name), ['alpha', 'm-1', 'm-2', 'beta', 'm-3']);
  assert.equal(calls.length, 3, 'only memory nodes reach the authorizer');
  const [first] = calls;
  assert.ok(calls.every(({ batch }) => batch === first.batch), 'all authorizations of the page share one batch object');
  assert.deepEqual(first.idsAtCall, ['m-1', 'm-2', 'm-3'], 'the whole page is primed before the first hit is authorized');
});

test('an authorizer that ignores the batch still works, and the batch memo survives across the page', async () => {
  const nodes = [memory('a'), memory('b')];
  const seen = [];
  const authorize = async (node, _context, batch) => {
    batch.memo ??= { reads: 0 };
    batch.memo.reads += 1;
    seen.push(batch.memo.reads);
    return node;
  };
  const provider = createKnowledgeIndexProvider(indexOver(nodes), undefined, authorize);
  await provider.invoke('knowledge.search', { query: 'x', limit: 10 }, context);
  assert.deepEqual(seen, [1, 2]);

  const plain = createKnowledgeIndexProvider(indexOver(nodes), undefined, async (node) => node);
  const { output } = await plain.invoke('knowledge.search', { query: 'x', limit: 10 }, context);
  assert.equal(output.hits.length, 2);
});
