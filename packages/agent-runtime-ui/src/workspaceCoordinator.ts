import type { InvocationContext } from '@marshal/agent-runtime-core';
import type { ReactUiCompiler } from './compiler.js';
import { scopeKey, type ReactUiStore } from './store.js';
import type {
  CompiledReactComponent,
  ReactUiRender,
  ReactUiWorkspaceRevisionStatus,
} from './types.js';

const MAX_SUCCESSFUL_WORKSPACE_RESOLUTIONS = 200;

export interface ReactUiWorkspaceResolution {
  component: CompiledReactComponent;
  workspace?: ReactUiWorkspaceRevisionStatus;
}

interface CachedWorkspaceResolution {
  bindingKey: string;
  refreshAfter: number;
  resolution: ReactUiWorkspaceResolution;
}

/** Resolves a durable workspace recipe to its newest immutable, successfully compiled revision. */
export class ReactUiWorkspaceCoordinator {
  private readonly pending = new Map<string, Promise<ReactUiWorkspaceResolution>>();
  private readonly retryAfter = new Map<string, number>();
  private readonly successful = new Map<string, CachedWorkspaceResolution>();

  constructor(
    private readonly compiler: ReactUiCompiler,
    private readonly store: ReactUiStore,
  ) {}

  async resolve(render: ReactUiRender, context: InvocationContext): Promise<ReactUiWorkspaceResolution> {
    if (render.scopeKey !== scopeKey(context)) {
      throw new Error('React UI render scope validation failed');
    }
    if (!render.workspace) {
      return { component: await this.store.getComponent(render.componentId, context) };
    }
    const key = `${render.scopeKey}:${render.id}`;
    const active = this.pending.get(key);
    if (active) return active;
    const bindingKey = workspaceBindingKey(render);
    const cached = this.successful.get(key);
    const now = Date.now();
    if (
      cached &&
      cached.bindingKey === bindingKey &&
      cached.refreshAfter > now
    ) {
      this.successful.delete(key);
      this.successful.set(key, cached);
      return cached.resolution;
    }
    if (cached) this.successful.delete(key);
    const operation = this.resolveWorkspace(render, context)
      .then((resolution) => {
        const workspace = resolution.workspace;
        if (
          !workspace ||
          workspace.status === 'compile_failed' ||
          render.workspace!.pollIntervalMs <= 0
        ) {
          this.successful.delete(key);
          return resolution;
        }
        this.rememberSuccessful(key, {
          bindingKey,
          refreshAfter: Date.now() + render.workspace!.pollIntervalMs,
          resolution: {
            component: resolution.component,
            workspace:
              workspace.status === 'updated'
                ? { ...workspace, status: 'current' }
                : workspace,
          },
        });
        return resolution;
      })
      .finally(() => {
        if (this.pending.get(key) === operation) this.pending.delete(key);
      });
    this.pending.set(key, operation);
    return operation;
  }

  private rememberSuccessful(key: string, cached: CachedWorkspaceResolution): void {
    const now = Date.now();
    for (const [candidateKey, candidate] of this.successful) {
      if (candidate.refreshAfter <= now) this.successful.delete(candidateKey);
    }
    while (this.successful.size >= MAX_SUCCESSFUL_WORKSPACE_RESOLUTIONS) {
      const oldest = this.successful.keys().next();
      if (oldest.done) break;
      this.successful.delete(oldest.value);
    }
    this.successful.set(key, cached);
  }

  private async resolveWorkspace(
    render: ReactUiRender,
    context: InvocationContext,
  ): Promise<ReactUiWorkspaceResolution> {
    const binding = render.workspace!;
    let headId: string | undefined;
    try {
      headId = await this.store.getWorkspaceHead(render.id, context);
    } catch {
      headId = undefined;
    }
    let latest = await this.store.getComponent(headId ?? render.componentId, context);
    if (!matchesWorkspace(latest, render)) {
      headId = undefined;
      latest = await this.store.getComponent(render.componentId, context);
    }
    const revisions = (await this.store.listComponentsBestEffort(context))
      .filter((component) => matchesWorkspace(component, render))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    if (!revisions.some((component) => component.id === latest.id)) revisions.push(latest);
    const retryKey = `${render.scopeKey}:${render.id}`;
    const checkedAt = new Date().toISOString();
    const requestedProfile = binding.authoringProfile;
    const profileExists = requestedProfile && this.compiler.listAuthoringProfiles().some(
      (profile) => profile.id === requestedProfile.id && profile.version === requestedProfile.version,
    );
    const profileSelection = requestedProfile
      ? this.compiler.selectAuthoringProfile(requestedProfile)
      : undefined;
    const profileCompatible = !requestedProfile || (
      profileSelection?.profile.id === requestedProfile.id &&
      profileSelection.profile.version === requestedProfile.version
    );
    if (requestedProfile && (!profileExists || !profileCompatible)) {
      const code = profileExists ? 'authoring_profile_incompatible' : 'authoring_profile_unavailable';
      return {
        component: latest,
        workspace: status(
          'compile_failed', latest, revisions, binding.pollIntervalMs, checkedAt,
          `Authoring profile ${requestedProfile.id}@${requestedProfile.version} is ${profileExists ? 'incompatible with this host' : 'unavailable'}; showing the last good revision.`,
          { code, profile: requestedProfile },
        ),
      };
    }
    if (headId && await this.compiler.isWorkspaceComponentCurrent(latest)) {
      this.retryAfter.delete(retryKey);
      return { component: latest, workspace: status('current', latest, revisions, binding.pollIntervalMs, checkedAt) };
    }
    const current = (await Promise.all(revisions.filter((component) => component.id !== headId).map(async (component) =>
      await this.compiler.isWorkspaceComponentCurrent(component) ? component : undefined,
    ))).filter((component): component is CompiledReactComponent => component !== undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .at(-1);
    if (current) {
      const changed = current.id !== latest.id;
      latest = current;
      if (changed || headId === undefined) await this.store.putWorkspaceHead(render.id, latest.id, context);
      this.retryAfter.delete(retryKey);
      return { component: latest, workspace: status(changed ? 'updated' : 'current', latest, revisions, binding.pollIntervalMs, checkedAt) };
    }
    if ((this.retryAfter.get(retryKey) ?? 0) > Date.now()) {
      return { component: latest, workspace: status('compile_failed', latest, revisions, binding.pollIntervalMs, checkedAt, 'The edited source has not compiled successfully yet; showing the last good revision.') };
    }
    try {
      const compiled = await this.compiler.compileWorkspace({
        entryPath: binding.entryPath,
        title: binding.title,
        description: binding.description,
        authoringProfile: binding.authoringProfile,
      }, context);
      if (!await this.compiler.isWorkspaceComponentCurrent(compiled as CompiledReactComponent)) {
        this.retryAfter.set(retryKey, Date.now() + binding.pollIntervalMs);
        return {
          component: latest,
          workspace: status(
            'compile_failed', latest, revisions, binding.pollIntervalMs, checkedAt,
            'Workspace source or dependencies changed while compilation was in progress; showing the last good revision.',
          ),
        };
      }
      latest = await this.store.putComponent(compiled, context);
      if (!revisions.some((candidate) => candidate.id === latest.id)) revisions.push(latest);
      if (!await this.compiler.isWorkspaceComponentCurrent(latest)) {
        this.retryAfter.set(retryKey, Date.now() + binding.pollIntervalMs);
        const previous = await this.store.getComponent(headId ?? render.componentId, context);
        return {
          component: previous,
          workspace: status(
            'compile_failed', previous, revisions, binding.pollIntervalMs, checkedAt,
            'Workspace source or dependencies changed before the revision could be activated; showing the last good revision.',
          ),
        };
      }
      await this.store.putWorkspaceHead(render.id, latest.id, context);
      this.retryAfter.delete(retryKey);
      return { component: latest, workspace: status(latest.id === (headId ?? render.componentId) ? 'current' : 'updated', latest, revisions, binding.pollIntervalMs, checkedAt) };
    } catch (error) {
      this.retryAfter.set(retryKey, Date.now() + binding.pollIntervalMs);
      return { component: latest, workspace: status('compile_failed', latest, revisions, binding.pollIntervalMs, checkedAt, boundedDiagnostic(error)) };
    }
  }
}

function workspaceBindingKey(render: ReactUiRender): string {
  const binding = render.workspace!;
  return JSON.stringify([
    render.scopeKey,
    render.id,
    render.componentId,
    binding.version,
    binding.key,
    binding.entryPath,
    binding.title,
    binding.description ?? '',
    binding.authoringProfile?.id ?? '',
    binding.authoringProfile?.version ?? '',
    binding.pollIntervalMs,
  ]);
}

function matchesWorkspace(component: CompiledReactComponent, render: ReactUiRender): boolean {
  const binding = render.workspace!;
  return component.sourceKind === 'workspace_file' &&
    component.sourcePath === binding.entryPath &&
    component.title === binding.title &&
    (component.description ?? '') === (binding.description ?? '') &&
    (!binding.authoringProfile || (
      component.authoringProfile?.id === binding.authoringProfile.id &&
      component.authoringProfile.version === binding.authoringProfile.version
    ));
}

function status(
  state: ReactUiWorkspaceRevisionStatus['status'],
  component: CompiledReactComponent,
  revisions: readonly CompiledReactComponent[],
  pollIntervalMs: number,
  checkedAt: string,
  diagnostic?: string,
  incompatibility?: ReactUiWorkspaceRevisionStatus['incompatibility'],
): ReactUiWorkspaceRevisionStatus {
  return {
    live: true,
    status: state,
    checkedAt,
    componentId: component.id,
    sourceDigest: component.sourceDigest,
    bundleDigest: component.bundleDigest,
    revision: Math.max(1, revisions.findIndex((candidate) => candidate.id === component.id) + 1),
    dependencyCount: component.buildGraph?.inputs.length ?? component.inputs.length,
    pollIntervalMs,
    ...(diagnostic ? { diagnostic } : {}),
    ...(incompatibility ? { incompatibility } : {}),
  };
}

function boundedDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 2_000) || 'Workspace compilation failed.';
}
