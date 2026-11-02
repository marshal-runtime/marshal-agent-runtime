import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { configuredPackageManager } from "./package-manager.mjs";
import { declaredEntrypoints, readTarEntries, validatePackedManifest } from "./packed-manifest.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
let packageManager;
try {
  packageManager = configuredPackageManager(rootManifest);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const packageDirectories = [];
for (const entry of (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((candidate) => candidate.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))) {
  try {
    await access(path.join(packagesRoot, entry.name, "package.json"));
    packageDirectories.push(entry.name);
  } catch {
    // Package-manager staging directories and other non-package folders are not tarball inputs.
  }
}

const errors = [];
const workspaceVersions = new Map();
for (const directory of packageDirectories) {
  const manifest = JSON.parse(await readFile(path.join(packagesRoot, directory, "package.json"), "utf8"));
  workspaceVersions.set(manifest.name, manifest.version);
}

const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "marshal-pack-check-"));

try {
  for (const directory of packageDirectories) {
    const packageRoot = path.join(packagesRoot, directory);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const result = spawnSync(
      process.execPath,
      [packageManager.cli, "pack", "--json", "--pack-destination", archiveRoot],
      { cwd: packageRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );

    if (result.status !== 0) {
      errors.push(`${manifest.name}: pack failed: ${(result.stderr || result.stdout).trim()}`);
      continue;
    }

    let pack;
    try {
      pack = JSON.parse(result.stdout);
    } catch {
      errors.push(`${manifest.name}: pack did not return valid JSON`);
      continue;
    }

    if (pack.name !== manifest.name || pack.version !== manifest.version) {
      errors.push(`${manifest.name}: packed name or version differs from package.json`);
    }

    const packedFiles = new Set((pack.files ?? []).map((file) => file.path.replaceAll("\\", "/")));
    const requiredFiles = ["package.json", "README.md", ...declaredEntrypoints(manifest)]
      .filter(Boolean)
      .map((file) => file.replace(/^\.\//, ""));

    for (const requiredFile of requiredFiles) {
      if (!packedFiles.has(requiredFile)) {
        errors.push(`${manifest.name}: tarball is missing ${requiredFile}`);
      }
    }

    if (![...packedFiles].some((file) => /(^|\/)LICENSE(?:\.[^/]+)?$/i.test(file))) {
      errors.push(`${manifest.name}: tarball is missing a license file`);
    }

    for (const packedFile of packedFiles) {
      if (
        packedFile === "node_modules" ||
        packedFile.startsWith("node_modules/") ||
        packedFile === ".git" ||
        packedFile.startsWith(".git/")
      ) {
        errors.push(`${manifest.name}: tarball contains forbidden path ${packedFile}`);
      }

      if (
        /(^|\/)__tests__(\/|$)/i.test(packedFile) ||
        /(^|\/)test-fixtures(\/|$)/i.test(packedFile) ||
        /\.(spec|test)\.[^/]+$/i.test(packedFile)
      ) {
        errors.push(`${manifest.name}: tarball contains test-only path ${packedFile}`);
      }
    }

    try {
      const archivePath = path.resolve(packageRoot, pack.filename);
      const entries = readTarEntries(await readFile(archivePath));
      const packedManifestBytes = entries.get("package/package.json");
      if (!packedManifestBytes) {
        errors.push(`${manifest.name}: archive is missing package/package.json`);
        continue;
      }
      const packedManifest = JSON.parse(packedManifestBytes.toString("utf8"));
      for (const failure of validatePackedManifest({
        sourceManifest: manifest,
        packedManifest,
        workspaceVersions,
      })) errors.push(`${manifest.name}: ${failure}`);
    } catch (error) {
      errors.push(`${manifest.name}: could not inspect packed manifest: ${error.message}`);
    }
  }
} finally {
  await rm(archiveRoot, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated packed archives and rewritten manifests for ${packageDirectories.length} packages.`);
