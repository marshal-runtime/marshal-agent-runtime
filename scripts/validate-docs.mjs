#!/usr/bin/env node
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = path.join(repositoryRoot, 'packages');
const boundaries = JSON.parse(await readFile(path.join(repositoryRoot, 'runtime-boundaries.json'), 'utf8'));
const classification = new Map([
  ...boundaries.portable.map((directory) => [directory, 'portable']),
  ...boundaries.adapters.map((directory) => [directory, 'adapter']),
]);
const failures = [];

const requiredGuides = [
  'docs/generic-mcp-quickstart.md',
  'docs/codex-adapter-guide.md',
  'docs/adapter-authoring.md',
  'docs/package-reference.md',
];

const requiredPublicationDocs = [
  'docs/compatibility-matrix.md',
  'docs/demo-capture-storyboard.md',
  'docs/evidence/README.md',
  'docs/limitations-and-threat-model.md',
  'docs/marshal-1.0-goal.md',
  'docs/publication-checklist.md',
  'docs/publication-readiness-audit.md',
  'docs/ui-application-contract.md',
];

for (const relativePath of [...requiredGuides, ...requiredPublicationDocs]) {
  if (!(await exists(path.join(repositoryRoot, relativePath)))) {
    failures.push(`required publication guide is missing: ${relativePath}`);
  }
}

const packages = [];
for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(packagesRoot, entry.name, 'package.json');
  if (!(await exists(manifestPath))) continue;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const readmePath = path.join(packagesRoot, entry.name, 'README.md');
  if (!(await exists(readmePath))) {
    failures.push(`${manifest.name}: README.md is missing`);
    continue;
  }
  const readme = await readFile(readmePath, 'utf8');
  const firstLine = readme.split(/\r?\n/, 1)[0];
  if (firstLine !== `# ${manifest.name}` && firstLine !== `# \`${manifest.name}\``) {
    failures.push(`${manifest.name}: README heading must start with the exact package name`);
  }
  packages.push({
    directory: entry.name,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    classification: classification.get(entry.name),
  });
}

packages.sort((left, right) => left.name.localeCompare(right.name));
const packageReferencePath = path.join(repositoryRoot, 'docs/package-reference.md');
if (await exists(packageReferencePath)) {
  const actual = await readFile(packageReferencePath, 'utf8');
  const expectedRegion = renderPackageTable(packages);
  const actualRegion = betweenMarkers(actual, '<!-- package-table:start -->', '<!-- package-table:end -->');
  if (actualRegion !== expectedRegion) {
    failures.push('docs/package-reference.md package table is stale; update it with current manifest versions and descriptions');
  }
}

const codexPackage = packages.find((item) => item.name === '@marshal/agent-runtime-codex');
const conformancePackage = packages.find((item) => item.name === '@marshal/agent-runtime-conformance');

await requireText('docs/generic-mcp-quickstart.md', [
  `${codexPackage?.name}@${codexPackage?.version}`,
  'runtime_search',
  'runtime_exec',
  'pnpm smoke:detached-mcp',
]);
await requireText('docs/codex-adapter-guide.md', [
  'agent-runtime-codex-install-plugin',
  'MARSHAL_RUNTIME_LIFECYCLE_TOOLS',
  'pnpm smoke:installed-codex',
  'new task',
]);
await requireText('docs/adapter-authoring.md', [
  `${conformancePackage?.name}@${conformancePackage?.version}`,
  'assertAdapterConformance',
  'createAdaptiveApplicationConformanceFixture',
  'assertAdaptiveApplicationConformance',
  'standards-only',
]);
await requireText('docs/demo-capture-storyboard.md', [
  'prepare-evidence.mjs',
  '--level capture',
  '--level publication',
  'preview.gif',
  'short.mp4',
  'screen.webm',
]);
await requireText('docs/evidence/README.md', [
  'local-live-smoke',
  'paired-evaluation',
  '03F374BAF14B5922FD9EF40675AE86C0C0D77AA57F0A6A92C711FB0CF8F96412',
]);

for (const relativePath of [
  'README.md',
  ...requiredGuides,
  ...requiredPublicationDocs,
  'docs/evidence/automatic-memory-2026-08-01.md',
  'docs/evidence/design-studio-prototype-2026-08-01.md',
  'docs/evidence/fresh-session-routing-2026-08-01.md',
  'examples/publication/README.md',
  ...packages.map((item) => `packages/${item.directory}/README.md`),
]) {
  if (await exists(path.join(repositoryRoot, relativePath))) {
    await validateRelativeLinks(relativePath);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated publication guides and versioned documentation for ${packages.length} packages.\n`);
}

async function requireText(relativePath, requiredFragments) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!(await exists(absolutePath))) return;
  const content = await readFile(absolutePath, 'utf8');
  for (const fragment of requiredFragments) {
    if (!content.includes(fragment)) failures.push(`${relativePath}: missing required contract text ${JSON.stringify(fragment)}`);
  }
}

async function validateRelativeLinks(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const content = await readFile(absolutePath, 'utf8');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (!rawTarget || /^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
    const withoutAnchor = decodeURIComponent(rawTarget.split('#')[0]);
    const target = path.resolve(path.dirname(absolutePath), withoutAnchor);
    if (!(await exists(target))) failures.push(`${relativePath}: broken relative link ${rawTarget}`);
  }
}

function renderPackageTable(items) {
  const rows = [
    '| Package | Version | Boundary | Purpose | Package documentation |',
    '| --- | --- | --- | --- | --- |',
    ...items.map((item) =>
      `| \`${item.name}\` | \`${item.version}\` | ${item.classification ?? 'unclassified'} | ${escapeCell(item.description)} | [README](../packages/${item.directory}/README.md) |`,
    ),
  ];
  return `\n${rows.join('\n')}\n`;
}

function betweenMarkers(content, start, end) {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return undefined;
  return content.slice(startIndex + start.length, endIndex);
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
