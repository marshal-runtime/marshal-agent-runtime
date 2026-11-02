# Current-source standards-only MCP Apps host — candidate `j` preinstall

Date: 2026-08-03

Evidence class: `automated-local-live-standards-host`

Release status: **all automated host gates passed; `publicationClaimEligible: false`**

This attempt ran the named harness-neutral standards MCP Apps host against the
current built source of `@marshal/agent-runtime-ui@0.1.0`. It exercised the
same bounded public-render shape used by the Codex adapter: compiled HTML was
absent from the model-facing result, and the mounted renderer recovered it by
calling the app-only `marshal_get_react_payload` tool with the immutable render
ID.

The immutable evidence remains outside the repository at:

```text
C:\tmp\marshal-standards-host-candidate-j-preinstall-20260803T1052
```

`report.json` is 7,442 bytes with SHA-256
`C094ED299FA842AB455BFB1A8733F5C40E3A06BACBED76EED6FAEFAB6210CE1A`.

## Commands

From `C:\other\wbg\agent-runtime`:

```powershell
node examples/standards-mcp-apps-host/driver.mjs `
  --output C:\tmp\marshal-standards-host-candidate-j-preinstall-20260803T1052 `
  --deployment C:\other\wbg\agent-runtime\packages\agent-runtime-ui `
  --attempt-id candidate-j-preinstall-20260803T1052

node examples/standards-mcp-apps-host/verify-evidence.mjs `
  C:\tmp\marshal-standards-host-candidate-j-preinstall-20260803T1052
```

The driver exited `0` after 7,224 ms. The verifier exited `0` and reported:

```text
Standards-host evidence passed: candidate-j-preinstall-20260803T1052
Automated browser evidence remains publication-ineligible until uncut capture and independent review.
```

## Identity and payload boundary

| Item | Observed |
| --- | --- |
| Browser | Google Chrome through Chrome DevTools Protocol |
| Activation | disclosed deterministic DOM click |
| Protocol | MCP Apps `2026-01-26` |
| Render | `7c5e57e88a1a6a80a28f59fd6fd81a1a8e3d6319b33e96afa3d7659cdec5052e` |
| Component | `e56d885f8a2af919b25f3f88c79d542783d2ecd48ddb2aae01c252ecf5585ac4` |
| Source digest | `0c9f48edd5b997a2ed3f63c8ca84bebfbd5ddf49a0012dcc0d4c6b5e0ac000c2` |

A read-only reopen of the retained render measured the serialized result
boundary directly:

| Payload | Bytes | Observation |
| --- | ---: | --- |
| Portable raw public result | 1,164,998 | Included private `_meta.marshal.componentHtml` before host projection |
| Standards-host public result | 2,453 | Preserved content, fallback, render identity, props, and application; no compiled bytes |
| App-only hydration result | 1,165,033 | Returned only through `marshal_get_react_payload` |
| Compiled HTML | 1,128,917 | Exact match between the private raw result and app-only payload |

The public-result reduction was 99.79%. The live host trace records successful
`marshal_get_react_payload` requests before the first inline pixels, after a
remount, and after the host-process restart. This is direct evidence that the
small public result hydrates in this standards host; it is not a claim about
Codex desktop pixels.

## Timings and outcomes

All relative timings below are reconstructed from the retained driver and host
event timestamps. Screenshot outcomes were also inspected after the run.

| Gate | Outcome | Timing |
| --- | --- | ---: |
| Initial host to `inline-mounted` | observed | 766 ms |
| App initialization to payload request | success | 38 ms |
| App initialization to browser payload result | success | 86 ms |
| Driver start to first inline screenshot | observed pixels | 1,560 ms |
| Capability-action click to permission event | allowed | 21 ms |
| Capability-action click to browser result | saved `Direction B`, revision 1 | 55 ms |
| Capability-action click to screenshot | observed; receipt `standards-host-action-20` | 157 ms |
| Fullscreen click to host grant | granted | 4 ms |
| Fullscreen click to screenshot | observed pixels | 71 ms |
| PiP click to screenshot | unsupported, fullscreen remained usable | 73 ms |
| Remount click to app initialization | observed | 9 ms |
| Remount click to payload request/result | success | 37 / 93 ms |
| Remount click to screenshot | same render and restored authoritative state | 292 ms |
| Deliberately incomplete hydration | complete visible text fallback | 4,038 ms renderer timing; 4,148 ms click-to-screenshot |
| Host stop to replacement process ready | restarted | 233 ms |
| Replacement process ready to inline mount | observed | 43 ms |
| Replacement process ready to payload result | success | 153 ms |
| Replacement process ready to screenshot | same render and `Direction B` | 457 ms |

Before restart, the host recorded one compile, one render, one action, and two
declared-tool invocations. After restart it recorded zero compiles, zero
renders, zero actions, and one declared-tool invocation used to restore the
authoritative state. The persisted state was `Direction B`, revision 1.

## Retained file identities

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `application.json` | 2,374 | `90bc6cd274d2a9a200696d65110f7d6b035d8a68b195fa9a17e6f78598cf1bc9` |
| `driver-trace.jsonl` | 4,669 | `f0a78082ddb43671b5d65543057b1298c608074e252cb220dd594b5dc3e14453` |
| `fallback.json` | 506 | `2c6ce366356351664380c3bbc568af5b9a483e199159742c1eed27f14443922b` |
| `host-trace.jsonl` | 12,156 | `20feb08320a6d15b082081d4b0698f977f3e57a91710a93d2a7d401469618cd6` |
| `receipts.jsonl` | 5,385 | `b38b4d04442f5470fd03c384439700d5b7df1e65620145fd5fd28b49eccfc08a` |
| `screenshots/01-inline.png` | 55,755 | `80c18339c6053ff372790eaa7b3f38ab79cd1775af8209e4aada66a093466c11` |
| `screenshots/02-action.png` | 56,746 | `6c5e9a06a390136f8a1e76f3045c9679a3a9ee8cf6f508f13302904c0e2655e2` |
| `screenshots/03-theme-resize-safe-area.png` | 59,315 | `4eb92b5a7f2ba62518c2a0700dbba7cfc5f90765e4e4dec6c025cc877a8d9d84` |
| `screenshots/04-fullscreen.png` | 33,838 | `4a28498b522f3651f68cbbb4b6b401679133daf7e2278ecf51e7a2c255e54891` |
| `screenshots/05-pip-unsupported.png` | 32,770 | `e03eb5894523dacb4a1b03942310bc5038cb70c2391b764ea1dab9b5f77510c9` |
| `screenshots/06-remount.png` | 29,839 | `b5396028a4f10a149db10624fe57ff172bed7b130974c55ba66445a65d41fda8` |
| `screenshots/07-hydration-fallback.png` | 33,015 | `d14829b1597a33fc75fe4fafb588ae6258ee233f07ed440ba8bc7d68620ee676` |
| `screenshots/08-host-restart.png` | 55,653 | `6bcc8b8c1467e56a30d6e38dbaf7cd563fe7aba3f00091de7c110deed3b1b9ff` |
| `source-manifest.json` | 503 | `2552e6010f3b79cbe0ba3d1ecbcd63d066a318e61dc985127b2f9992fe19a303` |

## Strict caveat

The report explicitly records `publicationClaimEligible: false`. These are
live browser pixels and real local host actions, but the activations were CDP
DOM dispatch rather than human pointer input. There is no continuous uncut
recording or independent human review. PiP was truthfully unsupported by this
host, and the run used local HTTP plus a source-tree package root rather than a
published registry artifact. It may support standards-host compatibility and
payload-hydration claims only; it does not establish Codex desktop behavior or
a publishable visual demonstration.
