import type {
  RuntimeCapabilityDescriptor,
  RuntimeCatalogEntry,
  RuntimeCatalogSearchMatch,
  RuntimeSearchMatch,
} from './contracts.js';
import { RUNTIME_PROTOCOL_VERSION } from './contracts.js';

const FIELD_ORDER = ['name', 'title', 'description', 'tags'] as const;
type MatchField = (typeof FIELD_ORDER)[number];

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      normalize(query)
        .split(/[^\p{L}\p{N}_.:-]+/u)
        .filter(Boolean),
    ),
  ];
}

/** Pure deterministic ranker used by RuntimeKernel.runtimeSearch. */
export function rankCapability(
  descriptor: RuntimeCapabilityDescriptor,
  query: string,
): RuntimeSearchMatch<RuntimeCapabilityDescriptor> | undefined {
  const normalizedQuery = normalize(query);
  const terms = queryTerms(query);
  const name = normalize(descriptor.name);
  const title = normalize(descriptor.title ?? '');
  const description = normalize(descriptor.description);
  const tags = (descriptor.tags ?? []).map(normalize);
  const matchedTerms = new Set<string>();
  const matchedFields = new Set<MatchField>();
  let score = 0;

  if (!normalizedQuery) {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      capability: descriptor,
      score: 0,
      matchedTerms: [],
      matchedFields: [],
    };
  }

  if (name === normalizedQuery) {
    score += 1_000;
    matchedFields.add('name');
  } else if (name.startsWith(normalizedQuery)) {
    score += 450;
    matchedFields.add('name');
  } else if (name.includes(normalizedQuery)) {
    score += 300;
    matchedFields.add('name');
  }

  if (title === normalizedQuery) {
    score += 800;
    matchedFields.add('title');
  } else if (title.includes(normalizedQuery)) {
    score += 220;
    matchedFields.add('title');
  }

  if (tags.includes(normalizedQuery)) {
    score += 180;
    matchedFields.add('tags');
  }
  if (description.includes(normalizedQuery)) {
    score += 100;
    matchedFields.add('description');
  }

  for (const term of terms) {
    let termMatched = false;
    if (name === term) {
      score += 90;
      matchedFields.add('name');
      termMatched = true;
    } else if (name.startsWith(term)) {
      score += 60;
      matchedFields.add('name');
      termMatched = true;
    } else if (name.includes(term)) {
      score += 40;
      matchedFields.add('name');
      termMatched = true;
    }
    if (title.includes(term)) {
      score += 28;
      matchedFields.add('title');
      termMatched = true;
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 24;
      matchedFields.add('tags');
      termMatched = true;
    }
    if (description.includes(term)) {
      score += 10;
      matchedFields.add('description');
      termMatched = true;
    }
    if (termMatched) matchedTerms.add(term);
  }

  if (score === 0) return undefined;
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    capability: descriptor,
    score,
    matchedTerms: [...matchedTerms],
    matchedFields: FIELD_ORDER.filter((field) => matchedFields.has(field)),
  };
}

const CATALOG_FIELD_ORDER = ['id', 'title', 'description', 'tags'] as const;
type CatalogMatchField = (typeof CATALOG_FIELD_ORDER)[number];

/** Pure deterministic ranker for non-capability runtime catalog entries. */
export function rankCatalogEntry(
  entry: RuntimeCatalogEntry,
  query: string,
): RuntimeCatalogSearchMatch | undefined {
  const normalizedQuery = normalize(query);
  const terms = queryTerms(query);
  const id = normalize(entry.id);
  const title = normalize(entry.title);
  const description = normalize(entry.description);
  const tags = (entry.tags ?? []).map(normalize);
  const matchedTerms = new Set<string>();
  const matchedFields = new Set<CatalogMatchField>();
  let score = 0;

  if (!normalizedQuery) {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      entry,
      score: 0,
      matchedTerms: [],
      matchedFields: [],
    };
  }

  if (id === normalizedQuery) {
    score += 1_000;
    matchedFields.add('id');
  } else if (id.startsWith(normalizedQuery)) {
    score += 450;
    matchedFields.add('id');
  } else if (id.includes(normalizedQuery)) {
    score += 300;
    matchedFields.add('id');
  }
  if (title === normalizedQuery) {
    score += 800;
    matchedFields.add('title');
  } else if (title.includes(normalizedQuery)) {
    score += 220;
    matchedFields.add('title');
  }
  if (tags.includes(normalizedQuery)) {
    score += 180;
    matchedFields.add('tags');
  }
  if (description.includes(normalizedQuery)) {
    score += 100;
    matchedFields.add('description');
  }

  for (const term of terms) {
    let termMatched = false;
    if (id === term) {
      score += 90;
      matchedFields.add('id');
      termMatched = true;
    } else if (id.startsWith(term)) {
      score += 60;
      matchedFields.add('id');
      termMatched = true;
    } else if (id.includes(term)) {
      score += 40;
      matchedFields.add('id');
      termMatched = true;
    }
    if (title.includes(term)) {
      score += 28;
      matchedFields.add('title');
      termMatched = true;
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 24;
      matchedFields.add('tags');
      termMatched = true;
    }
    if (description.includes(term)) {
      score += 10;
      matchedFields.add('description');
      termMatched = true;
    }
    if (termMatched) matchedTerms.add(term);
  }

  if (score === 0) return undefined;
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    entry,
    score,
    matchedTerms: [...matchedTerms],
    matchedFields: CATALOG_FIELD_ORDER.filter((field) => matchedFields.has(field)),
  };
}
