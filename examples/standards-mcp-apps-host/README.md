# Marshal Standards MCP Apps Host

This is a named, harness-neutral MCP Apps host and evidence driver. It consumes
the public `@marshal/agent-runtime-ui` package from an installed package root;
it does not use the conformance fixture or any Codex API.

The checked-in React source uses only the injected Marshal client. It declares
separate Save and Reopen capability actions plus one app-visible tool, feature-detects presentation
modes, handles typed mode outcomes, subscribes to host context, and keeps a
complete text fallback.

The local host's mutation endpoints are not ambient localhost authority. Each
host process creates a 256-bit capability token that is delivered only in the
served page, and `/tool` plus `/event` require that token, the host's exact
`Origin`, same-origin fetch metadata when present, and the exact
`application/json` media type. Rejected requests do not mutate host traces,
receipts, counters, or application state. This protects the demonstration from
cross-origin requests to loopback; it is not remote authentication or a
multi-user authorization design.

## Run the automated local-live lane

Build or install a detached runtime candidate, then provide the installed UI
package root and a new absolute output directory:

```powershell
node examples/standards-mcp-apps-host/driver.mjs `
  --output C:\tmp\marshal-standards-host-run `
  --deployment C:\path\to\node_modules\@marshal\agent-runtime-ui `
  --attempt-id standards-host-local-001

node examples/standards-mcp-apps-host/verify-evidence.mjs `
  C:\tmp\marshal-standards-host-run
```

The Node 24 driver starts the host, opens a local Edge/Chrome instance through
the Chrome DevTools Protocol, performs disclosed DOM-click automation, captures
live PNG pixels, and restarts the host process. It retains:

- initial inline pixels;
- manifest-derived outer Save and Reopen clicks, distinct dispatcher receipts,
  and restoration of authoritative state over a local draft;
- theme, dimensions, and safe-area propagation;
- fullscreen grant and honest PiP unsupported result;
- remount without a new compile/render binding;
- useful hydration fallback in under five seconds;
- same-render/state recovery after a new host process;
- host and browser traces, receipts, manifests, hashes, and limitations.

The report deliberately says `publicationClaimEligible: false`. Automated
screenshots and DOM activation are not an uncut operator recording or an
independent accessibility/visual review. The public release capture must retain
those separate human gates.

## Retained hardened attempt

The final local security attempt is
`standards-host-security-20260803-k`, retained outside the repository at
`C:\tmp\marshal-standards-host-security-run-20260803k`. Its `report.json`
SHA-256 is
`61fc5ab3c85629fcc8b8b1e9a2a6a4d477dea81f4cd8382c317f2388df44e918`.
The evidence verifier passed all 10 gates, including
`local-request-boundary`, and the focused adversarial suite passed 3/3. The
report intentionally retains `publicationClaimEligible: false` because the
automated screenshots are not uncut independently reviewed media.

## Run the host manually

```powershell
node examples/standards-mcp-apps-host/host.mjs `
  --state-root C:\tmp\marshal-standards-host-state `
  --deployment C:\path\to\node_modules\@marshal\agent-runtime-ui
```

Open the printed `STANDARDS_HOST_READY` URL. Reusing the same state root reopens
the immutable render; changing its source fails closed and requires a new root.
