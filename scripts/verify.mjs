import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = [
  [path.join(repositoryRoot, "scripts", "check-repository.mjs")],
  [path.join(repositoryRoot, "scripts", "check-boundaries.mjs")],
  [path.join(repositoryRoot, "scripts", "check-manifests.mjs")],
  [path.join(repositoryRoot, "scripts", "validate-docs.mjs")],
  [path.join(repositoryRoot, "scripts", "validate-evals.mjs")],
  ["--test", path.join(repositoryRoot, "scripts", "evals", "__tests__", "*.test.mjs")],
  [path.join(repositoryRoot, "scripts", "run-workspace-script.mjs"), "build"],
  [path.join(repositoryRoot, "scripts", "run-workspace-script.mjs"), "typecheck"],
  [path.join(repositoryRoot, "scripts", "run-workspace-script.mjs"), "test"],
  [path.join(repositoryRoot, "scripts", "run-publication-tests.mjs")],
  [path.join(repositoryRoot, "scripts", "check-packs.mjs")],
];

for (const arguments_ of scripts) {
  const result = spawnSync(
    process.execPath,
    arguments_,
    { cwd: repositoryRoot, stdio: "inherit" },
  );

  if (result.error) {
    console.error(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
