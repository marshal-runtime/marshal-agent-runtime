import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReactUiCapabilities } from '../factory.js';
import { ReactUiWorkspaceCoordinator } from '../workspaceCoordinator.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('live workspace render binding', () => {
  // This path performs several real compiler and durable-store passes.
  it('advances one stable render to immutable revisions, retains last-good on failure, and recovers after reconstruction', async () => {
    const workspacePath = await workspace({
      'ui/Workspace.tsx': `export default function Workspace() {
        return <main data-revision="one">First revision</main>;
      }`,
    });
    const stateRoot = join(workspacePath, '.state');
    const initialContext = context('initial-session');
    const initial = createReactUiCapabilities({ workspacePath, stateRoot });
    const binding = await compileAndRender(initial, initialContext, 'ui/Workspace.tsx');
    vi.useFakeTimers({ now: Date.now() });

    const first = await renderPayload(initial, binding.renderId, initialContext);
    expect(first.render).toMatchObject({ id: binding.renderId, componentId: binding.componentId });
    expect(first.workspace).toMatchObject({ status: 'current', revision: 1, componentId: binding.componentId });

    await writeFile(
      join(workspacePath, 'ui', 'Workspace.tsx'),
      `export default function Workspace() {
        return <main data-revision="two">Second revision</main>;
      }`,
      'utf8',
    );

    const cached = await renderPayload(initial, binding.renderId, initialContext);
    expect(cached.render).toEqual(first.render);
    expect(cached.workspace).toMatchObject({ status: 'current', revision: 1 });
    await vi.advanceTimersByTimeAsync(1_500);
    const updated = await renderPayload(initial, binding.renderId, initialContext);
    expect(updated.render.id).toBe(binding.renderId);
    expect(updated.render.componentId).not.toBe(binding.componentId);
    expect(updated.workspace).toMatchObject({
      status: 'updated',
      revision: 2,
      componentId: updated.render.componentId,
    });
    expect(updated.componentHtml).toContain('Second revision');
    await expect(initial.store.getComponent(binding.componentId, initialContext)).resolves.toEqual(
      expect.objectContaining({ id: binding.componentId }),
    );

    const unchanged = await renderPayload(initial, binding.renderId, initialContext);
    expect(unchanged.render).toEqual(updated.render);
    expect(unchanged.workspace).toMatchObject({ status: 'current', revision: 2 });
    expect(await initial.store.listComponents(initialContext)).toHaveLength(2);

    const reconstructed = createReactUiCapabilities({ workspacePath, stateRoot });
    const recovered = await renderPayload(
      reconstructed,
      binding.renderId,
      context('reconstructed-session'),
    );
    expect(recovered.render).toEqual(updated.render);
    expect(recovered.workspace).toMatchObject({ status: 'current', revision: 2 });
    expect(recovered.componentHtml).toContain('Second revision');

    await writeFile(
      join(workspacePath, 'ui', 'Workspace.tsx'),
      'export default function Workspace() { return <main>Broken</section>; }',
      'utf8',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const failed = await renderPayload(
      reconstructed,
      binding.renderId,
      context('reconstructed-session'),
    );
    expect(failed.render).toEqual(updated.render);
    expect(failed.workspace).toMatchObject({
      status: 'compile_failed',
      revision: 2,
      componentId: updated.render.componentId,
    });
    expect(failed.workspace.diagnostic).toEqual(expect.any(String));
    expect(failed.workspace.diagnostic.length).toBeGreaterThan(0);
    expect(failed.componentHtml).toContain('Second revision');
    expect(await reconstructed.store.listComponents(initialContext)).toHaveLength(2);
  }, 60_000);

  it('detects an imported workspace helper edit and advances the same render binding', async () => {
    const workspacePath = await workspace({
      'ui/Workspace.tsx': `import { label } from './label';
        export default function Workspace() { return <main>{label}</main>; }`,
      'ui/label.ts': `export const label = 'Helper revision one';`,
    });
    const stateRoot = join(workspacePath, '.state');
    const currentContext = context('helper-session');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const binding = await compileAndRender(bundle, currentContext, 'ui/Workspace.tsx');
    vi.useFakeTimers({ now: Date.now() });
    const first = await renderPayload(bundle, binding.renderId, currentContext);
    const firstStored = await bundle.store.getComponent(first.render.componentId, currentContext);

    expect(first.componentHtml).toContain('Helper revision one');
    expect(firstStored.buildGraph?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'workspace', path: 'ui/label.ts' }),
    ]));

    await writeFile(join(workspacePath, 'ui', 'label.ts'), `export const label = 'Helper revision two';`, 'utf8');

    const cached = await renderPayload(bundle, binding.renderId, currentContext);
    expect(cached.render).toEqual(first.render);
    expect(cached.componentHtml).toContain('Helper revision one');
    await vi.advanceTimersByTimeAsync(1_500);
    const updated = await renderPayload(bundle, binding.renderId, currentContext);
    expect(updated.render.id).toBe(binding.renderId);
    expect(updated.render.componentId).not.toBe(first.render.componentId);
    expect(updated.workspace).toMatchObject({ status: 'updated', revision: 2 });
    expect(updated.componentHtml).toContain('Helper revision two');
    expect(await bundle.store.listComponents(currentContext)).toHaveLength(2);
  });

  it('skips workspace head, revision listing, and source checks until the successful poll interval expires', async () => {
    const workspacePath = await workspace({
      'ui/Workspace.tsx': `export default function Workspace() {
        return <main>Stable revision</main>;
      }`,
    });
    const stateRoot = join(workspacePath, '.state');
    const currentContext = context('cached-session');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const binding = await compileAndRender(bundle, currentContext, 'ui/Workspace.tsx');
    vi.useFakeTimers({ now: Date.now() });
    const first = await renderPayload(bundle, binding.renderId, currentContext);
    const head = vi.spyOn(bundle.store, 'getWorkspaceHead');
    const revisions = vi.spyOn(bundle.store, 'listComponentsBestEffort');
    const current = vi.spyOn(bundle.compiler, 'isWorkspaceComponentCurrent');
    const compile = vi.spyOn(bundle.compiler, 'compileWorkspace');

    let repeated = first;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      repeated = await renderPayload(bundle, binding.renderId, currentContext);
    }
    expect(repeated.render).toEqual(first.render);
    expect(repeated.workspace.checkedAt).toBe(first.workspace.checkedAt);
    await vi.advanceTimersByTimeAsync(1_499);
    await renderPayload(bundle, binding.renderId, currentContext);
    expect(head).not.toHaveBeenCalled();
    expect(revisions).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const refreshed = await renderPayload(bundle, binding.renderId, currentContext);
    expect(refreshed.workspace).toMatchObject({ status: 'current', revision: 1 });
    expect(refreshed.workspace.checkedAt).not.toBe(first.workspace.checkedAt);
    expect(head).toHaveBeenCalledTimes(1);
    expect(revisions).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  it('retains eager freshness checks when the poll interval is zero', async () => {
    const workspacePath = await workspace({
      'ui/Workspace.tsx': `export default function Workspace() {
        return <main>Zero interval revision one</main>;
      }`,
    });
    const stateRoot = join(workspacePath, '.state');
    const currentContext = context('zero-interval-session');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const binding = await compileAndRender(bundle, currentContext, 'ui/Workspace.tsx');
    const storedRender = await bundle.store.getRender(binding.renderId, currentContext);
    const coordinator = new ReactUiWorkspaceCoordinator(bundle.compiler, bundle.store);
    const eagerRender = {
      ...storedRender,
      workspace: { ...storedRender.workspace!, pollIntervalMs: 0 },
    };
    vi.useFakeTimers({ now: Date.now() });
    const first = await coordinator.resolve(eagerRender, currentContext);
    const head = vi.spyOn(bundle.store, 'getWorkspaceHead');
    const revisions = vi.spyOn(bundle.store, 'listComponentsBestEffort');
    const current = vi.spyOn(bundle.compiler, 'isWorkspaceComponentCurrent');
    const compile = vi.spyOn(bundle.compiler, 'compileWorkspace');

    await writeFile(
      join(workspacePath, 'ui', 'Workspace.tsx'),
      `export default function Workspace() {
        return <main>Zero interval revision two</main>;
      }`,
      'utf8',
    );
    const updated = await coordinator.resolve(eagerRender, currentContext);

    expect(updated.component.id).not.toBe(first.component.id);
    expect(updated.workspace).toMatchObject({ status: 'updated', revision: 2 });
    expect(head).toHaveBeenCalledTimes(1);
    expect(revisions).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalled();
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('never reuses a successful cache entry across project scopes', async () => {
    const workspacePath = await workspace({
      'ui/Workspace.tsx': `export default function Workspace() {
        return <main>Scoped revision</main>;
      }`,
    });
    const stateRoot = join(workspacePath, '.state');
    const currentContext = context('scoped-session');
    const bundle = createReactUiCapabilities({ workspacePath, stateRoot });
    const binding = await compileAndRender(bundle, currentContext, 'ui/Workspace.tsx');
    const storedRender = await bundle.store.getRender(binding.renderId, currentContext);
    const coordinator = new ReactUiWorkspaceCoordinator(bundle.compiler, bundle.store);
    vi.useFakeTimers({ now: Date.now() });
    await coordinator.resolve(storedRender, currentContext);
    const head = vi.spyOn(bundle.store, 'getWorkspaceHead');
    const revisions = vi.spyOn(bundle.store, 'listComponentsBestEffort');
    const current = vi.spyOn(bundle.compiler, 'isWorkspaceComponentCurrent');

    await expect(
      coordinator.resolve(storedRender, context('foreign-session', 'foreign-project')),
    ).rejects.toThrow('React UI render scope validation failed');
    expect(head).not.toHaveBeenCalled();
    expect(revisions).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
  });
});

type ReactUiBundle = ReturnType<typeof createReactUiCapabilities>;

async function compileAndRender(
  bundle: ReactUiBundle,
  invocationContext: InvocationContext,
  entryPath: string,
): Promise<{ componentId: string; renderId: string }> {
  const compiled = await bundle.provider.invoke(
    'ui.compile',
    { entryPath, title: 'Live workspace' },
    invocationContext,
  );
  const componentId = String(output(compiled).component.id);
  const rendered = await bundle.provider.invoke(
    'ui.render',
    {
      componentId,
      props: { brief: 'Keep the render identity stable' },
      fallback: { summary: 'Live workspace fallback' },
    },
    invocationContext,
  );
  return { componentId, renderId: String(output(rendered).render.id) };
}

async function renderPayload(
  bundle: ReactUiBundle,
  renderId: string,
  invocationContext: InvocationContext,
): Promise<{
  render: { id: string; componentId: string };
  workspace: {
    status: string;
    revision: number;
    componentId: string;
    checkedAt: string;
    diagnostic?: string;
  };
  componentHtml: string;
}> {
  const result = await bundle.resources.invokeRenderTool(
    'runtime_render_component',
    { renderId },
    invocationContext,
  );
  if (!result) throw new Error('Expected the live render payload');
  const structured = result.structuredContent as Record<string, unknown>;
  const marshal = result._meta?.marshal as Record<string, unknown>;
  return {
    render: structured.render as { id: string; componentId: string },
    workspace: structured.workspace as {
      status: string;
      revision: number;
      componentId: string;
      checkedAt: string;
      diagnostic?: string;
    },
    componentHtml: String(marshal.componentHtml),
  };
}

function output(value: unknown): Record<string, Record<string, unknown>> {
  return (value as { output: Record<string, Record<string, unknown>> }).output;
}

function context(sessionId: string, projectId = 'project'): InvocationContext {
  return {
    principal: { id: 'agent', kind: 'agent' },
    scope: { workspaceId: 'workspace', projectId, sessionId },
  };
}

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-live-workspace-'));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}
