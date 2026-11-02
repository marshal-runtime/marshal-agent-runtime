# `@marshal/agent-runtime-composer`

Minimal, harness-neutral bindings around an existing
`@marshal/agent-runtime-core` kernel.

The composer owns no capabilities or state. A caller supplies a kernel, a fixed
principal, trusted workspace/project authority, and optional scoped lifecycle
and resource ports. The returned bindings normalize protocol versions and
invocation context while preserving cancellation signals, kernel responses, and
execution receipts.

```ts
import { composeAgentRuntime } from '@marshal/agent-runtime-composer';

const runtime = composeAgentRuntime({
  kernel,
  principal: { id: 'agent-main', kind: 'agent' },
  authority: { workspaceId: 'workspace-42', projectId: 'project-7' },
  lifecycle,
  resources,
});

const matches = await runtime.kernel.search(
  { query: 'memory' },
  { sessionId: 'session-1', signal },
);
```

## Dependency direction

This package depends only on `agent-runtime-core`. It does not construct
filesystem state, capability providers, memory, code intelligence, TypeScript
execution, effects, transports, or harness adapters.

Batteries-included presets depend outward on this composer and inject their
ports. The composer never imports a preset or a harness adapter. This keeps one
authority and normalization contract reusable across harnesses.

The composer does not own or dispose the supplied kernel or ports.
