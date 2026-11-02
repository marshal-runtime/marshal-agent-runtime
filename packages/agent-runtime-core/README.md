# `@marshal/agent-runtime-core`

A dependency-light capability kernel that can be embedded in any agent harness.
The package owns the transport-neutral contracts and behavior behind two
agent-facing operations:

- `runtimeSearch(request, context)` discovers ranked capabilities.
- `runtimeExec(request, context)` authorizes and invokes one capability.

Harness adapters decide how those operations are exposed (for example, as native
tools or over MCP) and translate their own session state into an
`InvocationContext`. Capability providers remain independent of the harness.

## Example

```ts
import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeKernel,
  createAllowAllPermissionBroker,
} from '@marshal/agent-runtime-core';

// Development/test only. Production hosts should inject their policy broker.
const runtime = new RuntimeKernel({
  permissionBroker: createAllowAllPermissionBroker(),
});

runtime.register({
  id: 'example',
  async list() {
    return [
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'example.echo',
        version: '1.0.0',
        description: 'Returns the supplied value.',
        tags: ['example'],
      },
    ];
  },
  async invoke(_name, input) {
    return { output: input };
  },
});

const result = await runtime.runtimeExec(
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    target: 'example.echo',
    input: { hello: 'world' },
  },
  {
    principal: { id: 'agent-1', kind: 'agent' },
    scope: { sessionId: 'session-1' },
  },
);
```

Adapters may use the shorter `search()` and `execute()` aliases. An
`inline_module` execute request is routed to the legacy-compatible
`runtime.inline_module.execute` capability by default. A portable `module`
request is routed to `runtime.module.execute` and can carry an inline,
workspace-file, or artifact source reference:

```ts
await runtime.execute(
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    targetType: 'module',
    module: {
      kind: 'workspace_file',
      path: '.agent/execution/analyze-project.ts',
      export: 'run',
    },
    input: { query: 'authentication' },
  },
  context,
);
```

Core transports the source identity but never reads it. The executor host owns
containment, artifact lookup, source limits, and import policy. This package deliberately
does not compile source itself: an executor provider supplies the trusted or
isolated execution policy for its host.

Bare kernels fail closed: when no permission broker is configured,
`runtimeExec()` returns `denied` with `permission_broker_required` and never
invokes the provider. `createAllowAllPermissionBroker()` is a deliberately named
opt-in intended for tests and local development.

Broad `runtimeSearch()` calls return `detail: "summary"` by default. Summary
descriptors retain identity, description, tags, permissions, and provider
ownership while omitting input/output schemas and annotations. After choosing a
capability, pass its exact `name`; exact lookup always returns `detail: "full"`
with the complete schemas, even if a caller supplied `detail: "summary"`.
Compatibility callers that need every schema from broad discovery may request
`detail: "full"` explicitly. `query` remains the semantic-discovery field,
while `tags` is an explicit all-tags filter.

## Integration contract

Providers expose descriptors and invocation handlers. The kernel supplies
provider identity, deterministic discovery, duplicate-name protection,
permission decisions, standardized failures, receipts, provenance, diagnostics,
and lifecycle signals. Registration returns an idempotent disposable so adapters
can cleanly detach providers.

Every capability descriptor must declare a strict object `outputSchema` for its
semantic `result.output` value: explicit top-level properties and
`additionalProperties: false`. The kernel validates that value after provider
execution and before returning it. A mismatch fails closed with
`capability_output_schema_mismatch`; provenance, diagnostics, artifacts, and
provider receipts remain outside the semantic schema and are not conflated with it.

The core has no runtime dependencies. Policy, persistence, transport, process
isolation, rendering, and approval user experience belong in adapters or
providers.

## Native effects and background jobs

Core exports transport-neutral contracts for optional harness callbacks:

- `RuntimeEffectRequest`, the five effect result envelopes,
  `RuntimeEffectHandler`, durable replay identity, and effect execution receipts;
- durable job handles/records, `RuntimeBackgroundJobHandler`,
  `RuntimeBackgroundJobStore`, command responses, and command receipts.

These are dependency-inversion ports, not Codex APIs. The implementation and
agent-facing `CapabilityProvider` live in `@marshal/agent-runtime-effects`.
Checkpoints are serializable data only; resumption requires an explicitly
registered callback and never attempts to serialize a JavaScript continuation.
Invocation contexts may include a stable harness identity independently from
their principal and workspace/project/session scopes. Every execution receipt
records that identity and an explicit `{rootExecutionId,parentExecutionId?,depth}`
lineage tuple. Brokers carry the root forward and increment depth, so
`buildRuntimeReceiptForest()` can reconstruct nested capability, application,
and delegation traces. A host can inject `receiptSink`; persistence failures are
observational and never rewrite the capability outcome.

Adapters may also attach an opaque receipt-correlation context created by the
core helper. The resulting optional `correlations` array is bounded to the
declared transport/tool-use/caller-request identifiers, labels transport versus
untrusted correlation authority, and digests long strings. Arbitrary invocation
metadata is never copied into execution receipts.
