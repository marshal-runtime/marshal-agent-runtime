import type {
  KnowledgeChangeResult,
  KnowledgeContextResult,
  KnowledgeImpactResult,
  KnowledgeIndexMutationResult,
  KnowledgeIndexStatus,
  KnowledgeSearchResult,
  RebuildableKnowledgeIndex,
} from './knowledge.js';

export const BRAIN_NOT_CONFIGURED = 'brain_not_configured';
export const BRAIN_NOT_CONFIGURED_MESSAGE =
  'Brain not configured: knowledge tools read the company Brain, and this workspace has no Brain route. Connect the workspace to a Brain to use them.';

function notConfigured(): Error {
  return Object.assign(new Error(BRAIN_NOT_CONFIGURED_MESSAGE), { code: BRAIN_NOT_CONFIGURED });
}

/** The knowledge index of a workspace with no Brain route: every read and write says so, and nothing is stored locally. */
export class BrainNotConfiguredIndex implements RebuildableKnowledgeIndex {
  search(): Promise<KnowledgeSearchResult> { return Promise.reject(notConfigured()); }
  context(): Promise<KnowledgeContextResult> { return Promise.reject(notConfigured()); }
  impact(): Promise<KnowledgeImpactResult> { return Promise.reject(notConfigured()); }
  detectChanges(): Promise<KnowledgeChangeResult> { return Promise.reject(notConfigured()); }
  upsertDocument(): Promise<KnowledgeIndexMutationResult> { return Promise.reject(notConfigured()); }
  removeDocument(): Promise<KnowledgeIndexMutationResult> { return Promise.reject(notConfigured()); }
  rebuild(): Promise<KnowledgeIndexStatus> { return Promise.reject(notConfigured()); }
  status(): Promise<KnowledgeIndexStatus> {
    return Promise.resolve({
      state: 'unavailable',
      engine: 'none',
      generation: 0,
      nodeCount: 0,
      reason: BRAIN_NOT_CONFIGURED_MESSAGE,
    });
  }
}
