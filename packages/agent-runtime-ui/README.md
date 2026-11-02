# `@marshal/agent-runtime-ui`

Portable React UI capabilities for agent runtimes. This package has no Codex dependency.

## Capability model

- `ui.compile` bundles a workspace-relative `.tsx`, `.ts`, `.jsx`, or `.js` component. Its descriptor requires the high-risk `trusted_ui` permission.
- `ui.registered.compile` verifies a host-registered full build-graph attestation before returning a reviewed component.
- `ui.render` binds JSON props and a mandatory text/structured fallback to an immutable component.
- Read operations expose scoped component and render metadata.

The authored-state surface provides `ReactUiAuthoredStateStore`,
`ReactUiAuthoredStateProvider`, and `RUNTIME_AUTHORED_UI_STATE_SERVICE`.
Applications are isolated by principal and complete runtime scope, persisted as
digest-addressed snapshots, and updated with optimistic version checks.

Compilation produces content-addressed MCP App resources such as
`ui://marshal-react/<sha256>/index.html`. The resource has
`text/html;profile=mcp-app`, an inline-script/style hash CSP, and empty network,
resource, and frame domain allowlists. Workspace containment, source size,
bundle size, package imports, and scope ownership are enforced by the host-owned
compiler/store.

Registered components do not trust an entry-file hash alone. A host reviewer
freezes every esbuild input with `ReactUiCompiler.snapshotRegisteredGraph()`:
canonical workspace-relative or package-relative path, exact content digest,
and package name/version plus package-manifest digest. Compilation reads each
file once into an immutable in-memory snapshot and supplies those exact bytes
to esbuild. The complete observed graph must equal the reviewed graph before a
registered provenance record is returned; changed helpers, package source,
package identity, added imports, and removed imports fail closed. The snapshot
helper only creates review material—it does not register a component or grant
the lower-risk permission.

`ui.render` does not display the app. Its result contains a reusable display
instruction for `runtime_render_component({ renderId })`. A harness should call
that display entry point once immediately after creating the render and reuse
the same render ID for later “show it again” requests. Recompilation is needed
only after component source/import/title/description changes; a new render is
needed only after props or fallback change.

## Harness integration

`ReactUiMcpAppsResourceAdapter` exposes a transport-neutral resource plane:

- `listResources` / `readResource`
- `listRenderTools` / `invokeRenderTool`
- one fixed compiled-React template at `ui://marshal-react/runtime-renderer`

The fixed template lets a harness register its display tool at startup, so an
app created during a running task can render immediately without dynamic tool
hot-registration. It hydrates a sandboxed child without same-origin privilege,
network access, or eval; agent-authored code remains gated by `trusted_ui`.
Per-render tools use the non-reserved `marshal_render_react_<renderId>` prefix as
a compatibility path for hosts that support dynamic tool refresh.

Render results return both `structuredContent.props` and the complete fallback;
the compiled HTML is never model-visible. The bridge first accepts private
tool-result `_meta` when a host preserves it, then uses the app-only
`marshal_get_react_payload` tool as the portable path. Standard component
`localStorage` calls are virtualized through the app-only
`marshal_update_react_state` tool and a bounded scoped store, so state survives
secure iframe remounts without granting same-origin access. React UI records use
workspace/project/principal scope rather than task-session scope, so an existing
message remains recoverable after navigation or a harness restart. The static
renderer can recover a render ID from a cached public tool result when the host
does not replay the original tool-input event. Adapters may explicitly enable
one-time recovery of records written by the legacy session-scoped store.
Components compile against React's minified production build (a small card is
about 160 KB). `marshal_get_react_payload` accepts an optional
`knownComponentId`; when it names the render's current component, the payload
returns an empty `componentHtml`, so live-workspace polls and remounts of a
cached component do not ship the document again.
MCP Apps-capable
harnesses render the React application; other harnesses present
`fallback.summary` and `fallback.details` without losing the result.

Executable component and render records may be sealed by an injected
`ReactUiRecordAuthenticator`. With an authenticator configured, unsigned legacy
records are rejected by default and must be recompiled; `content-only` recovery
is an explicit unsafe migration mode for a host-controlled maintenance window.
The portable package includes an HMAC implementation but never chooses or
stores its key. A harness must keep the key and preferably the executable UI
state root outside agent-writable workspace state. Content addressing detects
corruption; the injected seal establishes host authenticity and prevents an
agent from fabricating a new self-consistent executable record.

The Codex MCP adapter maps this optional port shape to MCP resource and dynamic
tool handlers. It is a detachable first harness adapter, not a dependency of
this package.

## Adaptive application contract

The package exports a standards-first `MarshalUiClient` and browser parent
transport. Applications negotiate real host context and can subscribe to theme,
locale, timezone, platform, dimensions, safe-area, display-mode, tool input,
partial input, result, cancellation, error, and teardown changes. Inline is the
fallback; fullscreen and PiP requests return typed granted, denied, unsupported,
or fallback results. Tool calls, user messages, model-context updates, links,
and size notifications use MCP Apps methods.

The compiler injects that client into every authored bundle. Once host
initialization completes, the component receives a `marshal` prop already bound
to its render ID and validated application manifest. Non-React code can use the
same `window.__MARSHAL_UI_CLIENT__` instance or listen for `marshal:ready` and
`marshal:error`. Authored applications therefore call declared actions, tools,
messages, context updates, and display modes without implementing raw
`postMessage` RPC.

Host-specific features stay behind feature detection. The static renderer
advertises only the optional `window.openai` methods actually present in its
host and relays an allowlisted set through `marshal.callHostExtension(...)`.
This currently covers file selection/upload/download, host modals, close,
external navigation, and fullscreen open-in-app targets. Standards-first tool,
message, display-mode, sizing, and context methods remain the default; authored
code does not branch on a host product name.

`ui.render` optionally accepts a versioned application manifest. It declares
presentation modes, app-visible tools, local-state scope/version, authoritative
state references, authoring-profile provenance, and action bindings. Actions
may target an editable workspace/artifact module or a named runtime capability.
The optional `UiActionDispatcher` validates input and output schemas, requires a
declared scope, delegates authorization and execution to injected portable
ports, supports durable idempotency, and returns parent/target receipts through
the stable app-only `marshal_invoke_react_action` tool. Browser code never
receives an arbitrary module path or unrestricted runtime escape hatch.
Idempotency records are principal/scope bound, survive restart, reject key reuse
with changed input, and serialize concurrent calls sharing a key. Serialization
is storage-backed rather than dispatcher-local: an exclusive durable claim is
renewed while the backend runs, competing dispatchers poll the same scoped
lease, and an abandoned lease can be reclaimed after expiry. Completion checks
lease ownership and publishes an immutable result atomically. Claim, renewal,
takeover, completion, and release share a bounded per-key cross-process
transaction lock with token-bound expiry recovery, so PID reuse cannot preserve
an abandoned owner indefinitely and a delayed stale
reclaimer cannot steal a successor lease on either Windows or POSIX. Completed
results remove orphan leases before replay. Only successful
results are replayable; approval, denial, failure, and cancellation release the
claim so the same operation key can be retried.

The versioned outer renderer derives named fullscreen, picture-in-picture, and
persistent-application action controls directly from the validated manifest.
This chrome lives outside the authored sandbox, uses 40px minimum targets, and
never disappears at narrow widths. Host availability and every grant, denial,
fallback, or unsupported outcome remain explicit. Stateful Save/Reopen handlers
register through `marshal.bindActionControl(...)`; the renderer disables unbound
controls and suppresses duplicate/concurrent dispatch instead of guessing input
or replaying an unsafe effect. Bound handlers receive an `AbortSignal`; propagate
it to `marshal.callAction(..., { signal })` and other cancellable work. The outer
control exposes Cancel while work is pending, applies a bounded timeout, and
reports `denied`, `approval_required`, `cancelled`, and `timed_out` distinctly.
For an outer-control action, the renderer authenticates the pending request and
adds `receipt.activation`: the request ID, `outer-renderer-chrome` surface,
`marshal/ui/chrome-action-request` method, activation/dispatched/accepted
timestamps, and measured dispatch overhead. Successful idempotent results keep
that receipt in the scoped durable action-result record across restart. This
proves the portable activation path and timing; human-pointer versus disclosed
automation remains external capture evidence and is never guessed by runtime.

Local preferences are stored as versioned, compare-and-set snapshots. An
authoritative-state field is only a provider reference; business data is not
copied into browser storage. Session, project, and workspace state derive
separate principal-bound keys.

`UiAuthoringProfileRegistry` always provides a library-independent standards
profile. Harness adapters may add optional versioned component-library profiles
and host guidance. Those profiles affect authoring and provenance only; the
compiler, state, actions, and fallback contract do not import or require a host
UI library.

Profiles are discoverable through `ui.authoring.profiles.list` and resolvable
through `ui.authoring.profiles.select`. Agents consume the returned routing
guidance, design tokens, templates, accessibility requirements, layout
constraints, and normalized package roots before writing TSX. `ui.compile` accepts the selected
profile reference, unions only that profile's package imports with the
installation's explicit custom-package allowlist, and records the exact
selection or standards fallback in the component, artifact, and receipt. When
an application manifest is bound, `ui.render` stamps the compiled profile ID
and version and rejects a conflicting declaration. Host capabilities and any
adapter package resolver are construction-time ports; authored input cannot
claim host support or add compiler roots. Package authority is identity-based:
direct imports require an explicit package root and optional exact version, and
transitive imports require a declared dependency edge in the importing
package's snapshotted manifest. A `node_modules` pathname or adapter directory
never grants authority. Registered components fail closed when their audited
profile is unavailable. Direct profile packages enforce the adapter-advertised
exact version. Transitive declarations establish authority by package name;
Marshal does not reinterpret npm range syntax. Instead, the complete registered
graph attests the exact resolved transitive version and manifest digest, while
the package manager remains responsible for satisfying its declared range.

### Accessibility and layout validation boundary

Profile accessibility and layout fields are authoring requirements and
provenance, not a static WCAG certificate. The compiler structurally validates
the profile, exact profile selection, package authority, application manifest,
and immutable output. A release that claims an authored app is accessible and
adaptive must separately retain evidence for:

- rendered-app axe (or equivalent) checks in the target harness;
- keyboard-only operation, focus order/visibility, names, and live status;
- text zoom, reduced motion, light/dark theme, and safe-area behavior;
- a 320 CSS-pixel inline viewport plus negotiated fullscreen and PiP fallback;
- pixel/interaction review in the real host and independent accessibility review.

These are release/evaluation gates because JavaScript behavior, host styling,
and assistive-technology output cannot be proven from package/profile metadata.

The startup renderer resource is explicitly versioned at
`ui://marshal-react/runtime-renderer/1.2.0/index.html`; the previous unversioned
identifier remains readable for historical messages. Incomplete or missing
hydration is bounded to four seconds, after which the renderer shows the
render's complete text fallback when one was delivered, rather than leaving an
indefinite loading component.
