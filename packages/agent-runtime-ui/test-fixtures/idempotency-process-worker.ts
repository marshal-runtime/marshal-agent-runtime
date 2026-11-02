import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InvocationContext, UiActionIdempotencyRecord } from '../src/index.js';
import { ReactUiStore } from '../src/index.js';

const [storageRoot, coordinationRoot, counterPath, key, requestDigest, workerId] = process.argv.slice(2);
if (!storageRoot || !coordinationRoot || !counterPath || !key || !requestDigest || !workerId) {
  throw new Error('Missing idempotency worker argument');
}

const context: InvocationContext = {
  principal: { id: 'agent', kind: 'agent' },
  scope: { workspaceId: 'workspace', projectId: 'project', sessionId: 'session' },
};
const store = new ReactUiStore({ storageRoot });
await mkdir(coordinationRoot, { recursive: true });
await writeFile(join(coordinationRoot, `ready-${workerId}`), '', { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ status: 'ready', workerId })}\n`);
while (!(await exists(join(coordinationRoot, 'start')))) await delay(5);

for (;;) {
  const claim = await store.claim(key, 'project', requestDigest, 5_000, context);
  if (claim.status === 'busy') {
    await delay(Math.max(1, Math.min(10, claim.retryAfterMs)));
    continue;
  }
  if (claim.status === 'replay') {
    process.stdout.write(`${JSON.stringify({ status: 'replay', workerId })}\n`);
    break;
  }

  await appendFile(counterPath, `${workerId}\n`, 'utf8');
  await delay(200);
  await store.complete(key, 'project', claim.lease, completedRecord(requestDigest, key, workerId), context);
  process.stdout.write(`${JSON.stringify({ status: 'acquired', workerId })}\n`);
  break;
}

function completedRecord(digest: string, idempotencyKey: string, id: string): UiActionIdempotencyRecord {
  const timestamp = new Date().toISOString();
  return {
    requestDigest: digest,
    result: {
      status: 'success',
      output: { workerId: id },
      receipt: {
        receiptId: `receipt-${id}`,
        renderId: '1'.repeat(64),
        actionId: 'exactly-once',
        actionVersion: '1.0.0',
        target: { kind: 'capability', capability: 'test.execute' },
        scope: 'project',
        principalId: 'agent',
        idempotencyKey,
        requestDigest: digest,
        permission: { decision: 'allow', grants: ['test.execute'] },
        status: 'success',
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
      },
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
