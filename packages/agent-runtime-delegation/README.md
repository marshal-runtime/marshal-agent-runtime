# `@marshal/agent-runtime-delegation`

Harness-neutral transport for spawning, continuing, observing, and explicitly
cancelling delegated agents. Portable code imports only this package; each
harness implements `DelegationAdapterPort` at its adapter edge.

The capability provider exposes exactly:

- `runtime.delegation.spawn`
- `runtime.delegation.continue`
- `runtime.delegation.wait`
- `runtime.delegation.cancel`

Spawn returns a runtime `delegationId` and the host session handle supplied by
the adapter. `parentDelegationId` records hierarchy only, allowing explicitly
requested recursive cancellation. Continue sends another prompt to the existing
host session. Wait has no transport timeout and observes until the delegation
is `done` or `failed` without cancelling it. A cancellation is an explicit
operation whose terminal record is `failed`, not a separate lifecycle state.

```ts
import {
  DelegationManager,
  InMemoryDelegationStore,
} from '@marshal/agent-runtime-delegation';

const manager = new DelegationManager({
  adapter: myHarnessAdapter,
  store: new InMemoryDelegationStore(),
});

const child = await manager.spawn(
  { prompt: 'Audit the security model.' },
  { scope: { workspaceId: 'design-review' } },
);

const result = await manager.wait(
  { delegationId: child.delegationId },
);
```

Records are published only after the host returns from spawn. They contain only
`delegationId`, optional `parentDelegationId`, optional `adapterHandle`, `state`,
optional `result`, plain `error`, and optional direct `changeRefs`. The launch
prompt and invocation scope are passed to the adapter but are not stored.
Adapter failures before a host session exists are thrown unchanged.

A launch may also carry an optional `baseRef`: the start point an isolated
workspace is created from. The transport only carries it to the adapter, which
owns every workspace and version-control decision; it is never recorded on the
delegation.

A launch can also shape the child agent itself. `systemPrompt` replaces the
system prompt the host would assemble, `tools` is the host tool allowlist (an
empty list grants no tools), and `attachments` names local files to attach to
the launch prompt. The transport only carries these fields to the adapter,
which decides how its harness applies them. They are never recorded on the
delegation.
