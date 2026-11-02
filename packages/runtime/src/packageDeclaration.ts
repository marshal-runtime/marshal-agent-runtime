import {
  projectReactAuthoringReferenceMarkdown,
  projectSkillMarkdown,
} from '@marshal/agent-runtime-manifest';
import type { RuntimePackageDeclaration } from '@marshal/agent-runtime-host';

export const RUNTIME_PACKAGE_DECLARATION: RuntimePackageDeclaration = {
  packageId: '@marshal/runtime',
  packageVersion: '0.1.0',
  capabilityPrefixes: ['artifacts.', 'runtime.', 'ui.'],
  skills: [{
    id: 'marshal.runtime/use-marshal-runtime',
    title: 'Use Marshal Runtime',
    description:
      'Use runtime capabilities, editable TypeScript, delegation, artifacts, and portable custom UI.',
    tags: ['runtime', 'typescript', 'ui', 'delegation', 'artifacts'],
    content: projectSkillMarkdown({
      discovery: 'runtime_search',
      execution: 'runtime_exec',
      renderComponent: 'runtime_render_component',
      extensionManager: 'runtime_extensions_manage',
    }),
    references: [{
      path: 'react-authoring.md',
      content: projectReactAuthoringReferenceMarkdown(),
    }],
  }],
  lifecyclePhases: [
    'session.start',
    'prompt.submit',
    'tool.invoke',
    'tool.result',
    'assistant.complete',
    'session.end',
    'subagent.start',
    'subagent.end',
  ],
};
