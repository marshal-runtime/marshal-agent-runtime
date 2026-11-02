import { useState } from 'react';
import type { MarshalUiClient } from '@marshal/agent-runtime-ui';

interface ActionBoardProps {
  marshal?: MarshalUiClient;
  actionId: 'search-memory' | 'update-priority';
  title: string;
}

export default function ActionBoard({ marshal, actionId, title }: ActionBoardProps) {
  const [query, setQuery] = useState('publication risks');
  const [result, setResult] = useState('No action has run.');
  const [busy, setBusy] = useState(false);

  async function runAction() {
    if (!marshal) {
      setResult('The host has not connected the Marshal UI client. Use the text fallback below.');
      return;
    }
    setBusy(true);
    try {
      const input = actionId === 'search-memory'
        ? { scope: 'project', query, limit: 5 }
        : { itemId: 'publication-demo', priority: query.trim() || 'normal' };
      const response = await marshal.callAction(actionId, input, {
        scope: 'project',
        idempotencyKey: `${actionId}:${JSON.stringify(input)}`,
      });
      setResult(JSON.stringify(response, null, 2));
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="action-title" style={{ padding: 16, display: 'grid', gap: 12 }}>
      <h2 id="action-title" style={{ margin: 0 }}>{title}</h2>
      <label>
        {actionId === 'search-memory' ? 'Memory query' : 'Priority label'}
        <input value={query} onChange={(event: { target: { value: string } }) => setQuery(event.target.value)} style={{ display: 'block', width: '100%' }} />
      </label>
      <button type="button" onClick={runAction} disabled={busy || !query.trim()}>
        {busy ? 'Running…' : 'Run declared action'}
      </button>
      <pre aria-live="polite" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result}</pre>
    </section>
  );
}
