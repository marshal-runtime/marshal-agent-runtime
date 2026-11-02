import { useEffect, useState } from 'react';
import type { MarshalUiClient, UiDisplayMode } from '@marshal/agent-runtime-ui';

export default function AdaptiveStatus({ marshal }: { marshal?: MarshalUiClient }) {
  const [mode, setMode] = useState<UiDisplayMode>(marshal?.host.displayMode ?? 'inline');
  const [message, setMessage] = useState('Inline is the portable fallback.');

  useEffect(() => marshal?.subscribe((event) => {
    if (event.type === 'host-context-changed') setMode(event.context.displayMode);
  }), [marshal]);

  async function requestMode(requested: UiDisplayMode) {
    if (!marshal) {
      setMessage('No host bridge is connected; remaining inline.');
      return;
    }
    const result = await marshal.requestDisplayMode(requested);
    setMode(result.actual);
    setMessage(`${result.status}: requested ${result.requested}, actual ${result.actual}${result.reason ? ` — ${result.reason}` : ''}`);
  }

  return (
    <main style={{ padding: mode === 'fullscreen' ? 32 : 14, display: 'grid', gap: 12 }}>
      <header>
        <small>Current mode</small>
        <h2 style={{ margin: 0 }}>{mode}</h2>
      </header>
      <div role="group" aria-label="Presentation mode">
        {(['inline', 'fullscreen', 'pip'] as const).map((candidate) => (
          <button key={candidate} type="button" onClick={() => requestMode(candidate)} style={{ marginRight: 8 }}>
            {candidate}
          </button>
        ))}
      </div>
      <p aria-live="polite">{message}</p>
    </main>
  );
}
