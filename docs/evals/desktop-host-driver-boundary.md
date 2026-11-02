# Codex desktop-host evaluation boundary

Marshal's frozen UI and design-studio cases need evidence from the actual
Codex desktop render host. The checked-in command driver cannot currently
produce that evidence, and this repository does not contain a substitute that
claims otherwise.

## What the supported Codex API can prove

The documented [Codex App Server](https://learn.chatgpt.com/docs/app-server)
can start, resume, read, and stream threads and turns. Its event protocol
includes agent messages, commands, file changes, MCP tool calls, permissions,
receipts, diffs, plans, and token usage. Those signals are sufficient for the
non-visual part of an evaluation trace.

App Server powers rich clients, but its documented methods do not expose a
desktop-client render surface. In particular, the API has no operation to:

- make a thread visible in the Codex desktop window;
- wait until an MCP App resource is mounted by that window;
- capture a screenshot or video of a task message;
- click or inspect controls inside the rendered resource;
- request and observe inline, fullscreen, or picture-in-picture presentation;
- close, restart, and reopen the desktop product while retaining capture; or
- attest that a pixel file belongs to a particular thread, turn, MCP result,
  render id, and interaction.

The repository's Windows recorder can capture foreground pixels, but it
deliberately requires a human to navigate, click, request display modes, and
restart Codex. A video file and process trace alone cannot prove which UI was
rendered or which controls were exercised.

## Why desktop task tools do not close the gap

Codex desktop sessions can expose host-injected task tools to the model for
creating, reading, waiting on, and navigating to tasks. They are not a
documented executable or JSON-RPC endpoint available to the runner's standalone
command process. The `command` adapter contract launches a hash-pinned process,
sends one request on stdin, and expects one adapter result on stdout. That child
cannot invoke model-only desktop tools.

Even when those task tools are available in an interactive Codex session, the
currently exposed set does not include task-surface screenshot, click,
fullscreen/PiP, or application-restart operations. Driving App Server from the
child would therefore still be headless evidence, not desktop evidence.

## Fail-closed decision

Do not implement a desktop driver by:

- relabeling `codex exec` or App Server events as UI evidence;
- accepting an arbitrary image or video path without a host binding;
- inferring render success from a successful `runtime_render_*` tool call;
- adding hidden instructions that ask the evaluated model to self-report UI
  success; or
- treating an operator-started foreground recording as an automated matched
  evaluation.

Until a separately validated desktop coordination and capture boundary exists,
UI-required cases must remain `evidenceClass: "unavailable"`, `status:
"skipped"`, and excluded from release claims. `uiEvidence` must remain empty.
The existing Codex command driver enforces this behavior before model
invocation.

## Minimum interface needed to unblock the driver

A future desktop-host adapter needs a documented or separately validated,
hash-pinnable host boundary that provides all of the following:

1. Create a fresh visible desktop task with the exact pinned treatment,
   project, model, reasoning, permissions, and plugin inventory.
2. Start/resume turns and return the authoritative App Server event stream.
3. Open the exact task and wait for a specified MCP resource/render id to mount.
4. Capture screenshots or continuous video with digests and a binding to the
   thread, turn, render id, host build, and capture time.
5. Invoke or observe authored UI controls and presentation-mode requests, with
   typed unsupported results when the host declines a mode.
6. Restart the desktop product, reopen the exact historical task, and preserve
   a continuous evidence chain.
7. Emit an attested result through the existing
   `adapter-result.schema.json` boundary without trusting evaluated-model prose.

This may be supplied by a future Codex desktop automation API or by an external
host broker with equivalent independently reviewed guarantees. Until then,
the missing desktop-host driver is an external host-API blocker rather than an
invitation to weaken the evidence contract.
