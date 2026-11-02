import { canonicalJson } from './core.mjs';

/**
 * Deterministic, data-only graders. A command adapter extracts observations;
 * this module owns the comparison so neither treatment can change the rubric.
 */
export function gradeObjectiveObservation(assertion, observation) {
  if (!observation || typeof observation !== 'object') return missing(assertion);
  const grader = observation.grader ?? `objective-${observation.type ?? assertion.kind}`;
  const notes = observation.notes;
  let score;
  switch (observation.type ?? 'score') {
    case 'boolean':
      score = observation.actual === true ? 1 : 0;
      break;
    case 'exact-json':
      score = canonicalJson(observation.actual) === canonicalJson(observation.expected) ? 1 : 0;
      break;
    case 'contains-all': {
      const actual = String(observation.actual ?? '');
      const expected = Array.isArray(observation.expected) ? observation.expected : [];
      score = expected.length > 0 && expected.every((value) => actual.includes(String(value))) ? 1 : 0;
      break;
    }
    case 'numeric-range':
      score = typeof observation.actual === 'number'
        && (observation.minimum === undefined || observation.actual >= observation.minimum)
        && (observation.maximum === undefined || observation.actual <= observation.maximum)
        ? 1
        : 0;
      break;
    case 'digest-equals':
      score = /^[a-f0-9]{64}$/.test(observation.actual ?? '')
        && observation.actual === observation.expected
        ? 1
        : 0;
      break;
    case 'score':
      score = observation.score;
      break;
    default:
      return {
        score: 0,
        grader: 'objective-unsupported-signal',
        notes: `Unsupported deterministic observation type: ${observation.type}`,
      };
  }
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    return missing(assertion, 'Adapter supplied an invalid deterministic assertion signal.');
  }
  return { score, grader, ...(notes ? { notes } : {}) };
}

function missing(assertion, notes = 'Adapter supplied no valid deterministic assertion signal.') {
  return {
    score: 0,
    grader: 'objective-missing-signal',
    notes: `${assertion.id}: ${notes}`,
  };
}
