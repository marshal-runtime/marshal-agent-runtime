export interface WorkspaceSourceAliasOptions {
  readonly includeDevDependencies?: boolean;
  readonly packagesRoot?: string;
}

export interface WorkspaceSourceAliasPlanEntry {
  readonly packageName: string;
  readonly specifier: string;
  readonly replacement: string;
}

export interface WorkspaceSourceAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

export function workspaceSourceAliasPlan(
  rootPackageName: string,
  options?: WorkspaceSourceAliasOptions,
): readonly WorkspaceSourceAliasPlanEntry[];

export function workspaceSourceAliases(
  rootPackageName: string,
  options?: WorkspaceSourceAliasOptions,
): readonly WorkspaceSourceAlias[];
