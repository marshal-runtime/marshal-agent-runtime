import { describe, expect, it } from 'vitest';
import {
  rankCapability,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCapabilityDescriptor,
} from '../src/index.js';

function capability(
  name: string,
  overrides: Partial<RuntimeCapabilityDescriptor> = {},
): RuntimeCapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    description: 'Search durable project knowledge.',
    provider: { id: 'test' },
    ...overrides,
  };
}

describe('rankCapability', () => {
  it('weights exact names above description-only matches', () => {
    const exact = rankCapability(capability('memory.search'), 'memory.search');
    const descriptive = rankCapability(
      capability('knowledge.find', { description: 'Use memory.search semantics.' }),
      'memory.search',
    );
    expect(exact).toBeDefined();
    expect(descriptive).toBeDefined();
    expect(exact!.score).toBeGreaterThan(descriptive!.score);
    expect(exact!.matchedFields).toContain('name');
  });

  it('matches Unicode terms, titles, tags, and descriptions', () => {
    const match = rankCapability(
      capability('knowledge.find', {
        title: 'זיכרון project',
        tags: ['brain'],
        description: 'Find durable context.',
      }),
      'זיכרון brain durable',
    );
    expect(match?.matchedTerms).toEqual(['זיכרון', 'brain', 'durable']);
    expect(match?.matchedFields).toEqual(['title', 'description', 'tags']);
  });

  it('returns all capabilities for an empty query and omits unrelated results', () => {
    expect(rankCapability(capability('memory.search'), '')?.score).toBe(0);
    expect(rankCapability(capability('memory.search'), 'weather')).toBeUndefined();
  });
});
