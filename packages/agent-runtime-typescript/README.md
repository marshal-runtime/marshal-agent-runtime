# `@marshal/agent-runtime-typescript`

Workflow-free execution of agent-authored TypeScript and JavaScript modules.
Source is compiled with esbuild and evaluated in a dedicated Node child process
with cooperative, defense-in-depth restrictions. This package is not a security
boundary for malicious code.

It also exposes the authoring surface for bounded schema-validated drafts,
content-addressed candidates, and lifecycle delegation through the canonical
Runtime service accessor. Draft ownership and scope come from the host context,
and native activation remains the authority for installed contributions.

```ts
import { createInlineModuleExecutionProvider } from '@marshal/agent-runtime-typescript';

const inlineModules = createInlineModuleExecutionProvider();
const result = await inlineModules.execute(
  {
    source: `
      export default async (input, context) => {
        const discovery = await context.runtime.search({ query: input.question });
        const selected = discovery.matches[0]?.capability.name;
        if (!selected) throw new Error('No matching capability.');
        const exact = await context.runtime.search({ name: selected });
        return context.runtime.invoke(exact.matches[0].capability.name, input);
      };
    `,
    input: { question: 'find relevant code' },
  },
  { broker },
);
await inlineModules.dispose();
```

For editable source, resolve a workspace or runtime-artifact reference before
execution. Artifact access is supplied as a port, so this package has no
dependency on a particular artifact implementation or harness:

```ts
const module = await resolveTypeScriptModuleSource(
  { kind: 'workspace_file', path: '.agent/execution/analyze.ts', export: 'run' },
  { workspaceRoot },
);

const result = await executor.execute({
  source: module.source,
  filename: module.filename,
  entrypoint: module.entrypoint,
  sourceIdentity: module.identity,
  input,
});
```

Workspace paths are relative and containment-checked. Symbolic links are
rejected for the entry and every relative import. Inline and artifact source do
not gain ambient filesystem imports.

## Execution policies

- `brokered` (default) rejects all file, package, URL, and Node builtin imports.
  The VM context does not expose `process` or `require`, and the child uses the
  Node permission model plus a scrubbed environment to reduce accidental
  filesystem/process access. Input, broker responses, console writes, and timer
  handles cross a context-realm JSON bridge; authored code is not handed
  host-realm functions or objects. Modules reach the host only through
  serializable `context.runtime.search` and `context.runtime.invoke` RPC calls.
  Broad search is compact; an exact-name search returns the selected
  capability's complete schemas. Node's VM and permission model do not protect
  against actively malicious code; run untrusted source in an external
  OS/container/VM sandbox.
- `trusted` permits only packages in `allowedPackages` and Node builtins in
  `allowedBuiltins`. This mode exposes normal Node process facilities and is for
  locally trusted code, not hostile input.

Every invocation has a wall-clock timeout, `AbortSignal` cancellation, a combined
stdout/stderr byte limit, a fresh worker process and module cache, and a structured
result containing diagnostics and timing. The executor retains a bounded LRU of
digest-keyed esbuild contexts by default. A cache hit still rebuilds incrementally,
so esbuild validates the complete dependency graph and never executes stale bundled
behavior after an imported workspace file changes. Set `compilationCache: false`
to force cold compilation or `maxCompilationCacheEntries` to bound the retained
contexts. The result's compilation receipt distinguishes `miss`, `hit`, and
`disabled` and records dependency-graph validation.
Call `dispose()` when an executor or provider reaches the end of its lifecycle;
this closes retained esbuild contexts and terminates idle prewarmed workers.

Brokered executions also keep one bounded, idle prewarmed worker so cache hits
do not pay process startup on the critical path. Each invocation still consumes
a fresh worker and creates a fresh VM/module record; the replacement process is
started in parallel for the next call. Trusted executions are never prewarmed or
reused because they can observe process state and their configured working
directory.

Node 22.13 or newer is required because execution uses the stable
`--permission` flag. Earlier Node 20/22 releases used experimental flag names and
are not supported by this package.

Results also include the source SHA-256, the digest of every bundled workspace
source file, imported package names and resolved versions, imported Node
builtins, Node/platform identity, a module digest, and an environment
fingerprint. Runtime failures retain source-mapped file/line diagnostics.
