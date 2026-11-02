# Host and capability compatibility

The complete host, memory providers, and Codex adapter require Node 24.14+ from
an official distribution (or a compatible build with SQLite FTS5 enabled).
Portable packages that do not compose memory retain their declared Node 22.13+
floor.

This matrix distinguishes a portable contract from an adapter implementation
and from publication evidence. “Implemented” means source exists in this
repository; it does not mean every host has been observed doing it. “Live
pending” means the publication claim still requires an uncut run.

| Capability | Portable Node host | Codex reference adapter | Standards-only MCP Apps host | Generic MCP host without Apps | Publication evidence |
| --- | --- | --- | --- | --- | --- |
| Capability search and direct execution | Implemented | Adapter mapping implemented | Requires runtime tool mapping | Requires runtime tool mapping | Offline source validation; live pending |
| Brokered editable TypeScript | Implemented | Adapter exposes runtime execution | Host-independent when runtime tools are mapped | Available without UI | Offline examples plus one installed-host implicit edit/rerun; matched routing evaluation pending |
| Ambient memory observation | Hooks durably enqueue bounded evidence; long-lived worker runs Brain | Slim hook producer and persistent worker implemented | Requires lifecycle producer plus worker integration | Requires lifecycle producer plus worker integration | Deterministic queue/recovery/abstention tests; fresh-task live capture pending |
| Semantic Brain remember/recall | Direct runtime operations implemented | Adapter exposes operations and small-model reasoner | Available through runtime operation mapping | Available through runtime operation mapping | Historical candidate `d` completed two exact pairs and exposed a retry race; active candidate `e` completed three concurrent remember calls through one job per label, including two second-attempt successes, plus exact SQLite-authoritative recall; latency and complete corpus pending |
| Capability composition from TypeScript | Implemented with nested receipts and bounds | Available through adapter | Available through runtime execution | Available without UI | Fixture source; live receipt tree pending |
| Compiled React MCP App | Portable MCP Apps resource implementation present | Reference resource/display mapping present | Implemented by the named local `Marshal Standards MCP Apps Host` against the 2026-01-26 Apps contract | Unsupported; complete text fallback required | Hardened automated attempt `standards-host-security-20260803-k` rendered browser pixels from installed `@marshal/agent-runtime-ui`; all 10 report gates passed, while uncut human capture and independent review remain pending |
| Local host mutation boundary | Host-owned transport concern | Adapter/host-specific | `/tool` and `/event` require the exact active origin, exact JSON media type, same-origin fetch metadata when present, and a per-host 256-bit capability token | Adapter/host-specific | Attempt `k` observed the `local-request-boundary` gate; 3/3 focused tests passed, including seven rejected forged requests with no state mutation and one accepted protected declared-tool call |
| Declared capability action | Portable dispatcher implemented | Adapter action tool mapping present | Implemented through declared action and tool mappings | Non-interactive fallback only | Attempt `k` activated the authored action through disclosed CDP DOM-click automation and recorded receipt `standards-host-action-19`; this is not evidence of a human pointer click or a Codex-host click |
| Declared editable-module action | Portable dispatcher implemented | Adapter action tool mapping present | Requires module executor plus action mapping | Non-interactive module invocation only | Candidate `e` module action persisted an artifact and replayed one stable idempotency key without a second effect; visible edit-and-click run pending |
| Inline mode | Portable default | Host mapping present | Observed in the named local standards host | Text only | Attempt `k` captured inline browser pixels; the PNG is automated local evidence, not reviewed uncut publication media |
| Fullscreen mode | Negotiated contract | Adapter-dependent host support | Granted by the named local standards host | Unsupported | Attempt `k` captured a granted fullscreen outcome and pixels; independent human review remains pending |
| Picture-in-picture mode | Negotiated contract | Adapter-dependent host support | Truthfully unadvertised and returned typed `unsupported` while preserving fullscreen | Unsupported | Attempt `k` captures the limitation, not PiP support; another named host is required for a PiP-granted compatibility claim |
| Host context: theme, resize, and safe area | Portable host-context subscription | Adapter-dependent host support | Observed in the named local standards host | Adapter-dependent | Attempt `k` captured a dark-theme, resized, safe-area update through the portable subscription; uncut review remains pending |
| Hydration failure fallback | Four-second bounded renderer fallback | Reference bridge implements the shared renderer | Shared conformance resource contract | Complete text fallback | Attempt `k` visibly entered the complete fallback after 4,069 ms; the automated screenshot and trace passed integrity verification, but are not reviewed uncut media |
| Scoped local UI state | Durable portable store implemented | Adapter replay/recovery mapping present | Implemented through declared state/tool mapping | Text state may be returned separately | Attempt `k` persisted `Direction B`, revision 1, and recovered it through the declared tool after host restart; this remains automated local evidence |
| Historical render recovery | Versioned renderer and render store implemented | Reference recovery path passes the shared stress case | Named standards host reopens the immutable render | Uses fallback only | Attempt `k` restarted the host process and reopened render `10d2a8e2…` with the same state and zero post-restart compile/render invocations; Codex historical-message pixels and reviewed uncut media remain pending |
| Bounded delegation | Portable manager/provider implemented | Native adapter implementation present | Requires a host delegation adapter | Unsupported unless separately adapted | Deterministic manager tests plus one useful installed five-agent topology and one duplicated five-agent diagnostic wave; frozen 28-agent trace pending |
| Recursive delegation | Portable limits and typed limitation implemented | Only when the host advertises support | Adapter-dependent | Unsupported | Live support-or-limitation capture pending |
| Native effects/jobs | Portable ports and durable stores implemented | Adapter callbacks are host-dependent | Adapter-dependent | Adapter-dependent | Outside these publication examples |
| Native scheduling | Portable one-time/interval/cron schemas and seven operation capabilities implemented | Current adapter reports unsupported unless a native effect callback is supplied | Adapter-dependent | Adapter-dependent | Deterministic provider/permission/idempotency tests; live host schedule pending |

No cell marked adapter-dependent should be converted into a compatibility
claim until the named host, version, permission profile, and full receipt/trace
are recorded. A typed `unsupported`, `denied`, or `fallback` result is a valid
portable outcome, not evidence that the requested host feature worked.

Observed local smokes and exact deterministic measurements are listed in the
[evidence index](evidence/README.md). The
[publication-readiness audit](publication-readiness-audit.md) maps this matrix
to the remaining cross-host, live-mode, restart, evaluation, and package gates.
