import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { readTarEntries } from "../packed-manifest.mjs";
import {
  inventoryTree,
  isSameOrInside,
  pathExists,
  runCommand,
  writeJson,
} from "./lib.mjs";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const PACK_LIFECYCLE_SCRIPTS = [
  "prepack",
  "postpack",
  "prepare",
  "prepublish",
  "prepublishOnly",
];
const MAX_DEPLOYED_PACKAGES = 128;
const MAX_DEPLOYED_FILES = 50_000;
const MAX_DEPLOYED_BYTES = 2 * 1024 * 1024 * 1024;

export async function deployPackedWorkspaceClosure(run) {
  const workspacePackages = await readWorkspacePackageMap(run.platformSnapshot);
  const closure = collectWorkspaceClosure(workspacePackages, "@marshal/runtime");
  const budget = { packages: 0, files: 0, bytes: 0 };

  for (const item of closure) {
    const lifecycleScripts = PACK_LIFECYCLE_SCRIPTS.filter((name) =>
      typeof item.manifest.scripts?.[name] === "string");
    if (lifecycleScripts.length > 0) {
      throw new Error(`${item.name} has pack lifecycle scripts: ${lifecycleScripts.join(", ")}`);
    }
  }
  const command = await runCommand(run, {
    id: "pack-local-runtime-workspace-closure",
    category: "node-integration-setup",
    program: "pnpm",
    args: [
      ...closure.flatMap((item) => ["--filter", item.name]),
      "pack",
      "--pack-destination",
      run.archiveRoot,
    ],
    cwd: run.platformSnapshot,
    env: {
      NPM_CONFIG_OFFLINE: "true",
      PNPM_CONFIG_OFFLINE: "true",
    },
    failureClassification: "production",
  });
  if (command.exitCode !== 0) {
    const evidence = {
      strategy: "locally-packed-workspace-closure",
      ready: false,
      networkAllowed: false,
      failedCommandId: command.id,
    };
    await writeJson(path.join(run.runRoot, "consumer-deployment.json"), evidence);
    return { ready: false, runtimeArchive: null, evidence };
  }

  const archives = await inspectArchives(run.archiveRoot);
  const expectedNames = new Set(closure.map((item) => item.name));
  const unexpectedArchives = archives.filter((item) => !expectedNames.has(item.name));
  if (unexpectedArchives.length > 0) {
    throw new Error(`Unexpected package archives: ${unexpectedArchives.map((item) => item.name).join(", ")}`);
  }
  for (const item of closure) {
    if (!archives.some((archive) => archive.name === item.name && archive.version === item.version)) {
      throw new Error(`Missing local archive for ${item.name}@${item.version}`);
    }
  }

  const deployedWorkspacePackages = [];
  for (const archive of archives) {
    const targetRoot = packageTarget(run.consumerRoot, archive.name);
    await extractPackageArchive(archive, targetRoot, budget);
    deployedWorkspacePackages.push({
      name: archive.name,
      version: archive.version,
      sourceArchive: archive.path,
      sourceArchiveSize: archive.size,
      sourceArchiveSha256: archive.sha256,
      targetRoot,
      deployed: await packageDigest(targetRoot),
    });
  }

  const externalPackages = [];
  const deployedTargets = new Map();
  for (const item of closure) {
    await deployExternalDependencies({
      run,
      workspacePackages,
      sourceRoot: item.root,
      targetRoot: packageTarget(run.consumerRoot, item.name),
      manifest: item.manifest,
      ancestry: new Set([await realpath(item.root)]),
      deployedTargets,
      externalPackages,
      budget,
    });
  }

  const runtimeArchive = archives.find((item) => item.name === "@marshal/runtime")?.path ?? null;
  if (!runtimeArchive) throw new Error("The local @marshal/runtime archive was not produced.");
  const consumerManifestPath = path.join(run.consumerRoot, "package.json");
  const consumerManifest = JSON.parse(await readFile(consumerManifestPath, "utf8"));
  const runtimeArchiveReference = path.relative(run.consumerRoot, runtimeArchive).replaceAll("\\", "/");
  consumerManifest.dependencies = {
    "@marshal/runtime": `file:${runtimeArchiveReference}`,
  };
  await writeJson(consumerManifestPath, consumerManifest);

  const runtimeEntrypoint = path.join(packageTarget(run.consumerRoot, "@marshal/runtime"), "dist", "index.js");
  const ready = await pathExists(runtimeEntrypoint);
  const evidence = {
    strategy: "locally-packed-workspace-closure",
    ready,
    networkAllowed: false,
    packageManagerInstallUsed: false,
    authoritativeSourceCopied: false,
    workspacePackageCount: closure.length,
    externalPackageCopyCount: externalPackages.filter((item) => item.targetRoot).length,
    limits: {
      maxPackages: MAX_DEPLOYED_PACKAGES,
      maxFiles: MAX_DEPLOYED_FILES,
      maxBytes: MAX_DEPLOYED_BYTES,
    },
    observed: budget,
    runtimeArchive,
    workspaceArchives: archives.map((item) => ({
      name: item.name,
      version: item.version,
      path: item.path,
      size: item.size,
      sha256: item.sha256,
    })),
    deployedWorkspacePackages: deployedWorkspacePackages.sort((left, right) =>
      left.name.localeCompare(right.name)),
    externalPackages: externalPackages.sort((left, right) =>
      `${left.targetRoot}\0${left.name}`.localeCompare(`${right.targetRoot}\0${right.name}`)),
  };
  await writeJson(path.join(run.runRoot, "consumer-deployment.json"), evidence);
  return { ready, runtimeArchive, evidence };
}

async function readWorkspacePackageMap(snapshotRoot) {
  const packagesRoot = path.join(snapshotRoot, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const root = path.join(packagesRoot, entry.name);
    const manifestPath = path.join(root, "package.json");
    if (!(await pathExists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    packages.set(manifest.name, {
      name: manifest.name,
      version: manifest.version,
      root,
      manifest,
    });
  }
  return packages;
}

function collectWorkspaceClosure(workspacePackages, rootName) {
  const closure = [];
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    const item = workspacePackages.get(name);
    if (!item) throw new Error(`Workspace package ${name} is unavailable.`);
    visited.add(name);
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(item.manifest[section] ?? {}).sort()) {
        if (workspacePackages.has(dependency)) visit(dependency);
      }
    }
    closure.push(item);
  }
  visit(rootName);
  return closure;
}

async function inspectArchives(archiveRoot) {
  const entries = (await readdir(archiveRoot))
    .filter((item) => item.endsWith(".tgz"))
    .sort();
  const archives = [];
  for (const entry of entries) {
    const archivePath = path.join(archiveRoot, entry);
    const bytes = await readFile(archivePath);
    const tarEntries = readTarEntries(bytes);
    const manifestBytes = tarEntries.get("package/package.json");
    if (!manifestBytes) throw new Error(`${archivePath} has no package/package.json.`);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    archives.push({
      path: archivePath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      name: manifest.name,
      version: manifest.version,
      entries: tarEntries,
    });
  }
  return archives;
}

async function extractPackageArchive(archive, targetRoot, budget) {
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  for (const [entryPath, content] of [...archive.entries].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (!entryPath.startsWith("package/")) continue;
    const relative = entryPath.slice("package/".length);
    if (!relative || relative.endsWith("/")) continue;
    const segments = relative.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Unsafe archive entry ${entryPath} in ${archive.path}`);
    }
    const destination = path.join(targetRoot, ...segments);
    if (!isSameOrInside(targetRoot, destination)) {
      throw new Error(`Archive entry escaped deployment root: ${entryPath}`);
    }
    consumeBudget(budget, content.length);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

async function deployExternalDependencies(context) {
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = Object.entries(context.manifest[section] ?? {})
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [name, requested] of dependencies) {
      if (context.workspacePackages.has(name)) continue;
      const optional = section === "optionalDependencies"
        || (section === "peerDependencies"
          && context.manifest.peerDependenciesMeta?.[name]?.optional === true);
      const sourceRoot = await resolveInstalledDependency(
        context.run.platformSnapshot,
        context.sourceRoot,
        name,
      );
      if (!sourceRoot) {
        if (optional) {
          context.externalPackages.push({
            name,
            requested,
            requestedBy: context.manifest.name,
            section,
            optional: true,
            skipped: "not installed for this platform",
          });
          continue;
        }
        throw new Error(`Unable to resolve required dependency ${name} from ${context.sourceRoot}`);
      }
      if (context.ancestry.has(sourceRoot)) {
        context.externalPackages.push({
          name,
          requested,
          requestedBy: context.manifest.name,
          section,
          providedByAncestor: sourceRoot,
        });
        continue;
      }
      const targetRoot = path.join(context.targetRoot, "node_modules", ...name.split("/"));
      const priorSource = context.deployedTargets.get(path.resolve(targetRoot));
      if (priorSource) {
        if (priorSource !== sourceRoot) {
          throw new Error(`Conflicting dependency sources for ${targetRoot}`);
        }
        continue;
      }
      context.deployedTargets.set(path.resolve(targetRoot), sourceRoot);
      consumePackageBudget(context.budget);
      await copyPackageContents(
        context.run.platformSnapshot,
        sourceRoot,
        targetRoot,
        context.budget,
      );
      const manifest = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
      context.externalPackages.push({
        name: manifest.name,
        version: manifest.version,
        requested,
        requestedBy: context.manifest.name,
        section,
        sourceRoot,
        targetRoot,
        deployed: await packageDigest(targetRoot),
      });
      await deployExternalDependencies({
        ...context,
        sourceRoot,
        targetRoot,
        manifest,
        ancestry: new Set([...context.ancestry, sourceRoot]),
      });
    }
  }
}

async function resolveInstalledDependency(snapshotRoot, sourceRoot, name) {
  let current = path.resolve(sourceRoot);
  while (isSameOrInside(snapshotRoot, current)) {
    const candidate = path.join(current, "node_modules", ...name.split("/"));
    try {
      const resolved = await realpath(candidate);
      if (!isSameOrInside(snapshotRoot, resolved)) {
        throw new Error(`Dependency ${name} resolved outside the snapshot: ${resolved}`);
      }
      return resolved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === path.resolve(snapshotRoot)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function copyPackageContents(snapshotRoot, sourceRoot, targetRoot, budget) {
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  async function copyDirectory(sourceDirectory, targetDirectory) {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const source = path.join(sourceDirectory, entry.name);
      const target = path.join(targetDirectory, entry.name);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) {
        const resolved = await realpath(source);
        if (!isSameOrInside(snapshotRoot, resolved)) {
          throw new Error(`Package symlink escaped the snapshot: ${source} -> ${resolved}`);
        }
        const resolvedMetadata = await lstat(resolved);
        if (resolvedMetadata.isDirectory()) {
          await mkdir(target, { recursive: true });
          await copyDirectory(resolved, target);
        } else if (resolvedMetadata.isFile()) {
          consumeBudget(budget, resolvedMetadata.size);
          await copyFile(resolved, target);
          await chmod(target, resolvedMetadata.mode);
        } else {
          throw new Error(`Unsupported package symlink target: ${source}`);
        }
      } else if (metadata.isDirectory()) {
        await mkdir(target, { recursive: true });
        await copyDirectory(source, target);
      } else if (metadata.isFile()) {
        consumeBudget(budget, metadata.size);
        await copyFile(source, target);
        await chmod(target, metadata.mode);
      } else {
        throw new Error(`Unsupported package entry: ${source}`);
      }
    }
  }
  await copyDirectory(sourceRoot, targetRoot);
}

async function packageDigest(root) {
  const inventory = await inventoryTree(root, { exclude: ["node_modules"] });
  const files = inventory.entries
    .filter((item) => item.type === "file")
    .map((item) => ({ path: item.path, size: item.size, sha256: item.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, item) => total + item.size, 0),
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  };
}

function packageTarget(consumerRoot, name) {
  return path.join(consumerRoot, "node_modules", ...name.split("/"));
}

function consumePackageBudget(budget) {
  budget.packages += 1;
  if (budget.packages > MAX_DEPLOYED_PACKAGES) {
    throw new Error(`Deployment exceeded ${MAX_DEPLOYED_PACKAGES} external packages.`);
  }
}

function consumeBudget(budget, bytes) {
  budget.files += 1;
  budget.bytes += bytes;
  if (budget.files > MAX_DEPLOYED_FILES) {
    throw new Error(`Deployment exceeded ${MAX_DEPLOYED_FILES} files.`);
  }
  if (budget.bytes > MAX_DEPLOYED_BYTES) {
    throw new Error(`Deployment exceeded ${MAX_DEPLOYED_BYTES} bytes.`);
  }
}
