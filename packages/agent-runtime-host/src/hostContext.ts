import {
  createRuntimeCompositionServiceDescriptor,
  type RuntimeCompositionServiceDescriptor,
} from '@marshal/agent-runtime-composer';
import type {
  RuntimeHarnessIdentity,
  RuntimePrincipal,
} from '@marshal/agent-runtime-core';

export interface RuntimeHostContextSnapshot {
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly stateRoot: string;
  readonly worktreeRoot: string;
  readonly protectedLifecycleResultRoot: string;
  readonly principal: RuntimePrincipal;
  readonly identity: RuntimeHarnessIdentity;
}

export interface RuntimeHostContextService {
  snapshot(): RuntimeHostContextSnapshot;
}

const hostContextContract = {
  name: '@marshal/agent-runtime-host:context',
  version: '1',
  methods: [{ name: 'snapshot', version: '1' }],
} as const;

export const RUNTIME_HOST_CONTEXT_SERVICE:
RuntimeCompositionServiceDescriptor<RuntimeHostContextService> =
  createRuntimeCompositionServiceDescriptor(
    '@marshal/agent-runtime-host:context',
    hostContextContract,
    'hostContext',
  );

export function createRuntimeHostContextService(
  snapshot: RuntimeHostContextSnapshot,
): RuntimeHostContextService {
  const value = Object.freeze({
    ...snapshot,
    principal: Object.freeze({
      ...snapshot.principal,
      ...(snapshot.principal.claims
        ? { claims: Object.freeze({ ...snapshot.principal.claims }) }
        : {}),
    }),
    identity: Object.freeze({ ...snapshot.identity }),
  });
  return { snapshot: () => value };
}
