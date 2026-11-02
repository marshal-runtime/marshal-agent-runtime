import assert from 'node:assert/strict';
import test from 'node:test';

import { createKnowledgeIndexProvider } from '../dist/knowledge.js';

const CONTEXT = { principal: { id: 'host', kind: 'agent' } };
const FILE = { id: 'code:sql/load.sql', kind: 'code_file', name: 'load.sql', path: 'sql/load.sql' };
const MEMORY = { id: 'memory:x', kind: 'memory', name: 'x', memoryId: 'x', scope: 'project', state: 'active' };

const recordingIndex = (entries = [{ node: FILE, table: 'File', language: 'SQL' }]) => {
  const seen = [];
  const base = {
    search: async () => { throw new Error('unused'); },
    context: async () => { throw new Error('unused'); },
    impact: async () => { throw new Error('unused'); },
    detectChanges: async () => { throw new Error('unused'); },
    upsertDocument: async () => { throw new Error('unused'); },
    removeDocument: async () => { throw new Error('unused'); },
    status: async () => ({ state: 'ready', engine: 'fake', generation: 1, nodeCount: 0 }),
  };
  return {
    seen,
    base,
    index: {
      ...base,
      query: async (request, options) => {
        seen.push({ request, options });
        return { entries, total: 7, more: false, generation: 3, truncated: false };
      },
    },
  };
};

const descriptorOf = (provider, name) => provider.list?.(CONTEXT)?.find?.((entry) => entry.name === name);

test('Sanity: the filter reaches the index as parsed and the answer comes back with the exact total', async () => {
  const { index, seen } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  const { output } = await provider.invoke('knowledge.query', {
    nodeKinds: ['File'],
    languages: ['SQL'],
    pathPrefix: ' sql/ ',
    outline: { namePrefixes: ['INSERT INTO', 'MERGE INTO'], name: 'events' },
    relations: [{ type: 'CALLS', direction: 'incoming', min: 2, otherName: 'run' }],
    groupBy: 'directory',
    directoryDepth: 2,
    limit: 0,
  }, CONTEXT);
  assert.deepEqual(seen[0].request, {
    nodeKinds: ['File'],
    languages: ['SQL'],
    pathPrefix: 'sql/',
    outline: { name: 'events', namePrefixes: ['INSERT INTO', 'MERGE INTO'] },
    relations: [{ type: 'CALLS', direction: 'incoming', min: 2, otherName: 'run' }],
    groupBy: 'directory',
    directoryDepth: 2,
    limit: 0,
  });
  assert.equal(output.total, 7);
  assert.equal(output.entries[0].table, 'File');
});

test('Error Handling: a malformed filter is rejected before the index is asked', async () => {
  const { index, seen } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  const rejected = [
    { groupBy: 'author' },
    { limit: 5_000 },
    { limit: -1 },
    { nodeKinds: 'File' },
    { relations: [{ type: 'calls', direction: 'incoming' }] },
    { relations: [{ type: 'CALLS', direction: 'sideways' }] },
    { relations: new Array(9).fill({ type: 'CALLS', direction: 'incoming' }) },
    { outline: { namePrefixes: ['INSERT INTO'] } },
    { directoryDepth: 0 },
  ];
  for (const input of rejected) {
    await assert.rejects(() => provider.invoke('knowledge.query', input, CONTEXT), undefined, JSON.stringify(input));
  }
  assert.equal(seen.length, 0);
});

test('Edge Cases: an index without a query leaves the capability out, and non-code entries never reach the answer', async () => {
  const { base } = recordingIndex();
  assert.equal(descriptorOf(createKnowledgeIndexProvider(base), 'knowledge.query'), undefined);
  const { index } = recordingIndex([
    { node: FILE, table: 'File' },
    { node: MEMORY, table: 'Memory' },
  ]);
  const provider = createKnowledgeIndexProvider(index);
  assert.ok(descriptorOf(provider, 'knowledge.query'));
  const { output } = await provider.invoke('knowledge.query', {}, CONTEXT);
  assert.deepEqual(output.entries.map((entry) => entry.node.id), [FILE.id]);
});

test('Edge Cases: the caller the host set reaches the index', async () => {
  const { index, seen } = recordingIndex();
  const provider = createKnowledgeIndexProvider(index);
  await provider.invoke('knowledge.query', {}, { principal: { id: 'host', kind: 'agent', claims: { callerEmail: 'user@example.com' } } });
  assert.equal(seen[0].options.caller, 'user@example.com');
});
