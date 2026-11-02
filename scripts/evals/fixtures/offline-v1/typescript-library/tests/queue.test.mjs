import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForWork } from '../src/queue.mjs';

test('resolves with worker output', async () => {
  let complete;
  const pending = waitForWork(new AbortController().signal, (callback) => { complete = callback; });
  complete('done');
  assert.equal(await pending, 'done');
});
