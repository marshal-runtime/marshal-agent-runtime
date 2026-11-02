/**
 * Agent-authored React example for Marshal Runtime.
 *
 * Compiled with: ui.compile { entryPath: "StatusPanel.tsx", title: "Triage status" }
 * Rendered with: ui.render  { componentId, props: { summary, generatedAt },
 *                             fallback: { summary: "Triage status panel" },
 *                             application: <manifest — see agentAuthoredExample.spec.ts> }
 *
 * The default export receives the props passed to ui.render plus, when the
 * render carries an application manifest, a `marshal` client
 * (MarshalUiClient): callAction / callTool / bindActionControl /
 * requestDisplayMode / subscribe. Only manifest-declared action and tool IDs
 * are callable — the renderer bridge rejects everything else.
 */
import { useCallback, useEffect, useState } from 'react';

interface SeverityRow {
  severity: string;
  count: number;
  ids: readonly string[];
}

interface StatusPanelProps {
  summary?: readonly SeverityRow[];
  generatedAt?: string;
  marshal?: {
    callAction(
      actionId: string,
      input: unknown,
      options: { scope: string; idempotencyKey?: string },
    ): Promise<unknown>;
    bindActionControl(
      actionId: string,
      handler: (activation: { signal: AbortSignal; requestId: string; actionId: string }) => Promise<unknown>,
    ): () => void;
    requestDisplayMode(mode: 'inline' | 'fullscreen' | 'pip'): Promise<{ status: string }>;
  };
}

/**
 * Idempotency-key policy for a user-intent action: every NEW intent (a fresh
 * click) gets a fresh key so repeated refreshes are all honored; a RETRY of a
 * failed attempt reuses the pending key so the runtime can deduplicate the
 * retry instead of double-applying. Exported for direct unit testing.
 */
export function nextActionKey(
  pendingKey: string | undefined,
  generate: () => string,
): string {
  return pendingKey ?? generate();
}

export default function StatusPanel({ summary = [], generatedAt, marshal }: StatusPanelProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Set while an attempt is in flight or after it failed; cleared on success,
  // so the next click is a new intent with a new key.
  const [pendingKey, setPendingKey] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!marshal || busy) return;
    setBusy(true);
    // "refresh-triage" is declared in the application manifest; the bridge
    // enforces that. Key policy: new intent → new key; retry of a failed
    // attempt → same key (deduplicated by the runtime), never a fixed key
    // that would swallow every future refresh.
    const idempotencyKey = nextActionKey(
      pendingKey,
      () => `refresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    setPendingKey(idempotencyKey);
    try {
      await marshal.callAction('refresh-triage', {}, { scope: 'session', idempotencyKey });
      setPendingKey(undefined);
      setNote('Refresh requested.');
    } catch (error) {
      // Keep pendingKey so a retry deduplicates against this failed attempt.
      setNote(`Refresh failed (retry uses the same request): ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [marshal, busy, pendingKey]);

  useEffect(() => {
    // Bind the manifest-declared action so the renderer's portable chrome can
    // invoke it too; return the unbind function for teardown.
    if (!marshal) return;
    return marshal.bindActionControl('refresh-triage', async () => refresh());
  }, [marshal, refresh]);

  const total = summary.reduce((sum, row) => sum + row.count, 0);
  return (
    <main data-testid="status-panel" style={{ padding: 12, fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ margin: '0 0 8px' }}>Triage status</h2>
      <p data-testid="status-total">{total} open items{generatedAt ? ` · ${generatedAt}` : ''}</p>
      <table>
        <thead>
          <tr><th align="left">Severity</th><th align="right">Count</th><th align="left">Sample</th></tr>
        </thead>
        <tbody>
          {summary.map((row) => (
            <tr key={row.severity} data-testid={`severity-${row.severity}`}>
              <td>{row.severity}</td>
              <td align="right">{row.count}</td>
              <td>{row.ids.slice(0, 3).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={refresh} disabled={!marshal || busy}>
        {busy ? 'Refreshing…' : 'Refresh'}
      </button>
      {note ? <p role="status">{note}</p> : null}
    </main>
  );
}
