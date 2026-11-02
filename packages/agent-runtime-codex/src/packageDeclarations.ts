import {
  RUNTIME_PACKAGE_DECLARATION,
  type RuntimePackageDeclaration,
} from '@marshal/runtime';

export const CODEX_PACKAGE_DECLARATION: RuntimePackageDeclaration = {
  packageId: '@marshal/codex',
  packageVersion: '0.1.0',
  capabilityPrefixes: ['codex.'],
};

export const CODEX_PACKAGE_DECLARATIONS: readonly RuntimePackageDeclaration[] = [
  RUNTIME_PACKAGE_DECLARATION,
  CODEX_PACKAGE_DECLARATION,
];
