import process from "node:process";

export function configuredPackageManager(rootManifest) {
  const expected = rootManifest.packageManager;
  const separator = expected.lastIndexOf("@");
  const expectedName = expected.slice(0, separator);
  const expectedVersion = expected.slice(separator + 1);
  const current = process.env.npm_config_user_agent?.split(" ")[0];
  const [currentName, currentVersion] = current?.split("/") ?? [];
  const cli = process.env.npm_execpath;

  if (!cli || currentName !== expectedName || currentVersion !== expectedVersion) {
    throw new Error(
      `This command requires ${expected}; run it through Corepack or the repository's configured pnpm. ` +
        `(current: ${current ?? "unknown"})`,
    );
  }

  return { cli, expected };
}
