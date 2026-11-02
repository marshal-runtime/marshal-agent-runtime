import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { configuredPackageManager } from "./package-manager.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const workspaceScript = process.argv[2];

if (!new Set(["build", "typecheck", "test"]).has(workspaceScript)) {
  console.error("Expected one of: build, typecheck, test");
  process.exit(1);
}

let packageManager;
try {
  packageManager = configuredPackageManager(rootManifest);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    packageManager.cli,
    "--recursive",
    "--workspace-concurrency=1",
    "--filter",
    "./packages/**",
    workspaceScript,
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
}
process.exit(result.status ?? 1);
