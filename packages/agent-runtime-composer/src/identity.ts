import type {
  RuntimeHarnessIdentity,
  RuntimePrincipal,
} from '@marshal/agent-runtime-core';
import {
  createRuntimeServiceToken,
  type RuntimeServiceToken,
} from './services.js';
import type { TrustedRuntimeAuthority } from './contracts.js';

export interface RuntimePrincipalProvider {
  resolvePrincipal(): RuntimePrincipal;
}

export interface RuntimeIdentityProvider {
  resolveIdentity(): RuntimeHarnessIdentity | undefined;
}

export interface RuntimeAuthorityProvider {
  resolveAuthority(): TrustedRuntimeAuthority;
}

export const RUNTIME_PRINCIPAL_PROVIDER =
  createRuntimeServiceToken<RuntimePrincipalProvider>(
    '@marshal/runtime/identity:principal-provider',
  );
export const RUNTIME_IDENTITY_PROVIDER =
  createRuntimeServiceToken<RuntimeIdentityProvider>(
    '@marshal/runtime/identity:harness-provider',
  );
export const RUNTIME_AUTHORITY_PROVIDER =
  createRuntimeServiceToken<RuntimeAuthorityProvider>(
    '@marshal/runtime/identity:authority-provider',
  );

export function createStaticRuntimePrincipalProvider(
  principal: RuntimePrincipal,
): RuntimePrincipalProvider {
  return Object.freeze({ resolvePrincipal: () => principal });
}

export function createStaticRuntimeIdentityProvider(
  identity: RuntimeHarnessIdentity | undefined,
): RuntimeIdentityProvider {
  return Object.freeze({ resolveIdentity: () => identity });
}

export function createStaticRuntimeAuthorityProvider(
  authority: TrustedRuntimeAuthority,
): RuntimeAuthorityProvider {
  return Object.freeze({ resolveAuthority: () => authority });
}

export type RuntimePrincipalSource =
  | { readonly principal: RuntimePrincipal; readonly principalProvider?: never }
  | {
      readonly principal?: never;
      readonly principalProvider: RuntimePrincipalProvider;
    };

export type RuntimeIdentitySource =
  | { readonly identity: RuntimeHarnessIdentity; readonly identityProvider?: never }
  | {
      readonly identity?: never;
      readonly identityProvider: RuntimeIdentityProvider;
    };

export type RuntimeOptionalIdentitySource =
  | { readonly identity?: undefined; readonly identityProvider?: undefined }
  | { readonly identity: RuntimeHarnessIdentity; readonly identityProvider?: never }
  | {
      readonly identity?: never;
      readonly identityProvider: RuntimeIdentityProvider;
    };

export type RuntimeAuthoritySource =
  | { readonly authority: TrustedRuntimeAuthority; readonly authorityProvider?: never }
  | {
      readonly authority?: never;
      readonly authorityProvider: RuntimeAuthorityProvider;
    };

export type RuntimeIdentityServiceTokens = {
  readonly principal: RuntimeServiceToken<RuntimePrincipalProvider>;
  readonly identity: RuntimeServiceToken<RuntimeIdentityProvider>;
  readonly authority: RuntimeServiceToken<RuntimeAuthorityProvider>;
};
