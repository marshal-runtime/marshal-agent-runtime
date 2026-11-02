import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicationRoot = dirname(fileURLToPath(import.meta.url));
const allowedEvidence = new Set(['offline-executable', 'generated-fixture', 'required-uncut-live']);
const forbiddenMedia = new Set(['.gif', '.mp4', '.webm', '.mov', '.png', '.jpg', '.jpeg', '.webp']);

async function json(path) {
  return JSON.parse(await readFile(join(publicationRoot, path), 'utf8'));
}

async function exists(path) {
  try {
    return (await stat(join(publicationRoot, path))).isFile();
  } catch {
    return false;
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function completeFallback(value) {
  return object(value)
    && typeof value.summary === 'string'
    && value.summary.trim().length >= 40
    && object(value.details)
    && Object.keys(value.details).length > 0;
}

function validateApplication(application, label, errors) {
  if (!object(application) || application.version !== '1.0.0') errors.push(`${label}: version must be 1.0.0`);
  if (!Array.isArray(application.presentationModes) || !application.presentationModes.includes('inline')) {
    errors.push(`${label}: presentationModes must include inline`);
  }
  if (!Array.isArray(application.actions) || !Array.isArray(application.tools)) {
    errors.push(`${label}: actions and tools must be arrays`);
    return;
  }
  const ids = new Set();
  for (const action of application.actions) {
    if (!object(action) || typeof action.id !== 'string' || ids.has(action.id)) errors.push(`${label}: action ids must be unique strings`);
    else ids.add(action.id);
    if (!object(action?.target) || !['capability', 'module'].includes(action.target.kind)) errors.push(`${label}: ${action?.id ?? 'action'} has an invalid target`);
    if (!object(action?.inputSchema) || !object(action?.outputSchema)) errors.push(`${label}: ${action?.id ?? 'action'} requires input and output schemas`);
    if (!Array.isArray(action?.allowedScopes) || action.allowedScopes.length === 0) errors.push(`${label}: ${action?.id ?? 'action'} requires allowedScopes`);
    if (!Array.isArray(action?.requiredPermissions)) errors.push(`${label}: ${action?.id ?? 'action'} requires requiredPermissions`);
    if (!['read', 'write', 'external-effect'].includes(action?.risk)) errors.push(`${label}: ${action?.id ?? 'action'} has invalid risk`);
    if (!['required', 'supported', 'none'].includes(action?.idempotency)) errors.push(`${label}: ${action?.id ?? 'action'} has invalid idempotency`);
    if (action?.target?.kind === 'module') {
      const module = action.target.module;
      if (!object(module) || !['workspace_file', 'artifact'].includes(module.kind) || typeof module.path !== 'string') {
        errors.push(`${label}: ${action.id} must bind an editable workspace or artifact module`);
      }
    }
  }
}

async function walk(root = publicationRoot) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) results.push(...await walk(path));
    else results.push(path);
  }
  return results;
}

export async function validatePublicationExamples() {
  const errors = [];
  const catalog = await json('catalog.json');
  const capturePlan = await json('demo-capture/capture-plan.json');
  const permissions = await json('permission-profiles.json');
  const receipts = await json('expected-receipts.json');
  const examples = Array.isArray(catalog.examples) ? catalog.examples : [];
  const ids = new Set();

  if (catalog.evidencePolicy?.generatedFixturesAreLiveEvidence !== false) {
    errors.push('catalog: generatedFixturesAreLiveEvidence must be false');
  }
  if (catalog.evidencePolicy?.uncutLiveRequiredForVisualClaims !== true) {
    errors.push('catalog: uncutLiveRequiredForVisualClaims must be true');
  }
  for (const policyPath of [catalog.evidencePolicy?.index, catalog.evidencePolicy?.capturePlan]) {
    if (typeof policyPath !== 'string' || !await exists(policyPath)) errors.push(`catalog: missing evidence policy file ${policyPath}`);
  }

  for (const example of examples) {
    if (!object(example) || typeof example.id !== 'string' || ids.has(example.id)) {
      errors.push('catalog: example ids must be unique strings');
      continue;
    }
    ids.add(example.id);
    if (!object(permissions.profiles?.[example.permissionProfile])) errors.push(`${example.id}: unknown permission profile ${example.permissionProfile}`);
    if (!object(receipts.expectations?.[example.expectedReceipt])) errors.push(`${example.id}: unknown receipt expectation ${example.expectedReceipt}`);
    if (!Array.isArray(example.evidence) || example.evidence.some((item) => !allowedEvidence.has(item))) errors.push(`${example.id}: invalid evidence label`);
    if (!example.evidence.includes('required-uncut-live')) errors.push(`${example.id}: publication examples must declare remaining uncut live evidence`);
    for (const source of example.sources ?? []) {
      if (!await exists(source)) errors.push(`${example.id}: missing source ${source}`);
      else {
        const content = await readFile(join(publicationRoot, source), 'utf8');
        if (/C:\\other\\wbg|\/home\/[^/]+\//i.test(content)) errors.push(`${source}: contains a development-machine absolute path`);
        if (/from\s+['"][^'"]+\/src\//.test(content)) errors.push(`${source}: imports a package-internal src path`);
      }
    }
    const fallbackFiles = [];
    for (const fixture of example.fixtures ?? []) {
      if (!await exists(fixture)) errors.push(`${example.id}: missing fixture ${fixture}`);
      if (fixture.endsWith('fallback.json')) fallbackFiles.push(fixture);
      if (fixture.endsWith('application.json')) {
        const application = await json(fixture);
        validateApplication(application, fixture, errors);
        const profile = permissions.profiles[example.permissionProfile];
        for (const action of application.actions ?? []) {
          for (const permission of action.requiredPermissions ?? []) {
            if (!profile.grants.includes(permission)) errors.push(`${fixture}: ${permission} is absent from ${example.permissionProfile}`);
          }
          if (action.target?.kind === 'module' && action.target.module.kind === 'workspace_file') {
            if (!await exists(relative(publicationRoot, resolve(publicationRoot, '..', '..', action.target.module.path)))) {
              errors.push(`${fixture}: module path does not resolve to a publication source: ${action.target.module.path}`);
            }
          }
        }
      }
    }
    if (/^ui-|presentation|restart|design-studio/.test(example.id) && fallbackFiles.length === 0) errors.push(`${example.id}: interactive example requires a fallback fixture`);
    for (const fallbackFile of fallbackFiles) {
      const fallback = await json(fallbackFile);
      if (!completeFallback(fallback)) errors.push(`${fallbackFile}: fallback must contain a complete summary and details`);
      if (/\b(?:TODO|TBD|lorem ipsum)\b/i.test(JSON.stringify(fallback))) errors.push(`${fallbackFile}: fallback contains placeholder text`);
    }
  }

  for (const [id, expectation] of Object.entries(receipts.expectations ?? {})) {
    if (!ids.has(id)) errors.push(`expected-receipts: ${id} has no catalog entry`);
    if (!Array.isArray(expectation.requiredFields) || expectation.requiredFields.length === 0) errors.push(`${id}: requiredFields must be non-empty`);
    if (!Array.isArray(expectation.dynamicFields) || expectation.dynamicFields.length === 0) errors.push(`${id}: dynamicFields must disclose non-fixture values`);
  }

  const capturedExampleIds = new Set();
  for (const demo of capturePlan.demos ?? []) {
    if (!Array.isArray(demo.catalogExampleIds) || demo.catalogExampleIds.length === 0) {
      errors.push(`capture plan: ${demo.id ?? 'unnamed demo'} requires catalogExampleIds`);
    }
    for (const id of demo.catalogExampleIds ?? []) {
      if (!ids.has(id)) errors.push(`capture plan: ${demo.id} references unknown example ${id}`);
      capturedExampleIds.add(id);
    }
    if (!Array.isArray(demo.requiredCaptureFiles) || !demo.requiredCaptureFiles.includes('screen.webm')) {
      errors.push(`capture plan: ${demo.id} requires an uncut screen.webm`);
    }
    if (!demo.requiredCaptureFiles?.includes('recorder.json')) {
      errors.push(`capture plan: ${demo.id} requires recorder provenance`);
    }
    if ((demo.requiredHostGates ?? []).length > 0) {
      if (!demo.requiredCaptureFiles?.includes('host-gates.json')) errors.push(`capture plan: ${demo.id} requires host-gates.json`);
      if (new Set(demo.requiredHostGates).size !== demo.requiredHostGates.length) errors.push(`capture plan: ${demo.id} host gates must be unique`);
    }
    for (const file of ['review.json', 'preview.gif', 'short.mp4', 'derivatives.json']) {
      if (!demo.requiredPublicationFiles?.includes(file)) errors.push(`capture plan: ${demo.id} publication files must include ${file}`);
    }
  }
  for (const id of ids) {
    if (!capturedExampleIds.has(id)) errors.push(`capture plan: catalog example ${id} has no live capture route`);
  }

  for (const file of await walk()) {
    if (forbiddenMedia.has(extname(file).toLowerCase())) errors.push(`${relative(publicationRoot, file)}: media is not allowed without captured evidence provenance`);
  }

  return { ok: errors.length === 0, errors, exampleCount: examples.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  const result = await validatePublicationExamples();
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Validated ${result.exampleCount} publication examples without live or paid runs.`);
  }
}
