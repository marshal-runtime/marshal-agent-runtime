import { useCallback, useEffect, useState } from 'react';
import './standards-host.css';
import type {
  MarshalUiComponentProps,
  UiDisplayMode,
  UiDisplayModeResult,
  UiHostContext,
} from '@marshal/agent-runtime-ui';

type Selection = {
  selection: string;
  revision: number;
};

type Props = MarshalUiComponentProps<{
  title?: string;
  initialSelection?: string;
}>;

const UNAVAILABLE_REASON = 'The standards host did not advertise this display mode.';

export default function StandardsHostApp({
  marshal,
  title = 'Portable incident review',
  initialSelection = 'Direction A',
}: Props) {
  const [context, setContext] = useState<UiHostContext>(marshal.host.context);
  const [selection, setSelection] = useState(initialSelection);
  const [actionStatus, setActionStatus] = useState('ready');
  const [actionReceipt, setActionReceipt] = useState('none');
  const [toolStatus, setToolStatus] = useState('loading');
  const [modeResult, setModeResult] = useState<UiDisplayModeResult>({
    requested: marshal.host.displayMode,
    actual: marshal.host.displayMode,
    status: 'granted',
  });

  useEffect(() => marshal.subscribe((event) => {
    if (event.type === 'host-context-changed') setContext(event.context);
  }), [marshal]);

  useEffect(() => {
    let active = true;
    marshal.callTool<{ resourceId: string }, Selection>('read-selection', {
      resourceId: 'standards-host-selection',
    }).then((value) => {
      if (!active) return;
      setSelection(value.selection);
      setToolStatus(`loaded revision ${value.revision}`);
    }).catch((error: unknown) => {
      if (!active) return;
      setToolStatus(`failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      active = false;
    };
  }, [marshal]);

  const saveSelection = useCallback(async (signal?: AbortSignal) => {
    setActionStatus('saving');
    const result = await marshal.callAction<
      { selection: string },
      { saved: boolean; selection: string; revision: number }
    >('save-selection', { selection: 'Direction B' }, {
      scope: 'project',
      idempotencyKey: 'standards-host-save-direction-b-v1',
      signal,
    });
    if (result.status === 'success' && result.output?.saved) {
      setSelection(result.output.selection);
      setActionStatus(`saved revision ${result.output.revision}`);
      setActionReceipt(result.receipt.receiptId);
      return result;
    }
    setActionStatus(`${result.status}: ${result.error?.message ?? 'action failed'}`);
    setActionReceipt(result.receipt.receiptId);
    return result;
  }, [marshal]);

  const reopenSelection = useCallback(async (signal?: AbortSignal) => {
    setActionStatus('reopening');
    const result = await marshal.callAction<
      { resourceId: string },
      { found: boolean; selection: string; revision: number }
    >('reopen-selection', { resourceId: 'standards-host-selection' }, {
      scope: 'project',
      signal,
    });
    if (result.status === 'success' && result.output?.found) {
      setSelection(result.output.selection);
      setActionStatus(`reopened revision ${result.output.revision}`);
      setActionReceipt(result.receipt.receiptId);
      return result;
    }
    setActionStatus(`${result.status}: ${result.error?.message ?? 'saved selection not found'}`);
    setActionReceipt(result.receipt.receiptId);
    return result;
  }, [marshal]);

  useEffect(() => {
    const unbindSave = marshal.bindActionControl(
      'save-selection',
      ({ signal }) => saveSelection(signal),
    );
    const unbindReopen = marshal.bindActionControl(
      'reopen-selection',
      ({ signal }) => reopenSelection(signal),
    );
    return () => {
      unbindSave();
      unbindReopen();
    };
  }, [marshal, reopenSelection, saveSelection]);

  async function requestMode(mode: UiDisplayMode) {
    if (!marshal.host.context.availableDisplayModes.includes(mode)) {
      setModeResult({
        requested: mode,
        actual: marshal.host.displayMode,
        status: 'unsupported',
        reason: UNAVAILABLE_REASON,
      });
      return;
    }
    setModeResult(await marshal.requestDisplayMode(mode));
  }

  const safeArea = context.safeAreaInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const dimensions = context.containerDimensions ?? {};

  return (
    <main className="app-shell" data-theme={context.theme ?? 'light'}>
      <header>
        <p className="eyebrow">MCP Apps · standards-only host</p>
        <h1>{title}</h1>
        <p>Real portable source, declared runtime calls, and restart-safe state.</p>
      </header>

      <section className="status-grid" aria-label="Current host and application state">
        <article><span>Selection</span><strong id="selection-value">{selection}</strong></article>
        <article><span>Theme</span><strong id="theme-value">{context.theme ?? 'light'}</strong></article>
        <article><span>Viewport</span><strong id="dimensions-value">{dimensions.width ?? 0}×{dimensions.height ?? 0}</strong></article>
        <article><span>Safe area</span><strong id="safe-area-value">{safeArea.top}/{safeArea.right}/{safeArea.bottom}/{safeArea.left}</strong></article>
      </section>

      <section className="controls" aria-label="Application controls">
        <button id="action-save" type="button" onClick={() => void saveSelection()}>Save Direction B</button>
        <button id="action-draft" type="button" onClick={() => setSelection('Direction C draft')}>Draft Direction C</button>
        <button id="action-reopen" type="button" onClick={() => void reopenSelection()}>Reopen saved selection</button>
        <button id="mode-fullscreen" type="button" onClick={() => requestMode('fullscreen')}>Fullscreen</button>
        <button id="mode-pip" type="button" onClick={() => requestMode('pip')}>Picture in picture</button>
      </section>

      <section className="results" aria-live="polite">
        <p>Action: <output id="action-status">{actionStatus}</output></p>
        <p>Receipt: <output id="action-receipt">{actionReceipt}</output></p>
        <p>Tool: <output id="tool-status">{toolStatus}</output></p>
        <p>Mode: <output id="mode-status">{modeResult.requested}:{modeResult.status}:{modeResult.actual}</output></p>
        {modeResult.reason ? <p id="mode-reason">{modeResult.reason}</p> : null}
      </section>
    </main>
  );
}
