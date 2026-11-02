import { randomUUID } from 'node:crypto';
import type {
  MaybePromise,
  PermissionApprovalDecision,
  PermissionBroker,
  PermissionCheck,
  RuntimeScope,
} from '@marshal/agent-runtime-core';

export interface RuntimePermissionGrant {
  /** Exact principal ID or `*`. */
  readonly principalId: string;
  /** Exact permission, or a trailing-wildcard pattern such as `memory.*`. */
  readonly permission: string;
  /** Optional exact/trailing-wildcard capability target constraint. */
  readonly capability?: string;
  /** Every supplied scope field must exactly match the invocation scope. */
  readonly scope?: Readonly<Partial<RuntimeScope>>;
}

export interface VerifiedRuntimeApproval {
  readonly approved: boolean;
  readonly permissions?: readonly string[];
  readonly reason?: string;
}

export interface DefaultDenyPermissionBrokerOptions {
  readonly grants?: readonly RuntimePermissionGrant[];
  readonly resolveGrants?: (check: PermissionCheck) => MaybePromise<readonly RuntimePermissionGrant[]>;
  readonly verifyApproval?: (
    approval: Readonly<Record<string, unknown>>,
    check: PermissionCheck,
  ) => MaybePromise<VerifiedRuntimeApproval>;
  readonly requestApproval?: (
    check: PermissionCheck,
    missingPermissions: readonly string[],
  ) => MaybePromise<Omit<PermissionApprovalDecision, 'decision'>>;
}

/**
 * Default-deny broker. Capabilities without descriptor requirements receive a
 * synthetic `capability:<target>` requirement, so an empty descriptor never
 * becomes an accidental allow-all escape hatch.
 */
export function createDefaultDenyPermissionBroker(
  options: DefaultDenyPermissionBrokerOptions = {},
): PermissionBroker {
  if (options.requestApproval && !options.verifyApproval) {
    throw new TypeError(
      'requestApproval requires verifyApproval so issued approvals can be completed safely.',
    );
  }
  return {
    async decide(check) {
      const required = check.requirements.length > 0
        ? [...new Set(check.requirements.map((requirement) => requirement.permission))]
        : [`capability:${check.capability.name}`];
      const grants = [
        ...(options.grants ?? []),
        ...(await options.resolveGrants?.(check) ?? []),
      ];
      const granted = required.filter((permission) =>
        grants.some((grant) => grantMatches(grant, permission, check)),
      );
      let missing = required.filter((permission) => !granted.includes(permission));

      if (missing.length > 0 && check.request.approval && options.verifyApproval) {
        const verified = await options.verifyApproval(check.request.approval, check);
        if (verified.approved) {
          const approvedPermissions = verified.permissions ?? [];
          const newlyApproved = missing.filter((permission) =>
            approvedPermissions.some((pattern) => wildcardMatches(pattern, permission)),
          );
          granted.push(...newlyApproved);
          missing = missing.filter((permission) => !newlyApproved.includes(permission));
        }
      }

      if (missing.length === 0) {
        return {
          decision: 'allow' as const,
          reason: 'All permissions were satisfied by explicit grants or a verified approval.',
          grants: [...new Set(granted)],
        };
      }

      if (options.requestApproval) {
        const approval = await options.requestApproval(check, missing);
        return {
          decision: 'approval' as const,
          reason: approval.reason,
          approvalId: approval.approvalId ?? randomUUID(),
          prompt: approval.prompt,
          expiresAt: approval.expiresAt,
        };
      }

      return {
        decision: 'deny' as const,
        code: 'explicit_grant_required',
        reason: `Missing explicit permission grant(s): ${missing.join(', ')}.`,
      };
    },
  };
}

function grantMatches(
  grant: RuntimePermissionGrant,
  permission: string,
  check: PermissionCheck,
): boolean {
  if (grant.principalId !== '*' && grant.principalId !== check.context.principal.id) return false;
  if (!wildcardMatches(grant.permission, permission)) return false;
  if (grant.capability && !wildcardMatches(grant.capability, check.capability.name)) return false;
  for (const [key, expected] of Object.entries(grant.scope ?? {})) {
    if (expected !== undefined && check.context.scope?.[key] !== expected) return false;
  }
  return true;
}

function wildcardMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}
