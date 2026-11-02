import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DirectTypeScriptExecutor, type RuntimeCapabilityBroker } from '../src/index.js';

/**
 * Executes the ACTUAL shipped example (examples/agent-authored/triage-report.ts)
 * through the real brokered TypeScript executor against an EXPLICIT FIXTURE
 * capability provider. `triage.items.list` is NOT a production capability —
 * the fixture declares a validated descriptor for it, exactly as the example's
 * own header documents. Every port is observable: the broker records an
 * ordered call log, so the assertions are about real executed sequence, not
 * self-reported success.
 */

const examplePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/agent-authored/triage-report.ts',
);

const LIST_CAPABILITY = 'triage.items.list';
const NOTIFY_OWNER = { extensionId: 'marshal.examples', applicationId: 'triage-report' };

interface LogEntry {
  kind: 'search' | 'invoke';
  target: string;
  input?: unknown;
}

function fixtureBroker(overrides?: {
  descriptorDeclaresItems?: boolean;
  itemsResponse?: unknown;
  renderFails?: boolean;
  notificationsFail?: boolean;
}): { broker: RuntimeCapabilityBroker; log: LogEntry[] } {
  const log: LogEntry[] = [];
  const declaresItems = overrides?.descriptorDeclaresItems ?? true;
  const itemsResponse = overrides?.itemsResponse ?? {
    items: [
      { id: 'a-1', severity: 'high' },
      { id: 'a-2', severity: 'high' },
      { id: 'b-1', severity: 'low' },
      { id: 'broken' }, // no severity — must be counted invalid, not dropped silently
    ],
  };
  const broker: RuntimeCapabilityBroker = {
    search: async (query) => {
      const name = (query as { name?: string } | null)?.name ?? '';
      log.push({ kind: 'search', target: name || JSON.stringify(query) });
      if (name !== LIST_CAPABILITY) return { matches: [] };
      return {
        matches: [{
          capability: {
            name: LIST_CAPABILITY,
            description: 'FIXTURE: lists open triage items (test-only capability).',
            inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
            outputSchema: declaresItems
              ? { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] }
              : { type: 'object', properties: { rows: { type: 'array' } } },
          },
          score: 1,
        }],
      };
    },
    invoke: async (capability, input) => {
      log.push({ kind: 'invoke', target: capability, input });
      if (capability === LIST_CAPABILITY) return itemsResponse;
      if (capability === 'ui.render') {
        if (overrides?.renderFails) throw new Error('ui.render rejected by fixture');
        return { render: { id: 'c'.repeat(64) } };
      }
      if (capability === 'ui.renders.get') return { render: { id: 'c'.repeat(64) } };
      if (capability === 'ui.notification.show') {
        if (overrides?.notificationsFail) throw new Error('notifications unavailable');
        return { receipt: { action: 'notification.show', status: 'applied' } };
      }
      throw new Error(`Fixture has no capability ${capability}`);
    },
  };
  return { broker, log };
}

async function runExample(
  broker: RuntimeCapabilityBroker,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const source = await readFile(examplePath, 'utf8');
  const result = await new DirectTypeScriptExecutor().execute({ source, input }, { broker });
  expect(result.ok, JSON.stringify(result.error ?? {})).toBe(true);
  return (result as { value: Record<string, unknown> }).value;
}

const baseInput = {
  runKey: 'run-1',
  listCapability: LIST_CAPABILITY,
  componentId: 'd'.repeat(64),
  notifyOwner: NOTIFY_OWNER,
};

describe('agent-composed workflow example (real executor, observable ports)', () => {
  it('inspects the full descriptor before invoking, notifies mid-work, prepares UI, and reports partial for invalid rows', async () => {
    const { broker, log } = fixtureBroker();
    const value = await runExample(broker, baseInput);

    // Ordered sequence: exact-name schema lookup strictly precedes the data
    // invoke; the mid-work notification lands between fetch and render.
    const sequence = log.map((entry) => `${entry.kind}:${entry.target}`);
    const schemaLookup = sequence.indexOf(`search:${LIST_CAPABILITY}`);
    const fetchCall = sequence.indexOf(`invoke:${LIST_CAPABILITY}`);
    const fetchedNote = log.findIndex(
      (entry) => entry.kind === 'invoke' && entry.target === 'ui.notification.show'
        && (entry.input as { idempotencyKey?: string }).idempotencyKey === 'triage-run-1-fetched',
    );
    const render = sequence.indexOf('invoke:ui.render');
    const retrievability = sequence.indexOf('invoke:ui.renders.get');
    expect(schemaLookup).toBeGreaterThanOrEqual(0);
    expect(fetchCall).toBeGreaterThan(schemaLookup);
    expect(fetchedNote).toBeGreaterThan(fetchCall);
    expect(render).toBeGreaterThan(fetchedNote);
    expect(retrievability).toBeGreaterThan(render);

    // The idempotency key sits INSIDE the capability input (host schema),
    // with the owner fields — there is no broker-level key parameter.
    const notification = log.find((entry) => entry.target === 'ui.notification.show')!;
    expect(notification.input).toMatchObject({ ...NOTIFY_OWNER, idempotencyKey: 'triage-run-1-fetched' });

    // Result semantics: one invalid row → partial, never silent success;
    // UI is 'prepared' (retrievable), explicitly NOT delivered/visible.
    expect(value).toMatchObject({
      status: 'partial',
      itemCount: 3,
      invalidItemCount: 1,
      notifications: { sent: 2, failed: 0 },
      ui: { status: 'prepared', renderId: 'c'.repeat(64) },
    });
    expect((value.ui as { delivery: string }).delivery).toContain('Not yet visible');
    expect(value.summary).toEqual([
      { severity: 'high', count: 2, ids: ['a-1', 'a-2'] },
      { severity: 'low', count: 1, ids: ['b-1'] },
    ]);
  });

  it('refuses to invoke a capability whose descriptor does not declare the needed output', async () => {
    const { broker, log } = fixtureBroker({ descriptorDeclaresItems: false });
    const value = await runExample(broker, baseInput);
    expect(value).toMatchObject({ status: 'failed', stage: 'discovery' });
    expect(log.some((entry) => entry.kind === 'invoke' && entry.target === LIST_CAPABILITY)).toBe(false);
  });

  it('treats an invalid response as a structured fetch failure, never an empty success', async () => {
    const { broker } = fixtureBroker({ itemsResponse: { rows: [] } });
    const value = await runExample(broker, baseInput);
    expect(value).toMatchObject({ status: 'failed', stage: 'fetch' });
    expect(value.summary).toBeUndefined();
  });

  it('degrades to partial with the render error recorded when ui.render fails', async () => {
    const { broker, log } = fixtureBroker({ renderFails: true });
    const value = await runExample(broker, baseInput);
    expect(value).toMatchObject({
      status: 'partial',
      itemCount: 3,
      ui: { status: 'failed', error: expect.stringContaining('ui.render rejected') },
    });
    // The failure was surfaced to the user through a notification too.
    expect(log.filter((entry) => entry.target === 'ui.notification.show')).toHaveLength(3);
  });

  it('never fails the run on notification failures; they are counted honestly', async () => {
    const { broker } = fixtureBroker({ notificationsFail: true });
    const value = await runExample(broker, baseInput);
    expect(value).toMatchObject({
      notifications: { sent: 0, failed: 2 },
      ui: { status: 'prepared' },
    });
  });
});
