/**
 * Agent-authored brokered TypeScript example for Marshal Runtime.
 *
 * Executed with runtimeExecuteTypeScript (source = this file's text) or saved
 * to the workspace and run via runtimeExecuteModule
 * { module: { kind: "workspace_file", path: "triage-report.ts" } }.
 *
 * Ambient API (exactly two methods, verified against the executor bridge):
 *   context.runtime.search(query)             — capability discovery
 *   context.runtime.invoke(capability, input) — returns output, throws on failure
 * There is no Node authority, and NO per-call idempotency parameter at this
 * layer — idempotency keys exist only where a capability's own input schema
 * declares them (the host ui.* capabilities declare `idempotencyKey` inside
 * their input, alongside owner fields `extensionId`/`applicationId`).
 *
 * Capability inventory used here:
 *   - `input.listCapability` — the data source. NOT a production capability:
 *     the caller (or test fixture) must supply its name, and this script
 *     verifies its full descriptor before invoking. Do not hardcode or guess.
 *   - `ui.render`, `ui.renders.get` — portable React UI capabilities
 *     (portable.react-ui provider, verified in this repository).
 *   - `ui.notification.show` — a HOST capability (present when running under
 *     the Marshal host; absent in a bare portable runtime). Best-effort here.
 *
 * Honesty rules this example demonstrates:
 *   - inspect the full capability descriptor (exact-name search) BEFORE the
 *     first invoke — never accept a ranked match blindly;
 *   - an invalid response is a structured failure, never silently coerced to
 *     an empty dataset reported as success;
 *   - a prepared render is NOT visible UI: the render becomes visible only
 *     when a host surface delivers it (render tool payload / host open step);
 *     this script verifies retrievability via ui.renders.get and reports the
 *     UI stage as `prepared`, never `delivered`;
 *   - if the requested rendering fails, the overall status is `partial`,
 *     with the error recorded — not silent success.
 */
interface TriageInput {
  runKey: string;
  listCapability: string;
  componentId?: string;
  notifyOwner?: { extensionId: string; applicationId: string };
}

interface TriageItem {
  id: string;
  severity: string;
}

type SearchResponse = {
  matches?: ReadonlyArray<{
    capability?: {
      name?: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    };
  }>;
} | null;

export default async (input: TriageInput, context: {
  runtime: {
    search(query: unknown): Promise<unknown>;
    invoke(capability: string, input: unknown): Promise<unknown>;
  };
}) => {
  const notifications = { sent: 0, failed: 0 };
  const notify = async (message: string, tag: string) => {
    if (!input.notifyOwner) return;
    try {
      // Host capability; input-level idempotencyKey per its schema. A failed
      // notification is recorded but never fails the run.
      await context.runtime.invoke('ui.notification.show', {
        ...input.notifyOwner,
        title: 'Triage report',
        message,
        idempotencyKey: `triage-${input.runKey}-${tag}`,
      });
      notifications.sent += 1;
    } catch {
      notifications.failed += 1;
    }
  };

  // 1. Inspect the data capability's FULL descriptor before invoking it.
  //    Exact-name search returns full detail; a ranked broad match is never
  //    accepted blindly.
  if (typeof input.listCapability !== 'string' || !input.listCapability) {
    return { status: 'failed', stage: 'discovery', error: 'listCapability is required.' };
  }
  const lookup = (await context.runtime.search({ name: input.listCapability })) as SearchResponse;
  const descriptor = lookup?.matches?.find(
    (match) => match.capability?.name === input.listCapability,
  )?.capability;
  if (!descriptor) {
    return {
      status: 'failed',
      stage: 'discovery',
      error: `Capability "${input.listCapability}" was not found by exact-name search.`,
    };
  }
  const outputProperties = (descriptor.outputSchema?.properties ?? {}) as Record<string, unknown>;
  if (!('items' in outputProperties)) {
    return {
      status: 'failed',
      stage: 'discovery',
      error: `Capability "${input.listCapability}" does not declare an items output; refusing to guess its contract.`,
    };
  }

  // 2. Fetch and STRICTLY validate. Invalid data is a failure, not [].
  const raw = (await context.runtime.invoke(input.listCapability, { limit: 50 })) as {
    items?: unknown;
  };
  if (!Array.isArray(raw?.items)) {
    return {
      status: 'failed',
      stage: 'fetch',
      error: `Capability "${input.listCapability}" returned no items array.`,
      notifications,
    };
  }
  const items: TriageItem[] = [];
  const invalidItems: unknown[] = [];
  for (const item of raw.items) {
    const candidate = item as TriageItem;
    if (typeof candidate?.id === 'string' && typeof candidate?.severity === 'string') {
      items.push(candidate);
    } else {
      invalidItems.push(item);
    }
  }
  await notify(`Fetched ${items.length} items; classifying…`, 'fetched');

  // 3. Transform: group by severity with bounded samples.
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    const bucket = grouped.get(item.severity) ?? [];
    bucket.push(item.id);
    grouped.set(item.severity, bucket);
  }
  const summary = [...grouped.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([severity, ids]) => ({ severity, count: ids.length, ids: ids.slice(0, 5) }));

  // 4. Prepare the UI when a compiled component was supplied. `prepared`
  //    means the render exists and is retrievable — visibility requires the
  //    host delivery step (render tool payload / host surface open), which is
  //    outside this brokered script.
  let ui:
    | { status: 'prepared'; renderId: string; delivery: string }
    | { status: 'failed'; error: string }
    | { status: 'skipped' } = { status: 'skipped' };
  if (input.componentId) {
    try {
      const rendered = (await context.runtime.invoke('ui.render', {
        componentId: input.componentId,
        props: { summary, generatedAt: `run ${input.runKey}` },
        fallback: { summary: `Triage: ${items.length} open items` },
      })) as { render?: { id?: string } };
      const renderId = rendered?.render?.id;
      if (typeof renderId !== 'string' || !renderId) {
        throw new Error('ui.render returned no render id.');
      }
      // Verify retrievability — the strongest deliverability check available
      // from inside the brokered script.
      await context.runtime.invoke('ui.renders.get', { renderId });
      ui = {
        status: 'prepared',
        renderId,
        delivery:
          'Not yet visible: deliver via the render tool payload (marshal_get_react_payload) or a host surface open step.',
      };
    } catch (error) {
      ui = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
      await notify(`Render failed: ${ui.error}`, 'render-failed');
    }
  }

  await notify(
    `Triage ${ui.status === 'failed' ? 'partially ' : ''}complete: ${items.length} items across ${summary.length} severities.`,
    'complete',
  );
  return {
    status: ui.status === 'failed' || invalidItems.length > 0 ? 'partial' : 'complete',
    itemCount: items.length,
    invalidItemCount: invalidItems.length,
    summary,
    ui,
    notifications,
  };
};
