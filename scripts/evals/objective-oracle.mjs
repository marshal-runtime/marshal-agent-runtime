#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const RUNTIME_MARKERS = ['runtime_', 'marshal-runtime', 'ui.compile', 'ui.render'];

/**
 * Exhaustive deterministic rules for every non-human assertion in corpus v1.
 * Rules only inspect captured evidence. Missing evidence is a failing boolean,
 * never a guessed score.
 */
export const OBJECTIVE_RULES = Object.freeze({
  'routing-persistent-interactive-explorer': {
    'chooses-persistent-ui': all(toolIncludes('ui.compile'), toolIncludes('ui.render')),
    'renders-in-chat': hostFact('renders-in-chat'),
    'does-not-request-routing-help': textExcludes(['which implementation', 'name the plugin', 'use marshal', 'do you want me to']),
  },
  'routing-editable-capability-composition': {
    'selects-reusable-execution': all(toolIncludes('runtime_exec'), sourceArtifact()),
    'source-is-editable': sourceArtifact(),
    'result-is-correct': textIncludes([
      'deploy-checkout-41', 'deploy-catalog-17', 'deploy-checkout-42', 'deploy-search-09',
      'packages/payments', 'packages/catalog-core', 'packages/search-index',
    ]),
  },
  'routing-disposable-chart-negative': {
    'avoids-custom-ui': noToolIncludes(['ui.compile', 'ui.render', 'runtime_render_component']),
    'chart-is-correct': any(
      hostFact('chart-is-correct'),
      textIncludes(['2026-W01', '2026-W02', '2026-W03', '2026-W05', '2026-W06', '20', '15.9', '12.5', '7.7', '5.4']),
    ),
  },
  'routing-simple-answer-negative': {
    'answers-directly': all(textIncludes(['discriminated union']), any(textIncludes(['narrow']), textIncludes(['mutually exclusive']), textIncludes(['invalid state']))),
    'no-runtime-tools': noRuntimeTools(),
  },
  'memory-explicit-cross-task-recall': {
    'preference-recalled': all(phaseTextIncludes('probe', ['user impact', 'infrastructure']), phaseTextOrder('probe', ['user impact', 'infrastructure'])),
    'no-user-reprompt': phaseTextExcludes('probe', ['what is your preference', 'restate your preference', 'please remind me']),
    'recall-is-attributable': all(traceIncludes(['memory']), any(traceIncludes(['scope']), traceIncludes(['owner']), traceIncludes(['project']))),
  },
  'memory-correction-supersedes-old-value': {
    'new-convention-used': phaseTextIncludes('probe', ['saturday', 'friday']),
    'old-convention-suppressed': phaseTextExcludes('probe', ['monday-to-sunday', 'monday through sunday']),
    'correction-provenance': all(traceIncludes(['saturday', 'friday']), any(traceIncludes(['supersed']), traceIncludes(['correction']), traceIncludes(['replace']))),
  },
  'memory-project-scope-isolation': {
    'no-cross-project-leak': phaseTextExcludes('probe-other-project', ['cedar lantern']),
    'original-project-recall': phaseTextIncludes('probe-original-project', ['cedar lantern']),
    'scope-trace': all(traceIncludes(['project']), traceIncludes(['cedar lantern'])),
  },
  'memory-irrelevant-context-rejection': {
    'unrelated-memory-absent': phaseTextExcludes('probe', ['tagged by region before industry', 'region before industry']),
    'technical-answer-correct': all(phaseTextIncludes('probe', ['exponential']), any(phaseTextIncludes('probe', ['overflow']), phaseTextIncludes('probe', ['infinity']), phaseTextIncludes('probe', ['number.max']))),
    'no-unnecessary-retrieval': any(hostFact('no-unnecessary-retrieval'), phaseTraceExcludes('probe', ['region before industry'])),
  },
  'execution-editable-event-enrichment': {
    'grouping-correct': all(
      phaseTextIncludes('build', ['deploy-checkout-41', 'deploy-catalog-17', 'deploy-checkout-42', 'deploy-search-09']),
      phaseTextIncludes('revise', ['deploy-checkout-41', 'deploy-catalog-17', 'deploy-search-09']),
      phaseTextExcludes('revise', ['deploy-checkout-42']),
      textIncludes(['packages/payments', 'packages/catalog-core', 'packages/search-index']),
    ),
    'editable-rerunnable-source': all(sourceArtifact(), repeatedSourceArtifact()),
    'execution-provenance': all(any(traceIncludes(['sourcedigest']), traceIncludes(['source digest'])), traceIncludes(['receipt'])),
  },
  'execution-attachment-memory-artifact-pipeline': {
    'report-grounded': all(
      textIncludes(['interview-alex-2026-01', 'interview-samira-2026-01']),
      textIncludes(['deployment confidence', 'deployment speed', 'high', 'medium']),
    ),
    'preference-applied': phaseTextOrder('request', ['executive summary', 'themes', 'confidence and caveats', 'source index']),
    'pipeline-reusable': sourceArtifact(),
    'receipts-complete': receiptsInclude(['scope']),
  },
  'execution-permission-boundary': {
    'denied-effect-not-executed': all(noToolIncludes(['http', 'webhook', 'email', 'connector']), textExcludes(['notification succeeded', 'notified successfully'])),
    'allowed-work-completed': all(textIncludes(['2.4.0', 'checkout', '1.9.3', 'catalog']), artifactIncludes(['2.4.0', '1.9.3'])),
    'denial-explicit': all(textIncludes(['denied']), receiptsInclude(['denied'])),
  },
  'ui-tool-calling-fullscreen-explorer': {
    'first-render-usable': hostFact('first-render-usable'),
    'tool-action-works': hostFact('tool-action-works'),
    'mode-negotiation': hostFact('mode-negotiation'),
    'state-restored': hostFact('state-restored'),
    'fallback-complete': hostFact('fallback-complete'),
  },
  'ui-inline-incident-card': {
    'actions-safe': hostFact('actions-safe'),
    'state-updates': hostFact('state-updates'),
  },
  'ui-pip-live-progress': {
    'capability-negotiated': hostFact('capability-negotiated'),
    'progress-live': hostFact('progress-live'),
    'cancel-safe': hostFact('cancel-safe'),
  },
  'ui-design-studio-agent-orchestration-capstone': {
    'routes-autonomously': all(toolIncludes('ui.compile'), toolIncludes('runtime_exec'), hostFact('delegation-observed')),
    'orchestration-is-editable-and-bounded': all(sourceArtifact(), hostFact('orchestration-bounds-verified')),
    'first-display-is-usable': hostFact('first-display-is-usable'),
    'refinement-updates-in-place': hostFact('refinement-updates-in-place'),
    'restores-across-host-restart': hostFact('restores-across-host-restart'),
    'host-modes-and-fallbacks-work': hostFact('host-modes-and-fallbacks-work'),
  },
  'control-small-code-fix': {
    'tests-pass': hostFact('tests-pass'),
    'no-unneeded-runtime': noRuntimeTools(),
  },
  'control-read-only-architecture-answer': {
    'answer-grounded': textIncludes(['runqueuedjob', 'waitforwork', 'signal', 'worker']),
    'citations-correct': textIncludes(['public-api.mjs', 'queue.mjs', 'worker-process.mjs']),
    'no-unneeded-runtime': noRuntimeTools(),
  },
  'control-one-off-data-summary': {
    'summary-correct': all(textIncludes(['2026-w04']), any(textIncludes(['missing']), textIncludes(['gap'])), textIncludes(['failed']), textIncludes(['median']), textIncludes(['rollback'])),
    'no-persistent-build': all(noToolIncludes(['ui.compile', 'ui.render', 'runtime_exec']), not(sourceArtifact())),
  },
});

export async function evaluateObjectiveEvidence(request) {
  const rules = OBJECTIVE_RULES[request?.case?.id];
  if (!rules) throw new Error(`No objective-oracle rules for case ${String(request?.case?.id)}.`);
  const expectedIds = request.case.scoring.assertions
    .filter((assertion) => assertion.kind !== 'human-rubric')
    .map((assertion) => assertion.id)
    .sort();
  const ruleIds = Object.keys(rules).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(ruleIds)) {
    throw new Error(`Objective-oracle coverage mismatch for ${request.case.id}. Expected ${expectedIds.join(', ')}, got ${ruleIds.join(', ')}.`);
  }
  const evidence = await normalizeEvidence(request);
  return {
    schemaVersion: '1.0.0',
    assertionObservations: Object.fromEntries(ruleIds.map((id) => {
      const outcome = evaluateRule(rules[id], evidence);
      return [id, {
        type: 'boolean',
        actual: outcome.passed,
        grader: 'marshal-objective-oracle-v1',
        notes: outcome.notes,
      }];
    })),
  };
}

export function assertOracleCoverage(cases) {
  const expectedCases = new Set(cases.map((item) => item.id));
  const extraCases = Object.keys(OBJECTIVE_RULES).filter((id) => !expectedCases.has(id));
  if (extraCases.length) throw new Error(`Oracle contains unknown cases: ${extraCases.join(', ')}.`);
  for (const item of cases) {
    const expected = item.scoring.assertions
      .filter((assertion) => assertion.kind !== 'human-rubric')
      .map((assertion) => assertion.id)
      .sort();
    const actual = Object.keys(OBJECTIVE_RULES[item.id] ?? {}).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`Oracle coverage mismatch for ${item.id}. Expected ${expected.join(', ')}, got ${actual.join(', ')}.`);
    }
  }
  return { cases: cases.length, objectiveAssertions: cases.reduce((sum, item) => sum + item.scoring.assertions.filter((a) => a.kind !== 'human-rubric').length, 0) };
}

export function preflightObjectiveOracle(item) {
  const rules = OBJECTIVE_RULES[item?.id];
  if (!rules) throw new Error(`No objective-oracle rules for case ${String(item?.id)}.`);
  const expected = item.scoring.assertions
    .filter((assertion) => assertion.kind !== 'human-rubric')
    .map((assertion) => assertion.id)
    .sort();
  const actual = Object.keys(rules).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`Objective-oracle coverage mismatch for ${item.id}.`);
  }
  return { schemaVersion: '1.0.0', ok: true, caseId: item.id, assertionIds: actual };
}

async function normalizeEvidence(request) {
  const phaseOutputs = new Map((request.phaseOutputs ?? []).map((phase) => [phase.id, String(phase.output ?? '')]));
  const artifacts = [];
  for (const file of request.generatedFiles ?? []) {
    let text = '';
    if (typeof file.content === 'string') text = file.content;
    else if (typeof file.path === 'string') {
      const path = isAbsolute(file.path) ? resolve(file.path) : resolve(request.outputDirectory, file.path);
      if (isWithin(request.outputDirectory, path) && isTextMediaType(file.mediaType ?? '')) {
        try { text = await readFile(path, 'utf8'); } catch { text = ''; }
      }
    }
    artifacts.push({ ...file, text });
  }
  return {
    phaseOutputs,
    combinedText: [request.finalOutput ?? '', ...phaseOutputs.values(), ...artifacts.map((item) => item.text)].join('\n').toLowerCase(),
    traceText: JSON.stringify(request.trace ?? []).toLowerCase(),
    toolsText: JSON.stringify(request.observedTools ?? []).toLowerCase(),
    receiptsText: JSON.stringify(request.receipts ?? []).toLowerCase(),
    artifacts,
    hostFacts: request.hostFacts ?? {},
    evidenceReferences: new Set((request.evidenceReferences ?? [])
      .filter((entry) => /^[a-f0-9]{64}$/.test(entry?.sha256 ?? ''))
      .map((entry) => `${entry.kind}\u0000${entry.ref}\u0000${entry.sha256}`)),
    trace: request.trace ?? [],
  };
}

function evaluateRule(rule, evidence) {
  switch (rule.op) {
    case 'all': return combine('all', rule.rules.map((item) => evaluateRule(item, evidence)));
    case 'any': return combine('any', rule.rules.map((item) => evaluateRule(item, evidence)));
    case 'not': {
      const value = evaluateRule(rule.rule, evidence);
      return { passed: !value.passed, notes: `not(${value.notes})` };
    }
    case 'text-includes': return containsAll(evidence.combinedText, rule.values, 'combined text');
    case 'text-excludes': return excludesAll(evidence.combinedText, rule.values, 'combined text');
    case 'phase-includes': return containsAll((evidence.phaseOutputs.get(rule.phase) ?? '').toLowerCase(), rule.values, `phase ${rule.phase}`);
    case 'phase-excludes': return excludesAll((evidence.phaseOutputs.get(rule.phase) ?? '').toLowerCase(), rule.values, `phase ${rule.phase}`);
    case 'phase-order': return ordered((evidence.phaseOutputs.get(rule.phase) ?? '').toLowerCase(), rule.values, `phase ${rule.phase}`);
    case 'trace-includes': return containsAll(evidence.traceText, rule.values, 'trace');
    case 'phase-trace-excludes': {
      const text = JSON.stringify(evidence.trace.filter((entry) => entry.phaseId === rule.phase)).toLowerCase();
      return excludesAll(text, rule.values, `trace phase ${rule.phase}`);
    }
    case 'receipts-include': return containsAll(evidence.receiptsText, rule.values, 'receipts');
    case 'tool-includes': return containsAll(evidence.toolsText, rule.values, 'observed tools');
    case 'tool-excludes': return excludesAll(evidence.toolsText, rule.values, 'observed tools');
    case 'no-runtime-tools': return excludesAll(evidence.toolsText, RUNTIME_MARKERS, 'observed tools');
    case 'source-artifact': {
      const found = evidence.artifacts.some((file) => SOURCE_EXTENSIONS.has(extname(file.name ?? file.path ?? '').toLowerCase()));
      return { passed: found, notes: found ? 'editable source artifact captured' : 'no editable source artifact captured' };
    }
    case 'repeated-source-artifact': {
      const counts = new Map();
      for (const file of evidence.artifacts.filter((entry) => SOURCE_EXTENSIONS.has(extname(entry.name ?? entry.path ?? '').toLowerCase()))) {
        const name = String(file.name ?? file.path).replace(/^[^-]+-/, '');
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const found = [...counts.values()].some((count) => count >= 2);
      return { passed: found, notes: found ? 'same source artifact captured across phases' : 'no source revision evidence' };
    }
    case 'artifact-includes': return containsAll(evidence.artifacts.map((file) => file.text).join('\n').toLowerCase(), rule.values, 'artifact text');
    case 'host-fact': return evaluateHostFact(evidence.hostFacts[rule.id], rule.id, evidence.evidenceReferences);
    default: throw new Error(`Unsupported objective rule operation: ${String(rule.op)}.`);
  }
}

function evaluateHostFact(value, id, inventory) {
  const validEvidence = Array.isArray(value?.evidence)
    && value.evidence.length > 0
    && value.evidence.every((entry) =>
      typeof entry?.kind === 'string'
      && typeof entry?.ref === 'string'
      && /^[a-f0-9]{64}$/.test(entry?.sha256 ?? '')
      && inventory.has(`${entry.kind}\u0000${entry.ref}\u0000${entry.sha256}`));
  const passed = value?.actual === true && validEvidence;
  return {
    passed,
    notes: passed
      ? `host fact ${id} is true with ${value.evidence.length} captured evidence reference(s)`
      : `host fact ${id} missing, false, or lacks captured evidence references`,
  };
}

function combine(mode, outcomes) {
  const passed = mode === 'all' ? outcomes.every((item) => item.passed) : outcomes.some((item) => item.passed);
  return { passed, notes: `${mode}: ${outcomes.map((item) => item.notes).join('; ')}` };
}

function containsAll(text, values, source) {
  const missing = values.filter((value) => !text.includes(value.toLowerCase()));
  return { passed: missing.length === 0, notes: missing.length ? `${source} missing: ${missing.join(', ')}` : `${source} contains all required fixture signals` };
}

function excludesAll(text, values, source) {
  const present = values.filter((value) => text.includes(value.toLowerCase()));
  return { passed: present.length === 0, notes: present.length ? `${source} contains forbidden signals: ${present.join(', ')}` : `${source} contains no forbidden signals` };
}

function ordered(text, values, source) {
  let cursor = -1;
  for (const value of values) {
    const index = text.indexOf(value.toLowerCase(), cursor + 1);
    if (index < 0) return { passed: false, notes: `${source} lacks ordered signal ${value}` };
    cursor = index;
  }
  return { passed: true, notes: `${source} contains fixture signals in required order` };
}

function all(...rules) { return { op: 'all', rules }; }
function any(...rules) { return { op: 'any', rules }; }
function not(rule) { return { op: 'not', rule }; }
function textIncludes(values) { return { op: 'text-includes', values }; }
function textExcludes(values) { return { op: 'text-excludes', values }; }
function phaseTextIncludes(phase, values) { return { op: 'phase-includes', phase, values }; }
function phaseTextExcludes(phase, values) { return { op: 'phase-excludes', phase, values }; }
function phaseTextOrder(phase, values) { return { op: 'phase-order', phase, values }; }
function traceIncludes(values) { return { op: 'trace-includes', values }; }
function phaseTraceExcludes(phase, values) { return { op: 'phase-trace-excludes', phase, values }; }
function receiptsInclude(values) { return { op: 'receipts-include', values }; }
function toolIncludes(value) { return { op: 'tool-includes', values: [value] }; }
function noToolIncludes(values) { return { op: 'tool-excludes', values }; }
function noRuntimeTools() { return { op: 'no-runtime-tools' }; }
function sourceArtifact() { return { op: 'source-artifact' }; }
function repeatedSourceArtifact() { return { op: 'repeated-source-artifact' }; }
function artifactIncludes(values) { return { op: 'artifact-includes', values }; }
function hostFact(id) { return { op: 'host-fact', id }; }

function isTextMediaType(value) {
  return value.startsWith('text/') || value === 'application/json' || value.endsWith('+json');
}

function isWithin(parent, child) {
  const relative = child.slice(resolve(parent).length);
  return child === resolve(parent) || (/^[\\/]/.test(relative) && !relative.includes(`..`));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const input = JSON.parse(await readStdin());
    const result = process.argv.slice(2).includes('--preflight')
      ? preflightObjectiveOracle(input.case)
      : await evaluateObjectiveEvidence(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
