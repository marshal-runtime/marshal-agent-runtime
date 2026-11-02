# Portable UI application contract

## Purpose

Marshal UI turns a runtime result into an interactive application without making
the portable runtime depend on Codex, ChatGPT, Electron, or another harness.
Agent-authored applications remain editable React and TypeScript artifacts. A
harness adapter supplies transport and optional host integrations, while the
portable runtime owns compilation, declared actions, permissions, persistence,
receipts, and structured fallbacks.

This contract follows the open MCP Apps protocol first. Host-specific APIs and
component libraries are optional adapter features, not requirements of a Marshal
application.

## Terminology

### Host-negotiated presentation modes

Presentation modes change how the host allocates space to an application. They
are protocol capabilities, not React component types.

- `inline` renders with the conversation and is the universal baseline.
- `fullscreen` gives a complex application a larger focused workspace.
- `pip` keeps an ongoing or live experience visible while the conversation
  continues.

An application declares the modes it supports, reads the modes offered by the
host, and requests a transition. The host may deny a request or return a
different mode. Applications must remain functional inline when a richer mode
is unavailable. Declaring `fullscreen` or `pip` is also an authoring promise:
the rendered application exposes a visible, named control for that mode. The
control feature-detects host availability, may remain disabled with an
explanation when unsupported, and reports the typed transition result instead
of silently disappearing.

### React layout patterns

Cards, lists, grids, carousels, galleries, maps, charts, dashboards, tabs, split
panes, editors, and multi-step flows are layouts authored inside a presentation
mode. They are not separate MCP display modes. The same React application may
adapt its layout as the host changes mode, size, safe area, or input method.

Typical guidance is:

- use compact cards for a summary and a small number of immediate actions;
- use carousels for a bounded set of visually comparable, image-rich items;
- use fullscreen for exploration, editing, navigation, or multi-step work;
- use PiP for ongoing status, playback, monitoring, or another live activity.

These are authoring recommendations, not restrictions on custom React.

## Dependency boundary

```text
agent-authored React/TypeScript
        |
        v
portable Marshal UI client ----> MCP Apps bridge
        |                              |
        v                              v
declared runtime actions         harness adapter
        |                              |
        v                              +--> host presentation
permissions, scopes, receipts          +--> optional host extensions
        |
        v
portable providers and artifacts
```

### Portable core owns

- UI source, compiled resources, render bindings, and content-addressed or
  explicitly versioned resource identifiers.
- The host-neutral UI client and MCP Apps lifecycle.
- Module-backed action declarations and generated typed action clients.
- Input and output validation, permission decisions, scope enforcement,
  cancellation, provenance, and receipts.
- Session, project, and workspace persistence behind explicit state contracts.
- Structured and textual fallback results.
- Shared MCP Apps and adapter conformance tests.

Portable packages must not import a harness SDK, a host-owned UI library, or a
host-specific global such as `window.openai`.

### Harness adapters own

- Transport between the MCP Apps iframe and the host.
- Translation of host context, supported display modes, lifecycle events, and
  optional native effects into portable contracts.
- Feature detection for host-only APIs such as product-specific modals, file
  pickers, checkout, navigation, or notifications.
- Registration and delivery of adapter-supplied authoring profiles.
- A truthful unsupported result when the host cannot provide a requested mode or
  effect.

An adapter may enhance an application, but must not be required for its core
workflow. Codex is the first conformance target, not a dependency of the UI
runtime.

## Portable UI client

Every compiled application receives one versioned client contract. The concrete
API may use hooks or signals, but it must expose equivalent behavior to:

```ts
interface MarshalUiClient {
  readonly host: {
    context: HostContext;
    capabilities: HostCapabilities;
    displayMode: 'inline' | 'fullscreen' | 'pip';
  };

  callAction<TInput, TOutput>(
    action: string,
    input: TInput,
  ): Promise<ActionResult<TOutput>>;

  bindActionControl(
    action: string,
    handler: (context: { requestId: string; actionId: string; signal: AbortSignal }) => Promise<unknown> | unknown,
  ): () => void;

  callTool<TInput, TOutput>(
    tool: DeclaredToolReference<TInput, TOutput>,
    input: TInput,
  ): Promise<ToolResult<TOutput>>;

  sendMessage(message: UiMessage): Promise<void>;
  updateModelContext(update: ModelContextUpdate): Promise<void>;
  requestDisplayMode(
    mode: 'inline' | 'fullscreen' | 'pip',
  ): Promise<DisplayModeResult>;
  openLink(request: OpenLinkRequest): Promise<OpenLinkResult>;
  supportsHostExtension(namespace: string, method: string): boolean;
  callHostExtension(
    namespace: string,
    method: string,
    args?: readonly unknown[],
  ): Promise<HostExtensionResult>;

  subscribe(listener: (event: UiLifecycleEvent) => void): () => void;
}
```

The client must implement the MCP Apps initialization handshake and support the
standard tool-input, partial-input, tool-result, cancellation, host-context,
size-change, and teardown lifecycle. It must expose theme, typography tokens,
locale, timezone, platform, container dimensions, safe areas, and available
display modes when the host supplies them.

The portable API uses standard MCP Apps requests for tool calls, messages,
model-visible context, display-mode changes, links, and supported resource
access. Host-only features are discovered through optional, namespaced adapter
extensions rather than added to the portable interface as universal behavior.
The versioned renderer currently relays an allowlisted, feature-detected set of
OpenAI file, modal, close, and navigation helpers. Unsupported methods return a
typed result and are never forwarded speculatively.

## Module-backed declared actions

Interactive controls must invoke declared actions, never arbitrary script text
or an unrestricted runtime escape hatch.

An authored module may export one or more action handlers. Each UI artifact
records a manifest similar to:

```ts
interface UiActionDeclaration {
  id: string;
  version: string;
  target:
    | { kind: 'capability'; capability: string }
    | {
        kind: 'module';
        module:
          | { kind: 'workspace_file'; path: string; export?: string }
          | { kind: 'artifact'; path: string; scope?: StateScope; export?: string };
        executorCapability?: string;
      };
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  allowedScopes: Array<'session' | 'project' | 'workspace'>;
  requiredPermissions: string[];
  risk: 'read' | 'write' | 'external-effect';
  idempotency: 'required' | 'supported' | 'none';
}
```

At execution time, the runtime must:

1. Resolve the action from the immutable artifact manifest.
2. Validate input before invoking the module export.
3. Bind the requested scope and originating render identity.
4. Run the normal permission and approval policy.
5. Propagate cancellation and bounded resource limits.
6. Validate the output and return a structured result.
7. Persist a receipt containing provenance, scope, permission decision, action
   version, and outcome.

The Codex adapter maps both target forms back into the portable kernel. A
capability action executes the named provider operation. A module action runs
the preserved editable workspace/artifact source through the normal module
executor and returns the authored export value while preserving the executor's
receipt. The adapter preflights declared permissions through the same broker;
the target capability is checked again by the kernel, so declarations cannot
grant authority.

Idempotent action records are principal- and state-scope-bound, immutable, and
durable. Concurrent calls with the same key serialize to one backend execution;
restart replays the recorded result, while reuse of the key with different
input, target, version, or scope fails explicitly.

A stable, initially registered app-visible dispatcher may route declared actions
by render ID and action name. This avoids depending on hot tool registration.
Direct calls to other MCP tools are allowed only when the UI manifest explicitly
declares those tool references and the host exposes them to the application.

Controls may initiate runtime execution, memory operations, attachment access,
code-intelligence queries, or delegation when those capabilities are installed
and permitted. UI authority never exceeds the authority of the current runtime
request.

A persistent application declares distinct Save and Reopen/Load actions and
binds their stateful handlers through `bindActionControl`. The portable outer
renderer derives named controls from the validated manifest outside the authored
iframe, so component media queries cannot hide them. Controls remain disabled
until bound, dispatch one handler per user activation, suppress duplicate or
concurrent requests, and provide an `AbortSignal` for user cancellation and the
bounded action timeout. Components pass that signal into `callAction` or other
cancellable work; chrome preserves typed denied, approval-required, cancelled,
and timed-out outcomes rather than collapsing them into generic failure.
Browser-local state may make the interface feel fast, but it cannot
replace an authoritative action-backed restore path.

## Custom React and authoring profiles

Marshal must support fully custom React and TypeScript. A component may use its
own visual language, interactions, data model, and approved package imports. The
runtime must not force every application into cards or into one vendor design
system.

An authoring profile is an interchangeable build-time description supplied by
the runtime installation or harness adapter:

```ts
interface UiAuthoringProfile {
  id: string;
  version: string;
  portable: boolean;
  packageImports: string[];
  packageVersions?: Record<string, string>;
  designTokens: Record<string, string>;
  templates: string[];
  authoringGuidance: string;
  requiredHostCapabilities: string[];
  optionalHostExtensions: string[];
}
```

Profiles may include:

- a standards-only profile using MCP Apps CSS variables and ordinary React;
- an OpenAI profile exposing `@openai/apps-sdk-ui` and ChatGPT-oriented
  authoring guidance;
- another harness's component library and native affordances;
- a product or repository-specific design system.

Profiles are selected from the current adapter's truthful capability descriptor.
The chosen profile ID and version become artifact provenance. Package resolution
and compilation remain permissioned. A component compiled with an optional
library should bundle what it needs; replay must not silently depend on the same
profile still being installed. When required host behavior is unavailable, the
runtime selects a compatible profile, recompiles from preserved source when
authorized, or returns the fallback.

The standards-only profile is always available. Host-specific styling must be
an enhancement, never the portability foundation.

Marshal exposes this descriptor through `ui.authoring.profiles.list` and
selection through `ui.authoring.profiles.select`. A compile request may name a
listed profile. Selection is evaluated against adapter-supplied host
capabilities; a request cannot self-advertise host support. The compiler adds
only the selected profile's imports to its existing explicit allowlist and
records selected/fallback provenance. `ui.render` then binds that exact profile
ID/version into the application manifest and rejects conflicting provenance.

## Responsive behavior and presentation transitions

Applications must treat display mode and container geometry as live state.
They should not infer a host from viewport width or user agent. A conforming
application:

- starts in the mode granted by the host;
- renders a useful inline experience without nested scrolling where practical;
- requests fullscreen or PiP only in response to a relevant workflow or user
  action;
- receives a visible, named, feature-detected renderer-chrome control for every
  non-inline mode it declares, independently of authored markup or width;
- reacts to host-context and dimension changes without recompilation;
- preserves application state across allowed mode transitions;
- remains usable with keyboard, touch, pointer, zoom, reduced motion, and host
  light or dark themes;
- handles a denied, unsupported, fallback, or timed-out display-mode request explicitly;
  a timeout cancels the correlated host request and ignores any late grant.

Modal presentation and other product-owned surfaces are adapter extensions, not
new portable display modes.

## State and restoration

State has three distinct owners:

- Ephemeral interaction state belongs to the React application.
- Durable user preferences and saved views use Marshal's bounded, versioned,
  explicitly scoped state service.
- Authoritative business data belongs to a runtime provider or external system
  and changes only through declared actions.

Browser-local storage is not an authoritative datastore. An adapter may
virtualize familiar browser APIs over scoped Marshal storage for compatibility,
but the portable state contract remains explicit and versioned.

A public tool result carries a stable render ID. The renderer must be able to
hydrate the compiled resource, data binding, and permitted persisted state from
that ID after remount, history replay, adapter restart, or a fresh task with the
same authorized scope. Restoration cannot depend exclusively on private result
metadata or an in-memory adapter cache.

## Fallback and graceful degradation

Every render-producing tool must remain useful in a client that does not support
MCP Apps. Its public result includes enough structured content and human-readable
text to understand the outcome and continue the workflow.

If rendering, hydration, a display-mode request, a host extension, or an action
fails, the application must show a bounded error and recovery action while the
tool result retains its fallback. Unsupported capabilities are ordinary typed
results, not indefinite loading states.

## Security requirements

- UI resources run in the host sandbox with the narrowest CSP, origin, and
  permission declarations that satisfy the artifact.
- UI resources and runtime renderer templates use immutable or explicitly
  versioned resource identifiers so host caches cannot replay incompatible code.
- The app can call only manifest-declared tools and actions.
- Sensitive data goes in component-private result metadata only when the host
  supports it, and never becomes the sole source required for restoration.
- External navigation, downloads, uploads, and native effects are explicit,
  permissioned operations.
- Custom packages and authored code use the runtime's trusted-code policy and
  bounded execution environment.
- All mutations and external effects return receipts.

## Conformance requirements

The shared UI suite must run against a standards-only MCP Apps host and every
adapter that advertises UI support. It covers:

1. Initialization and capability negotiation.
2. Inline rendering and standard size notifications.
3. Width-independent, visible, feature-detected outer fullscreen and PiP
   controls plus request, denial, transition, status, and inline-fallback behavior,
   including icon-only or missing authored controls.
4. Host theme, dimensions, safe areas, locale, and context changes.
5. Tool input, partial input, result, cancellation, and teardown delivery.
6. Visible manifest-derived Save and Reopen/Load controls, explicit stateful
   handler binding, duplicate suppression, and declared action/tool calls,
   including schema rejection, permission denial, approval, cancellation, and
   receipt completeness.
7. UI messages and model-context updates.
8. Cards, responsive carousels, image-rich layouts, and a complex fullscreen
   application as layout-level reference fixtures.
9. Editable-source recompilation and authoring-profile interchangeability.
10. Remount, history replay, adapter restart, and cross-task restoration within
    each allowed scope.
11. Structured fallback behavior in a host with no UI support.
12. CSP, sandbox, resource-versioning, and undeclared-action isolation.

## References

- [OpenAI: Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI: UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)
- [OpenAI: Plugin UI reference](https://developers.openai.com/plugins/reference)
- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP Apps build guide](https://modelcontextprotocol.io/extensions/apps/build)
- [MCP Apps specification, 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
