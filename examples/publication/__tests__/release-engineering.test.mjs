import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  authorityTemplatePath,
  dependencyOrderedMatrix,
  readJson,
  readWorkspacePackages,
  renderAuthorityTemplate,
  stableJson,
  validateAuthority,
  validateLicenseAuthority,
  validatePublishEnvironment,
} from '../../../scripts/release-engineering.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('authority template is exact, complete, credential-free, and undecided', async () => {
  const packages = await readWorkspacePackages(root);
  const template = await readJson(authorityTemplatePath);
  assert.equal(stableJson(template), stableJson(renderAuthorityTemplate(packages)));
  assert.deepEqual(validateAuthority(template, packages, { template: true }), []);
  assert.deepEqual(validateLicenseAuthority(template, { licenses: [], unresolvedLicenses: [] }, { template: true }), []);
  assert.match(stableJson(template), /"repositoryUrl": null/);
  assert.doesNotMatch(stableJson(template), /(?:token|password|secret|otp)"\s*:/i);
});

test('publish matrix places every internal dependency before its consumer', async () => {
  const packages = await readWorkspacePackages(root);
  const matrix = dependencyOrderedMatrix(packages);
  assert.equal(matrix.length, packages.length);
  const position = new Map(matrix.map((item) => [item.name, item.order]));
  for (const item of matrix) {
    for (const dependency of item.internalDependencies) assert.ok(position.get(dependency) < item.order, `${dependency} must precede ${item.name}`);
  }
});

test('publish environment rejects missing OIDC and accepts only exact bound identity', async () => {
  const packages = await readWorkspacePackages(root);
  const authority = renderAuthorityTemplate(packages);
  authority.github.repository = 'owner/repository';
  authority.github.environment = 'protected-environment';
  assert.ok(validatePublishEnvironment(authority, {}).length >= 7);
  const environment = {
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    MARSHAL_RELEASE_CONFIRMATION: 'publish-with-provenance',
    GITHUB_REPOSITORY: 'owner/repository',
    MARSHAL_NPM_ENVIRONMENT: 'protected-environment',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://identity.invalid',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ephemeral-test-value',
    GITHUB_SHA: 'a'.repeat(40),
    MARSHAL_RELEASE_COMMIT: 'a'.repeat(40),
    MARSHAL_RELEASE_TAG: 'next',
    MARSHAL_RELEASE_ACCESS: 'public',
  };
  authority.npm.tag = 'next';
  authority.npm.access = 'public';
  assert.deepEqual(validatePublishEnvironment(authority, environment), []);
});

test('checked-in inventory is byte-for-byte current and release workflow has non-bypassable identity gates', async () => {
  const inventory = spawnSync(process.execPath, [path.join(root, 'scripts', 'release-inventory.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(inventory.status, 0, inventory.stderr || inventory.stdout);
  const workflow = await readFile(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
  const publisher = await readFile(path.join(root, 'scripts', 'release-publish-matrix.mjs'), 'utf8');
  for (const fragment of [
    "vars.MARSHAL_NPM_PUBLISH_ENABLED == 'true'",
    'vars.MARSHAL_RELEASE_REPOSITORY == github.repository',
    'environment:',
    'id-token: write',
    'persist-credentials: false',
    'release-authority.json',
  ]) assert.ok(workflow.includes(fragment), `missing workflow gate: ${fragment}`);
  assert.ok(publisher.includes("arguments_.push('--provenance')"), 'publisher must request npm provenance');
});

// TODO(#11): Hosted Node layout has no npm-cli.js at the expected path.
test.skip('real npm publish dry-run executes packed tarballs in dependency order without uploading', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'marshal-release-dry-run-test-'));
  try {
    const packageManagerCli = await resolvePackageManagerCli();
    const packageManagerVersion = spawnSync(process.execPath, [packageManagerCli, '--version'], { encoding: 'utf8' });
    assert.equal(packageManagerVersion.status, 0, packageManagerVersion.stderr || packageManagerVersion.stdout);
    assert.equal(packageManagerVersion.stdout.trim(), '10.32.1');
    const packages = [
      { directory: 'base', name: '@fixture/base', dependencies: {} },
      { directory: 'consumer', name: '@fixture/consumer', dependencies: { '@fixture/base': 'workspace:*' } },
    ];
    await writeFile(path.join(fixtureRoot, 'package.json'), stableJson({ private: true, packageManager: 'pnpm@10.32.1' }));
    await writeFile(path.join(fixtureRoot, 'LICENSE'), 'MIT fixture license\n');
    await writeFile(path.join(fixtureRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    for (const item of packages) {
      const packageRoot = path.join(fixtureRoot, 'packages', item.directory);
      await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
      await writeFile(path.join(packageRoot, 'README.md'), `# ${item.name}\n`);
      await writeFile(path.join(packageRoot, 'LICENSE'), 'MIT fixture license\n');
      await writeFile(path.join(packageRoot, 'dist', 'index.js'), 'export const ok = true;\n');
      await writeFile(path.join(packageRoot, 'dist', 'index.d.ts'), 'export declare const ok: true;\n');
      await writeFile(path.join(packageRoot, 'package.json'), stableJson({
        name: item.name,
        version: '1.2.3',
        description: 'Release dry-run fixture',
        license: 'MIT',
        type: 'module',
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
        files: ['dist', 'README.md', 'LICENSE'],
        dependencies: item.dependencies,
        publishConfig: { access: 'public' },
        repository: { type: 'git', url: 'https://github.com/fixture/repository.git', directory: `packages/${item.directory}` },
        homepage: 'https://example.invalid/fixture',
        bugs: { url: 'https://example.invalid/fixture/issues' },
      }));
    }
    const authority = {
      schemaVersion: 1,
      source: {
        repositoryUrl: 'https://github.com/fixture/repository.git',
        homepageUrl: 'https://example.invalid/fixture',
        bugsUrl: 'https://example.invalid/fixture/issues',
      },
      npm: { registryUrl: 'https://127.0.0.1:9', scope: '@fixture', access: 'public', tag: 'fixture-test' },
      release: { packageVersions: { '@fixture/base': '1.2.3', '@fixture/consumer': '1.2.3' } },
      licenses: { approvedExpressions: ['MIT'], reviewReference: 'fixture-review-record' },
      github: {
        serverUrl: 'https://github.com',
        repository: 'fixture/repository',
        environment: 'fixture-environment',
        workflowPath: '.github/workflows/publish.yml',
        trustedPublisher: {
          owner: 'fixture',
          repository: 'repository',
          workflowFilename: 'publish.yml',
          environment: 'fixture-environment',
        },
      },
    };
    const authorityFile = path.join(fixtureRoot, 'authority.json');
    await writeFile(authorityFile, stableJson(authority));
    const install = spawnSync(process.execPath, [packageManagerCli, 'install', '--ignore-scripts'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'release-publish-matrix.mjs'),
      '--dry-run',
      '--root', fixtureRoot,
      '--authority', authorityFile,
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        npm_execpath: packageManagerCli,
        npm_config_user_agent: `pnpm/${packageManagerVersion.stdout.trim()} node/${process.versions.node}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run');
    assert.deepEqual(report.packages.map((item) => item.name), ['@fixture/base', '@fixture/consumer']);
  } finally {
    const resolved = path.resolve(fixtureRoot);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await rm(resolved, { recursive: true, force: true });
  }
});

async function resolvePackageManagerCli() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  const corepackPnpm = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  await access(corepackPnpm);
  return corepackPnpm;
}
