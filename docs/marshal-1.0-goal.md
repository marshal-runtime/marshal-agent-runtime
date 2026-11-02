# Marshal 1.0 goal

## Objective

Build, validate, and publish Marshal as a harness-neutral programmable
augmentation layer that makes agents measurably more capable.

Marshal gives an agent ambient cross-task memory, editable TypeScript
execution, composable runtime capabilities, durable artifacts, and optional
agent-authored MCP Apps ranging from compact inline controls to complete
fullscreen or picture-in-picture applications.

The TypeScript substrate is general-purpose. It may solve an ordinary task,
perform pure computation, compose runtime capabilities, or serve as an
application backend. React is an optional presentation layer. Memory,
attachments, code intelligence, jobs, scheduling, and subagents are optional
capabilities. Each layer composes with the others, but none requires them.

All behavior remains scoped, permissioned, observable, receipted,
restart-safe, and portable. Codex is the first complete reference adapter and
experimental boundary, never a dependency of the portable runtime.

Completion requires cross-host conformance, installation outside the
development repository, comparative Codex evaluations, reproducible examples,
and publication-ready evidence.

## Operating philosophy: programmable concurrency

Marshal changes the agent's execution model, not merely its tool inventory.
The main model remains the goal-owning orchestrator. Editable TypeScript
execution blocks are dynamic programs in which the model can compose ordinary
code, packages, runtime capabilities, specialized models, native agents,
memory, artifacts, attachments, jobs, scheduling, and application backends.

- Treat deterministic computation, I/O, specialized cognitive work, and
  harness-native agents as composable system components with explicit inputs,
  outputs, dependencies, limits, and receipts.
- Start independent work concurrently. A Brain recall, several delegated
  investigations, deterministic parsing, and artifact preparation may overlap.
  Await a result only at the dependency boundary where the next decision needs
  it; cancel work that has become irrelevant and collect useful partial results.
- Use short execution blocks for small operations and longer blocks for bounded
  research, orchestration, or application work. Duration alone is not failure;
  hidden serialization, duplicate work, unbounded fan-out, and waiting on
  unrelated dependencies are failures.
- The Memory Brain is one specialized cognitive component. It may run inline
  when its evidence gates the next decision, or asynchronously while the main
  agent advances independent work. The main agent owns the overall plan without
  having to perform the Brain's internal hierarchy, ranking, or persistence
  mechanics.
- A custom application is another composition target: authored React is an
  optional client, while editable TypeScript and granted runtime capabilities
  form its backend. The same execution substrate also improves ordinary
  non-UI tasks and must not be reserved for “super app” requests.
- “Agent lambdas” are a conceptual building block—a bounded invocation of a
  specialized agent or model—not a new workflow, stage, or lambda DSL in the
  portable runtime. The program itself expresses the dynamic process.
- Harness adapters prefer injected host-native model and agent callbacks using
  the user's existing product authentication. Production execution must not
  shell out to `codex exec` or launch a fresh general-purpose CLI task for each
  model/agent call. A persistent official SDK/app-server transport may exist as
  a detachable, explicitly measured compatibility adapter when a host callback
  is unavailable; it is never a portable-runtime dependency.
- One source manifest projects this philosophy into compact MCP instructions,
  skills, lifecycle briefings, capability descriptions, editable examples, and
  routing evaluations. A fresh installed session must discover the pattern
  naturally without the user naming Marshal, TypeScript, MCP, workflows, or
  subagents.

Acceptance evidence includes a trace where several heterogeneous operations
overlap and the measured critical path is materially shorter than their
sequential sum, while dependency ordering, permission checks, cancellation,
bounded concurrency, parent-child receipts, and no-orphan guarantees remain
correct.

## Product behavior after installation

Marshal must work naturally alongside user requests. A user should not need to
say “use Marshal” in order for an agent to:

- remember or recall relevant durable information;
- choose editable TypeScript when it improves an ordinary task;
- discover and compose runtime capabilities;
- create an appropriate custom inline view or larger application;
- reuse a prior module, artifact, memory, or application;
- delegate to subagents or start durable work when the task benefits from it.

Natural use does not mean indiscriminate use. The agent must select Marshal
regularly on tasks where it materially improves correctness, speed,
editability, durability, interactivity, or reuse, while avoiding unnecessary
activation on simple tasks that are better handled directly.

One portable capability manifest is the source of truth for discovery and
routing. Adapters project it into MCP server instructions, tool metadata,
skills, lifecycle briefings, native callbacks, examples, and evaluation labels.
The most important selection guidance must fit in the first 512 characters of
MCP server instructions.

Routing quality is measured with direct, indirect, and negative golden prompts,
following OpenAI's metadata guidance:

- https://developers.openai.com/plugins/guides/optimize-metadata

The headline evaluation never explicitly asks the model to use Marshal.

## Architectural boundaries

### Portable runtime

The portable runtime owns:

- capability descriptors, discovery, and execution;
- scopes, permissions, approvals, cancellation, receipts, and provenance;
- lifecycle and identity contracts;
- editable TypeScript module contracts;
- memory, artifacts, attachments, code-intelligence, and job provider ports;
- MCP Apps resources, render bindings, state, and structured fallbacks;
- typed effect intents for host-native behavior;
- deterministic conformance suites.

Portable packages never import Codex, ChatGPT, Electron, Claude, an IDE, or
another harness implementation.

### Harness adapters

An adapter owns:

- stable user/profile, project, workspace, session, and agent identity mapping;
- MCP registration and transport details;
- lifecycle hooks and prompt/context injection;
- host capability detection and presentation support;
- approvals, cancellation, notifications, and native effects;
- native subagent, scheduling, navigation, browser, or task integration;
- adapter-specific installation and packaging.

Unsupported host features remain explicit and degrade through portable
fallbacks.

### UI component-library profiles

UI component libraries are an adaptive authoring layer, not a runtime
dependency.

Each adapter may expose a versioned UI authoring profile containing:

- available component packages and versions;
- host-recommended primitives and usage guidance;
- theme tokens and standardized CSS variables;
- presentation modes and optional host extensions;
- accessibility and layout constraints;
- package/import policy for authored components.

An OpenAI adapter may recommend `@openai/apps-sdk-ui`; another harness may
provide a different kit. The portable UI compiler and renderer must work with
either profile and must also support completely custom React, CSS, and
allow-listed packages without any component library.

Host-specific kits are bundled or feature-detected at the adapter edge. Core
behavior, data, actions, persistence, and fallbacks never depend on one kit.

## Workstream: programmable TypeScript

`runtime_exec` is a general execution substrate available independently of UI.

It must support:

- disposable inline source when reuse is unnecessary;
- editable workspace and scoped artifact modules;
- iterative edit, rerun, diagnostics, and reuse;
- pure computation with no capability discovery requirement;
- brokered composition through `context.runtime.search` and
  `context.runtime.invoke`;
- explicit trusted execution with package and Node builtin allowlists;
- parent-child receipts for every nested capability call;
- durable job or subagent handles for work that outlives one invocation;
- schema-first module inputs, outputs, actions, and provenance.

The agent should choose TypeScript by task shape. It should prefer it for
bounded processing, reusable logic, substantial intermediate data, or
multi-capability composition, and avoid it when one direct tool call or a
simple native command is clearer.

OpenAI's current programmatic-tool guidance recommends the same task-shaped
selection and matched evaluation of correctness, completeness, tokens,
latency, cost, calls, and retries:

- https://developers.openai.com/api/docs/guides/latest-model

Acceptance targets:

- cold compile and execution p95 at or below 1 second;
- verified cached execution p95 at or below 250 milliseconds;
- app-action dispatch overhead p95 at or below 500 milliseconds, excluding the
  invoked operation;
- edited source always changes its digest and behavior;
- unchanged source never returns stale behavior;
- nested calls enforce the same permissions and approvals as direct calls;
- brokered escape, cancellation, timeout, output-limit, and trusted-import
  suites pass;
- agent-choice evaluations improve task success or efficiency without causing
  gratuitous TypeScript use on negative controls.

## Workstream: ambient memory

Memory is infrastructure operated through a specialized Memory Brain, not a
low-level subsystem that the main model must understand while coordinating the
rest of a task.

- The normal model-facing surface is semantic:
  `memory.brain.recall`, `memory.brain.remember`, `memory.brain.observe`, and
  `memory.brain.reflect` (names may be projected idiomatically by an adapter).
- A smaller specialized model such as Luna owns memory proficiency: hierarchical
  scope selection, SQLite short-term memory, filesystem and code-index-backed
  long-term projections, query refinement, ranking, pointer expansion,
  deduplication, correction, placement, provenance, and abstention.
- The long-term graph adapter must expose and prove memory-aware relationships
  (memory search/context, memory-to-code links, reverse blast radius, related
  memories, sessions, and supersession). Generic code-text search is a degraded
  fallback and must never be reported as a unified memory graph. Code-index
  adapters remain separately packaged under their own license and connect
  through the portable memory-graph port.
- Recall is awaited only when the main agent needs its evidence. It runs through
  a warm persistent Brain service or an adapter-supplied low-latency model
  callback; it must not launch a fresh general-purpose agent process per query.
- Explicit remember requests synchronously create a durable accepted receipt.
  The Brain classifies and places the memory, and requests requiring immediate
  subsequent visibility wait for a finalized receipt before task completion.
- User turns, tool evidence, checkpoints, and completion events are appended to
  a durable Brain queue without waiting for Luna. Ambient extraction,
  embeddings, deduplication, consolidation, summarization, and reflection run
  asynchronously with queued/running/completed/failed status, retry bounds,
  cancellation, restart recovery, and attributable receipts.
- Hooks remain fast event producers. They establish stable identity and scope,
  append bounded evidence, and may inject already-materialized Brain results;
  they never synchronously invoke a remote model or start the complete runtime.
- The warm Brain worker may research concurrently with independent main-agent
  work. The main agent awaits it only before reasoning that depends on the
  result.
- Low-level `memory.search`, `memory.get`, `memory.expand`, `memory.store`, and
  `memory.correct` operations remain available as the Brain's implementation
  substrate and as an explicit inspection, repair, deletion, or debugging
  escape hatch. They are not the normal cognitive burden placed on the main
  agent.
- A deterministic recognizer may remain as a disabled compatibility fallback;
  it is not the default product behavior and does not substitute for the Brain.
- Stable identity and scope ownership come from adapter contracts. User-owned
  workspace/project memory may be inherited by subagents, while session and
  agent-private memory remain isolated unless explicitly shared.
- Private memory content, Brain evidence, and materialized recall results stay
  in the protected owner-scoped memory store. Workspace-local lifecycle replay
  files contain only opaque job/receipt identifiers, status, and digests; replay
  must rehydrate content through current scope authorization and never persist
  plaintext private memory into the repository.
- Contradiction, supersession, expiry, deletion, scope, and asynchronous failure
  semantics are explicit and auditable.

Acceptance targets:

- explicit remember durably acknowledges acceptance in 100% of the
  deterministic suite, and immediate-visibility cases finalize before task
  completion;
- warm SQLite write/search/get/expand p95 at or below 250 milliseconds;
- cold SQLite write/search/get/expand p95 at or below 1 second;
- on the Codex reference adapter, a warm specialized Luna Brain turn has p95 at
  or below 2.5 seconds and a cold first turn at or below 6 seconds; adapters
  with faster model callbacks may declare stricter targets;
- hooks enqueue ambient evidence without a model call and meet their latency
  budget even when the Brain worker is unavailable;
- queued ambient work survives hook, MCP-server, and host restarts and exposes
  truthful terminal status and receipts;
- exact-fact recall across new tasks and unrelated workspaces succeeds in 100%
  of the deterministic suite;
- at 100,000 memories, Recall@5 is at least 0.90, nDCG@5 at least 0.85, and
  irrelevant injection at most 5%;
- isolation, contradiction, supersession, deletion, crash/replay, restart,
  compaction, concurrency, and subagent inheritance suites pass;
- no hook starts the complete runtime or waits on unrelated providers in the
  memory critical path.

## Workstream: capability fabric

Memory, artifacts, attachments, code intelligence, effects, jobs, scheduling,
subagents, and future providers remain independently discoverable and useful.

Every permitted capability can be invoked directly, from an editable
TypeScript module, or through a declared application action. Adding a provider
must not require changes to the execution or UI architecture.

All providers use bounded schemas, explicit scopes, permission decisions,
approvals where required, cancellation, provenance, and receipts.

## Workstream: dynamic agent orchestration

Editable TypeScript may act as a dynamic orchestration program. This does not
introduce a workflow, stage, or graph DSL into the runtime. The program itself
contains the ordering, branching, fan-out, retries, synthesis, and stopping
logic, and may revise that logic after the agent inspects or edits the source.

The runtime supplies small portable primitives for:

- creating a typed delegation request;
- spawning one or many harness-native agents;
- assigning isolated context, tools, permissions, skills, or worktrees;
- sending follow-up or steering messages;
- waiting for one, some, or all results;
- cancelling work and collecting partial outcomes;
- persisting task, job, artifact, and receipt handles;
- allowing a child agent to delegate again when the host truthfully advertises
  recursive delegation.

A module may choose its agent topology dynamically from intermediate results.
It is not limited to a fixed list of roles or a predetermined sequence. The
same execution may remain single-agent, launch a few independent specialists,
or coordinate a bounded tree of agents.

Every orchestration declares or inherits limits for depth, total agents,
concurrency, elapsed time, tokens or cost where available, retries, workspace
isolation, permissions, and external effects. Recursive delegation never
bypasses the authority of the parent request. Each child and nested capability
call is traceable to the originating module execution.

Acceptance targets:

- sequential, parallel, conditional, iterative, and recursive delegation pass
  deterministic adapter tests where the host supports them;
- unsupported recursive delegation returns a typed limitation and permits the
  program to flatten or continue with another strategy;
- cancellation propagates through the full tree;
- parent-child receipts reconstruct the complete execution tree;
- duplicate event delivery cannot create duplicate agents or effects;
- bounded orchestration of dozens of agents completes without unbounded context
  injection, leaked worktrees, orphan jobs, or hidden permission escalation;
- agentic evaluations compare the dynamic TypeScript route with direct main
  agent work and static/manual delegation on quality, elapsed time, tokens,
  duplication, conflicts, and unsafe actions.

## Workstream: adaptive applications

An agent may author a persistent, editable React application that uses no
backend beyond prepared props, invokes an authored TypeScript backend, or
composes any permitted Marshal capability.

The portable client exposes standards-first operations for:

- tool and declared-action calls;
- follow-up messages and model-context updates;
- display-mode requests;
- host context and capability subscriptions;
- tool input, partial result, final result, cancellation, and error events;
- standard sizing, teardown, and host-context changes;
- optional feature-detected host extensions.

Host presentation modes include inline, fullscreen, and picture-in-picture
when the host advertises them. React layout patterns include cards, lists,
grids, tables, editors, maps, graphs, dashboards, tabs, split panes, wizards,
carousels, and media galleries. Layout patterns are not protocol modes.

An app action binds a stable action ID to a schema-validated TypeScript module
export or runtime capability. The browser does not receive arbitrary source or
path authority. The runtime resolves the binding and applies normal scopes,
permissions, approvals, cancellation, and receipts. Trusted profiles may grant
broad capabilities deliberately without weakening the portable default.

Applications must:

- preserve editable frontend and backend source;
- render through a stable startup-registered entry point without hot tool
  registration;
- negotiate host features and accept denial or fallback;
- propagate theme, dimensions, safe areas, locale, and host-context changes;
- restore content and state after remount, history navigation, restart, and
  task changes;
- separate authoritative server state from local UI preferences;
- return complete structured and text fallbacks;
- version runtime renderer resources and preserve compatibility for historical
  messages;
- remain accessible and responsive in every advertised mode.

Standards and host guidance:

- https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/concepts/ui-guidelines
- https://developers.openai.com/plugins/reference

Acceptance targets:

- Codex and a standards-only MCP Apps host pass the same conformance suite;
- inline, fullscreen, and picture-in-picture transitions work when supported
  and degrade correctly when unsupported;
- cached redisplay performs no source write, compilation, or new render binding;
- cached runtime-side mount p95 is at or below 2 seconds and end-to-end display
  p95 at or below 10 seconds;
- hydration failure presents a useful fallback within 5 seconds;
- UI action calls are declared, schema-validated, permissioned, scoped,
  receipted, restart-safe, and covered by cross-host tests;
- 100 consecutive cached reopens succeed with no cross-scope state leakage.

## Workstream: Codex reference adapter

The Codex adapter is the first complete proof of the portable contracts. Once
the plugin is installed:

- new tasks and subagents receive compact capability awareness;
- memory writes and retrieval happen automatically;
- the model naturally chooses TypeScript and custom UI when beneficial;
- ordinary tasks remain free of unnecessary Marshal calls;
- lifecycle, approvals, native subagents, scheduling, and presentation map to
  Codex-owned surfaces;
- installation works in blank and unrelated repositories without absolute
  development paths;
- removing the Codex adapter leaves every portable package buildable and
  testable.

The runtime monorepo remains the contract incubator while APIs stabilize.
Packages stay independently publishable. After conformance is green, the Codex
adapter/plugin and public evaluation/examples can move into independently
versioned repositories without changing portable APIs.

## Workstream: evaluations and evidence

The headline comparison is stock Codex versus the identical Codex configuration
with Marshal installed and automatic routing enabled. The prompt does not name
Marshal.

Diagnostic arms separately measure explicit invocation, individual capability
ablations, and briefing/hook removal. Deterministic protocol conformance remains
separate from stochastic agent-performance evaluations.

Evaluation families cover:

- automatic routing and negative controls;
- memory, correction, scope, and delayed recall;
- ordinary TypeScript-assisted tasks and reusable modules;
- multi-capability composition;
- attachments, artifacts, and code intelligence;
- subagent and durable-job coordination;
- inline, fullscreen, and picture-in-picture applications;
- UI-triggered module and capability actions;
- history, restart, and non-UI fallback;
- ordinary control tasks where Marshal should remain unused;
- portability across Codex and a standards-only host.

The integrated non-memory capstone is a fresh-session, implicit-routing test:
the user asks for a Claude Design-class experience without mentioning Marshal,
TypeScript, subagents, or MCP Apps. Codex must autonomously decide to author a
dynamic TypeScript orchestration program, use a bounded team or tree of
product-native agents when useful, synthesize their work into editable frontend
and backend source, and present a persistent, fully usable design application
inside Codex.

The canonical frozen build prompt is sourced from
`docs/evals/v1/cases/ui.json#ui-design-studio-agent-orchestration-capstone/build`
and has SHA-256
`c9b0e64795a9f63668ec51b816dcebafe79cea2ca6b4c95b8a68a13cb41ed80a`:

> Build me a complete interactive design workspace I can use here. I want to turn a product brief into several genuinely different interface directions, compare them side by side, select one, refine it conversationally and directly on the canvas, apply the supplied design system, inspect responsive states, and keep an editable implementation I can reopen and continue later. Handle the complex work efficiently and show me the finished usable workspace, not a static mockup or a plan.

Capture preparation, evidence verification, live-run instructions, and the
evaluation corpus must preserve this text byte-for-byte. The refinement and
restart phases remain separate same-task and restart-host evaluation prompts;
they are not part of the initial implicit-routing prompt.

The capstone environment pre-authorizes a documented bounded delegation and
execution profile. The model must not ask the user to choose Marshal or approve
the implementation strategy; operations that exceed the configured agent,
token, time, cost, permission, or effect bounds still require normal host
approval or fail explicitly.

The capstone must demonstrate:

- a chat-guided visual canvas or fullscreen design workspace;
- imported or adapter-selected design-system/component-library guidance;
- multiple design or interaction directions produced through useful parallel
  work rather than redundant fan-out;
- direct interaction and targeted refinement through application controls;
- iterative chat-driven source updates without rebuilding unrelated work;
- declared controls that invoke editable TypeScript backend actions;
- optional nested delegation where Codex advertises it;
- responsive inline and fullscreen behavior, plus PiP for ongoing work when
  supported;
- persisted source, versions, state, artifacts, receipts, and restoration;
- an honest fallback and trace for hosts that cannot render the application.

This is behavioral parity with the product class, not an attempt to copy
Anthropic's private implementation or visual identity. Reference behavior:

- https://support.claude.com/en/articles/14604416-get-started-with-claude-design
- https://claude.com/product/design
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/agent-teams

Before optimization, freeze and hash development and hidden task sets and
capture the untouched baseline. Use the same model, reasoning setting, tools,
workspace, timeout, and recorded external-data fixtures in both arms. Randomize
arm order, run at least three repetitions, predeclare metrics and failure
conditions, use objective graders where possible, blind human graders where
necessary, and publish every attempt rather than best-of-N results.

Each run records prompt and fixture hashes, model configuration, full redacted
trace, final response, generated files, permissions, receipts, timings, tokens,
cost, retries, failure category, UI evidence, and grader outcomes.

OpenAI evaluation references:

- https://platform.openai.com/docs/api-reference/evals
- https://developers.openai.com/api/docs/guides/latest-model

The release claim requires statistically positive paired improvement overall,
improvement in targeted capability families, and no greater than a
five-percentage-point regression on ordinary control tasks.

## Publication deliverables

- independently installable and versioned packages;
- generic MCP quickstart and Codex reference-adapter guide;
- adapter authoring guide and conformance kit;
- memory, module, UI-action, scope, permission, receipt, and security docs;
- versioned evaluation runner, corpus, graders, raw JSONL evidence, and report;
- editable samples spanning ordinary no-UI execution through full interactive
  applications;
- a public host/capability compatibility matrix;
- short MP4/WebM demonstrations with GIF previews, each linked to its uncut run,
  source, fixture, and trace;
- an honest limitations and threat-model section.

The flagship demonstration should combine memory, editable TypeScript,
attachments or project data, code intelligence, optional subagents, and a
persistent adaptive application. Smaller demonstrations must independently show
automatic memory, ordinary TypeScript assistance without UI, presentation-mode
adaptation, UI-triggered backend actions, restart recovery, portability, and a
matched stock-Codex comparison.

The public capstone demonstration is the fresh-session design-studio task from
the evaluation section. It must be shown as an uncut run as well as a short
launch video: request, autonomous routing, dynamic TypeScript orchestration,
bounded agent fan-out, synthesis, live application, interaction, iterative
refinement, and restoration after restart.

## Definition of done

Marshal 1.0 is complete only when:

1. Portable contracts and security boundaries are documented and conformant.
2. Installed agents use Marshal naturally and appropriately without explicit
   user prompting.
3. Memory is automatic, fast, scoped, and reliable across tasks and workspaces;
   a warm specialized Brain owns hierarchical recall and persistence while
   hooks enqueue ambient work asynchronously and the main agent uses semantic
   Brain operations rather than low-level memory mechanics.
4. TypeScript is appropriately selected for ordinary work, reusable logic,
   capability composition, and optional application backends.
5. Applications support every host-advertised presentation mode and extension
   through capability negotiation.
6. UI libraries are interchangeable adapter authoring profiles, while fully
   custom UI remains supported.
7. Applications can call any granted capability through declared module-backed
   actions.
8. Dynamic TypeScript orchestration can safely coordinate bounded trees of
   harness-native agents, including recursive delegation where supported.
9. The fresh-session design-studio capstone routes autonomously and produces a
   persistent, editable, fully usable application inside Codex.
10. History, restart, state, fallback, and failure behavior are deterministic.
11. Codex works as a detachable reference adapter outside the development
   repository.
12. Comparative evaluations demonstrate measurable improvement without
    material general-task regression.
13. Packages, docs, examples, benchmark data, evidence, videos, limitations,
    and security documentation are publication-ready.

## Non-goals

- Reintroducing workflows, stages, or lambdas as runtime abstractions.
- Forcing TypeScript, memory, UI, or subagents into every task.
- Replacing a clear direct tool call or native command merely to demonstrate
  Marshal.
- Coupling portable behavior to Codex or an OpenAI component library.
- Treating cooperative Node or browser isolation as a security boundary for
  actively malicious code.
