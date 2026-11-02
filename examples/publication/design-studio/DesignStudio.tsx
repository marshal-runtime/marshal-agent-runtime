import { useEffect, useMemo, useState } from 'react';
import './DesignStudio.css';
import type {
  MarshalUiComponentProps,
  UiDisplayMode,
  UiDisplayModeResult,
  UiHostContext,
} from '@marshal/agent-runtime-ui';

type Device = 'desktop' | 'tablet' | 'mobile';

interface DirectionTokens {
  accent?: string;
  radius?: string;
  density?: string;
  typeScale?: string;
}

interface ResponsiveFrame {
  id: string;
  label: string;
  width: number;
  height: number;
  notes?: string;
  refinement?: string;
  updatedAt?: string;
}

interface ResponsiveState {
  selectedFrameId: string;
  frames: ResponsiveFrame[];
}

interface Direction {
  id: string;
  name: string;
  premise: string;
  palette: [string, string, string];
  interaction: string;
  tokens?: DirectionTokens;
  responsive?: ResponsiveState;
}

interface DesignSystem {
  name: string;
  colors: { canvas: string; surface: string; text: string; accent: string };
  radius: { card: number; control: number };
  spacing: number[];
  principles: string[];
}

interface Workspace {
  projectName: string;
  brief?: string;
  version: number;
  selectedDirectionId: string;
  directions: Direction[];
  updatedAt?: string;
}

type DesignStudioProps = MarshalUiComponentProps<{
  projectName: string;
  brief: string;
  directions: Direction[];
  designSystem?: DesignSystem;
  workspaceVersion?: number;
}>;

const DEVICES: readonly Device[] = ['desktop', 'tablet', 'mobile'];
const DEFAULT_SYSTEM: DesignSystem = {
  name: 'Calm Launch',
  colors: { canvas: '#f6f7f4', surface: '#ffffff', text: '#17201c', accent: '#357a63' },
  radius: { card: 16, control: 10 },
  spacing: [4, 8, 12, 16, 24, 32],
  principles: ['quiet hierarchy', 'clear ownership', 'progressive disclosure'],
};

export default function DesignStudio({
  marshal,
  projectName,
  brief,
  directions: initialDirections,
  designSystem = DEFAULT_SYSTEM,
  workspaceVersion = 1,
}: DesignStudioProps) {
  const [context, setContext] = useState<UiHostContext>(marshal.host.context);
  const [directions, setDirections] = useState(initialDirections.map(normalizeDirection));
  const [selectedId, setSelectedId] = useState(
    localStorage.getItem('selected-direction') ?? initialDirections[0]?.id ?? '',
  );
  const [device, setDevice] = useState<Device>(
    validDevice(localStorage.getItem('preview-device')) ?? 'desktop',
  );
  const [compare, setCompare] = useState(false);
  const [instruction, setInstruction] = useState('Make the hierarchy calmer and strengthen the mobile state.');
  const [status, setStatus] = useState('Ready to explore.');
  const [busy, setBusy] = useState<'refine' | 'save' | 'load' | undefined>();
  const [version, setVersion] = useState(workspaceVersion);
  const [authoritative, setAuthoritative] = useState(false);
  const [receipt, setReceipt] = useState('No runtime action yet');
  const [modeResult, setModeResult] = useState<UiDisplayModeResult>({
    requested: context.displayMode,
    actual: context.displayMode,
    status: 'granted',
  });

  useEffect(() => marshal.subscribe((event) => {
    if (event.type === 'host-context-changed') setContext(event.context);
    if (event.type === 'tool-cancelled') setStatus(event.reason ?? 'The host cancelled this operation.');
    if (event.type === 'tool-error') setStatus(event.error.message);
  }), [marshal]);

  const selected = useMemo(
    () => directions.find((direction) => direction.id === selectedId) ?? directions[0],
    [directions, selectedId],
  );
  const safeArea = context.safeAreaInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const accent = selected?.tokens?.accent ?? selected?.palette[1] ?? designSystem.colors.accent;
  const radius = tokenNumber(selected?.tokens?.radius, designSystem.radius.card, 4, 32);
  const density = tokenNumber(selected?.tokens?.density, 1, .8, 1.3);
  const typeScale = tokenNumber(selected?.tokens?.typeScale, 1, .9, 1.2);
  const mode = context.displayMode;
  const canFullscreen = context.availableDisplayModes.includes('fullscreen');
  const canPip = context.availableDisplayModes.includes('pip');

  function selectDirection(id: string) {
    localStorage.setItem('selected-direction', id);
    setSelectedId(id);
    setDirections((current) => current.map((direction) => direction.id === id && direction.responsive
      ? { ...direction, responsive: { ...direction.responsive, selectedFrameId: frameForDevice(direction, device).id } }
      : direction));
    setAuthoritative(false);
    setStatus(`Selected ${directions.find((direction) => direction.id === id)?.name ?? 'direction'}.`);
  }

  function selectDevice(next: Device) {
    localStorage.setItem('preview-device', next);
    setDevice(next);
    setDirections((current) => current.map((direction) => direction.id === selected?.id && direction.responsive
      ? { ...direction, responsive: { ...direction.responsive, selectedFrameId: frameForDevice(direction, next).id } }
      : direction));
    setAuthoritative(false);
  }

  function updateToken(key: keyof DirectionTokens, value: string | number) {
    if (!selected) return;
    setDirections((current) => current.map((direction) => direction.id === selected.id
        ? { ...direction, tokens: { ...direction.tokens, [key]: String(value) } }
        : direction));
    setAuthoritative(false);
    setStatus('Local canvas edit ready to save.');
  }

  function currentWorkspace(): Workspace {
    return {
      projectName,
      brief,
      version,
      selectedDirectionId: selected?.id ?? '',
      directions,
      updatedAt: new Date().toISOString(),
    };
  }

  function applyWorkspace(workspace: Workspace) {
    if (!Array.isArray(workspace.directions) || workspace.directions.length === 0) return;
    setDirections(workspace.directions.map(normalizeDirection));
    setVersion(workspace.version);
    setAuthoritative(true);
    const nextSelectedId = workspace.selectedDirectionId || workspace.directions[0].id;
    localStorage.setItem('selected-direction', nextSelectedId);
    setSelectedId(nextSelectedId);
  }

  async function requestMode(requested: UiDisplayMode) {
    if (!context.availableDisplayModes.includes(requested)) {
      setModeResult({ requested, actual: mode, status: 'unsupported', reason: 'This host did not advertise that mode.' });
      setStatus(`Kept the workspace ${mode}; ${requested} is unavailable here.`);
      return;
    }
    const result = await marshal.requestDisplayMode(requested);
    setModeResult(result);
    setContext(marshal.host.context);
    setStatus(result.status === 'granted'
      ? `Opened ${result.actual} mode.`
      : `${result.status}: ${result.reason ?? `kept ${result.actual} mode`}`);
  }

  async function refine() {
    if (!selected || !instruction.trim()) return;
    setBusy('refine');
    setStatus('Refining only the selected direction...');
    try {
      if (!authoritative) await persistWorkspace();
      const frameId = frameForDevice(selected, device).id;
      const response = await marshal.callAction<
        { projectName: string; directionId: string; frameId: string; instruction: string; expectedVersion: number },
        { workspace: Workspace; artifact: unknown; refinement: { summary?: string; editBoundary?: string } }
      >('refine-design', {
        projectName,
        directionId: selected.id,
        frameId,
        instruction: instruction.trim(),
        expectedVersion: version,
      }, {
        scope: 'project',
        idempotencyKey: `refine:${projectName}:${version}:${selected.id}:${instruction.trim()}`,
      });
      setReceipt(response.receipt.receiptId);
      if (response.status === 'success' && response.output?.workspace) {
        applyWorkspace(response.output.workspace);
        setStatus(response.output.refinement.summary ?? `Saved version ${response.output.workspace.version}.`);
      } else {
        setStatus(`${response.status}: ${response.error?.message ?? 'Refinement did not complete.'}`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function saveWorkspace() {
    setBusy('save');
    setStatus('Saving authoritative workspace...');
    try {
      const workspace = await persistWorkspace();
      setStatus(`Workspace saved as version ${workspace.version}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function persistWorkspace(): Promise<Workspace> {
    const workspace = currentWorkspace();
    const response = await marshal.callAction<
      { workspace: Workspace },
      { workspace: Workspace; artifact: unknown }
    >('save-workspace', { workspace }, {
      scope: 'project',
      idempotencyKey: `save:${projectName}:${version}:${fingerprint(JSON.stringify(workspace))}`,
    });
    setReceipt(response.receipt.receiptId);
    if (response.status !== 'success' || !response.output?.workspace) {
      throw new Error(response.error?.message ?? 'Save did not complete.');
    }
    applyWorkspace(response.output.workspace);
    return response.output.workspace;
  }

  async function loadWorkspace() {
    setBusy('load');
    setStatus('Restoring authoritative workspace...');
    try {
      const response = await marshal.callAction<
        { projectName: string },
        { workspace: Workspace; artifact: unknown }
      >('load-workspace', { projectName }, {
        scope: 'project',
      });
      setReceipt(response.receipt.receiptId);
      if (response.status === 'success' && response.output?.workspace) {
        applyWorkspace(response.output.workspace);
        setStatus(`Restored version ${response.output.workspace.version}.`);
      } else {
        setStatus(`${response.status}: ${response.error?.message ?? 'No saved workspace was restored.'}`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <main
      className="studio"
      data-mode={mode}
      data-theme={context.theme ?? 'light'}
      style={{
        '--studio-accent': accent,
        '--studio-on-accent': contrastText(accent),
        '--studio-radius': `${radius}px`,
        '--studio-density': density,
        '--studio-type-scale': typeScale,
        '--safe-top': `${safeArea.top}px`,
        '--safe-right': `${safeArea.right}px`,
        '--safe-bottom': `${safeArea.bottom}px`,
        '--safe-left': `${safeArea.left}px`,
      } as Record<string, string | number>}
    >
      <header className="studio__bar">
        <div className="studio__identity">
          <span className="studio__mark" aria-hidden="true">M</span>
          <div>
            <p className="eyebrow">Live design workspace</p>
            <h1>{projectName}</h1>
          </div>
        </div>
        <div className="studio__mode-controls" aria-label="Presentation mode">
          <button type="button" className="icon-button" onClick={() => requestMode('inline')} aria-label="Inline mode">In</button>
          <button type="button" className="icon-button" onClick={() => requestMode('fullscreen')} disabled={!canFullscreen} aria-label="Fullscreen mode">Full</button>
          <button type="button" className="icon-button" onClick={() => requestMode('pip')} disabled={!canPip} aria-label="Picture in picture mode">PiP</button>
        </div>
        <div className="studio__save-controls">
          <span className="version">v{version}</span>
          <button type="button" className="button button--quiet" onClick={loadWorkspace} disabled={Boolean(busy)}>Restore</button>
          <button type="button" className="button button--primary" onClick={saveWorkspace} disabled={Boolean(busy)}>Save</button>
        </div>
      </header>

      <div className="studio__layout">
        <aside className="direction-rail" aria-label="Design directions">
          <div className="section-heading">
            <div><span className="step">01</span><h2>Directions</h2></div>
            <button type="button" className="text-button" onClick={() => setCompare((value) => !value)} aria-pressed={compare}>
              {compare ? 'Canvas' : 'Compare'}
            </button>
          </div>
          <p className="rail-brief">{brief}</p>
          <div className="direction-list">
            {directions.map((direction, index) => (
              <button
                key={direction.id}
                type="button"
                className="direction-card"
                data-selected={selected?.id === direction.id}
                onClick={() => selectDirection(direction.id)}
                aria-pressed={selected?.id === direction.id}
              >
                <span className="direction-card__number">{String(index + 1).padStart(2, '0')}</span>
                <span className="direction-card__body">
                  <strong>{direction.name}</strong>
                  <small>{direction.premise}</small>
                </span>
                <span className="swatches" aria-label={`${direction.name} palette`}>
                  {direction.palette.map((color) => <i key={color} style={{ backgroundColor: color }} />)}
                </span>
              </button>
            ))}
          </div>
          <div className="design-system-note">
            <span>Design system</span>
            <strong>{designSystem.name}</strong>
            <p>{designSystem.principles.join(' / ')}</p>
          </div>
        </aside>

        <section className="canvas-panel" aria-label="Design canvas">
          <div className="canvas-toolbar">
            <div className="device-picker" aria-label="Responsive preview">
              {DEVICES.map((candidate) => (
                <button key={candidate} type="button" onClick={() => selectDevice(candidate)} aria-pressed={device === candidate}>
                  {candidate}
                </button>
              ))}
            </div>
            <div className="canvas-meta">
              <span>{context.containerDimensions?.width ?? 'auto'} x {context.containerDimensions?.height ?? 'auto'}</span>
              <span>{context.locale ?? 'default locale'}</span>
            </div>
          </div>

          {compare ? (
            <div className="comparison-grid">
              {directions.map((direction) => (
                <article key={direction.id} className="comparison-card">
                  <Preview direction={direction} device="mobile" compact />
                  <strong>{direction.name}</strong>
                  <span>{direction.interaction}</span>
                  <button type="button" className="button button--quiet comparison-select" onClick={() => { selectDirection(direction.id); setCompare(false); }}>Open direction</button>
                </article>
              ))}
            </div>
          ) : selected ? (
            <div className="canvas-stage" data-device={device}>
              <div className="device-label"><span>{device}</span><span>{frameForDevice(selected, device).notes ?? 'Adaptive composition'}</span></div>
              <Preview direction={selected} device={device} />
            </div>
          ) : <div className="empty-state">No design direction is available yet.</div>}
        </section>

        <aside className="inspector" aria-label="Design inspector">
          <div className="section-heading"><div><span className="step">02</span><h2>Refine</h2></div></div>
          {selected ? <>
            <div className="inspector__selection">
              <span>Selected direction</span>
              <strong>{selected.name}</strong>
              <p>{selected.interaction}</p>
            </div>
            <fieldset className="token-controls">
              <legend>Direct canvas controls</legend>
              <label><span>Accent</span><input type="color" value={accent} onChange={(event) => updateToken('accent', event.target.value)} /></label>
              <label><span>Corner radius</span><output>{radius}</output><input type="range" min="4" max="32" value={radius} onChange={(event) => updateToken('radius', Number(event.target.value))} /></label>
              <label><span>Density</span><output>{density.toFixed(1)}</output><input type="range" min="0.8" max="1.3" step="0.1" value={density} onChange={(event) => updateToken('density', Number(event.target.value))} /></label>
              <label><span>Type scale</span><output>{typeScale.toFixed(1)}</output><input type="range" min="0.9" max="1.2" step="0.05" value={typeScale} onChange={(event) => updateToken('typeScale', Number(event.target.value))} /></label>
            </fieldset>
            <label className="prompt-field">
              <span>Conversational refinement</span>
              <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={4000} />
            </label>
            <button type="button" className="button button--primary button--wide" onClick={refine} disabled={Boolean(busy) || !instruction.trim()}>
              {busy === 'refine' ? 'Refining...' : 'Run targeted refinement'}
            </button>
          </> : null}
          <div className="runtime-status" aria-live="polite" data-busy={Boolean(busy)}>
            <span className="runtime-status__dot" aria-hidden="true" />
            <div><strong>{status}</strong><small>Receipt: {receipt}</small><small>Mode: {modeResult.status} / {modeResult.actual}</small></div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Preview({ direction, device, compact = false }: { direction: Direction; device: Device; compact?: boolean }) {
  const previewAccent = direction.tokens?.accent ?? direction.palette[1];
  return (
    <div className="product-preview" data-device={device} data-compact={compact} style={{ '--preview-accent': previewAccent } as Record<string, string>}>
      <nav><span className="preview-logo">A</span><span>Atlas</span><i /><span className="preview-invite">Invite</span></nav>
      <div className="preview-content">
        <header><p>Launch command</p><h3>{direction.name}</h3><span>{direction.premise}</span></header>
        <div className="preview-stats"><article><span>Readiness</span><strong>78%</strong><i /></article><article><span>Open decisions</span><strong>06</strong><i /></article></div>
        <section className="preview-plan">
          <div><strong>Today</strong><span>Three owners are moving the launch forward.</span></div>
          {['Position the story', 'Review the release path', 'Align launch owners'].map((item, index) => (
            <article key={item}><i data-done={index === 0} /><span>{item}</span><small>{index === 0 ? 'Done' : `${index + 1} owners`}</small></article>
          ))}
        </section>
      </div>
    </div>
  );
}

function validDevice(value: string | null): Device | undefined {
  return DEVICES.find((device) => device === value);
}

function normalizeDirection(direction: Direction): Direction {
  if (direction.responsive?.frames.length) return direction;
  const frames: ResponsiveFrame[] = [
    { id: 'desktop', label: 'Desktop', width: 1440, height: 960, notes: 'Wide canvas with persistent context.' },
    { id: 'tablet', label: 'Tablet', width: 834, height: 1112, notes: 'Balanced canvas for review and touch.' },
    { id: 'mobile', label: 'Mobile', width: 390, height: 844, notes: 'Focused single-column launch view.' },
  ];
  return { ...direction, responsive: { selectedFrameId: 'desktop', frames } };
}

function frameForDevice(direction: Direction, device: Device): ResponsiveFrame {
  const responsive = normalizeDirection(direction).responsive!;
  return responsive.frames.find((frame) => frame.id === device)
    ?? responsive.frames.find((frame) => frame.id === responsive.selectedFrameId)
    ?? responsive.frames[0]!;
}

function tokenNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function contrastText(color: string): '#ffffff' | '#111411' {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return '#ffffff';
  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? '#111411' : '#ffffff';
}
