/** Versioned, machine-readable contract projected into UI capability discovery. */
export const MARSHAL_UI_AUTHORING_CONTRACT_VERSION = '1.0.0' as const;

export const MARSHAL_UI_AUTHORING_CONTRACT = Object.freeze({
  version: MARSHAL_UI_AUTHORING_CONTRACT_VERSION,
  injectedProp: 'marshal',
  typeImport:
    "import type { MarshalUiClient, MarshalUiComponentProps } from '@marshal/agent-runtime-ui';",
  componentContract:
    'The default React export receives a marshal: MarshalUiClient prop when ui.render includes an application manifest.',
  methods: Object.freeze({
    callAction:
      "marshal.callAction(actionId, input, { scope, idempotencyKey?, approval?, signal? })",
    callTool: 'marshal.callTool(declaredToolId, input)',
    bindActionControl:
      'marshal.bindActionControl(actionId, ({ signal, requestId, actionId }) => handler({ signal, requestId, actionId }))',
    requestDisplayMode:
      "marshal.requestDisplayMode('inline' | 'fullscreen' | 'pip')",
    subscribe: 'marshal.subscribe(listener)',
  }),
  displayModeResultStatuses: Object.freeze([
    'granted',
    'unsupported',
    'denied',
    'fallback',
    'timed_out',
  ]),
  guidance:
    'Use only manifest-declared action and tool IDs. The renderer supplies visible named controls for every declared non-inline mode outside authored CSS; authored controls may add context but cannot replace that portable chrome. Check host.context.availableDisplayModes, handle and announce the typed result, subscribe to host-context changes, and keep the complete workflow usable inline. Persistent applications bind distinct runtime-backed Save and Reopen/Load handlers with marshal.bindActionControl so manifest-derived chrome can invoke the current state exactly once; pass the supplied AbortSignal into long-running action work so Cancel and the bounded timeout stop it promptly.',
});
