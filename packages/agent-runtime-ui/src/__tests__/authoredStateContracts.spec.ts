import { describe, expect, it } from 'vitest';
import {
  RUNTIME_AUTHORED_UI_STATE_SERVICE,
  type RuntimeAuthoredUiStateService,
  type UiApplicationCreationRequest,
} from '../authored-state/contracts.js';
import { createRuntimeServiceToken } from '@marshal/agent-runtime-composer';

describe('authored UI state contracts', () => {
  it('uses the stable package-qualified service token', () => {
    expect(RUNTIME_AUTHORED_UI_STATE_SERVICE).toBe(
      createRuntimeServiceToken<RuntimeAuthoredUiStateService>(
        '@marshal/agent-runtime-ui:authored-state',
      ),
    );
  });

  it('keeps creation requests manifest- and JSON-based', () => {
    const request: UiApplicationCreationRequest = {
      application: {
        version: '1.0.0',
        presentationModes: ['inline'],
        actions: [],
        tools: [],
      },
      identity: { id: 'stable-application-id' },
      provenance: {
        kind: 'snapshot',
        sourceDigest: 'a'.repeat(64),
        componentId: 'b'.repeat(64),
        renderId: 'c'.repeat(64),
        componentDigest: 'd'.repeat(64),
        renderDigest: 'e'.repeat(64),
      },
    };
    expect(request.identity).toEqual({ id: 'stable-application-id' });
    expect(request.application.version).toBe('1.0.0');
  });
});
