import { describe, expect, it, vi } from 'vitest';
import type { PermissionCheck } from '@marshal/agent-runtime-core';
import { createDefaultDenyPermissionBroker } from '../src/permissions.js';

function check(permission?: string, approval?: Readonly<Record<string, unknown>>): PermissionCheck {
  return {
    capability: {
      protocolVersion: '1.0.0',
      name: 'memory.store',
      version: '1.0.0',
      description: 'test',
      provider: { id: 'test' },
    },
    requirements: permission ? [{ permission }] : [],
    request: { protocolVersion: '1.0.0', target: 'memory.store', approval },
    context: {
      principal: { id: 'agent-1', kind: 'agent' },
      scope: { workspaceId: 'workspace-1' },
    },
  };
}

describe('default-deny permission broker', () => {
  it('denies missing grants, including a synthetic capability requirement', async () => {
    const broker = createDefaultDenyPermissionBroker();
    await expect(broker.decide(check('memory.write'))).resolves.toMatchObject({ decision: 'deny', code: 'explicit_grant_required' });
    await expect(broker.decide(check())).resolves.toMatchObject({ decision: 'deny', reason: expect.stringContaining('capability:memory.store') });
  });

  it('requires principal, capability, and scope constraints to match', async () => {
    const broker = createDefaultDenyPermissionBroker({
      grants: [{
        principalId: 'agent-1',
        permission: 'memory.*',
        capability: 'memory.store',
        scope: { workspaceId: 'workspace-1' },
      }],
    });
    await expect(broker.decide(check('memory.write'))).resolves.toMatchObject({ decision: 'allow', grants: ['memory.write'] });
    const other = check('memory.write');
    const wrongScope: PermissionCheck = { ...other, context: { ...other.context, scope: { workspaceId: 'workspace-2' } } };
    await expect(broker.decide(wrongScope)).resolves.toMatchObject({ decision: 'deny' });
  });

  it('never trusts an approval object without verification and supports an approval handshake', async () => {
    const unsafe = createDefaultDenyPermissionBroker();
    await expect(unsafe.decide(check('memory.write', { approved: true }))).resolves.toMatchObject({ decision: 'deny' });

    const requestApproval = vi.fn(async () => ({ reason: 'User approval required.', prompt: 'Allow memory write?' }));
    expect(() => createDefaultDenyPermissionBroker({ requestApproval })).toThrow(
      /requires verifyApproval/,
    );

    const verifyApproval = vi.fn(async (approval: Readonly<Record<string, unknown>>) => ({
      approved: approval.token === 'signed',
      permissions: approval.token === 'signed' ? ['memory.write'] : [],
    }));
    const broker = createDefaultDenyPermissionBroker({ requestApproval, verifyApproval });
    await expect(broker.decide(check('memory.write'))).resolves.toMatchObject({ decision: 'approval', prompt: 'Allow memory write?' });
    await expect(broker.decide(check('memory.write', { token: 'signed' }))).resolves.toMatchObject({ decision: 'allow' });
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(verifyApproval).toHaveBeenCalledOnce();
  });
});
