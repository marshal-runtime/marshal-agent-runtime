import type {
  RuntimeCatalogEntry,
  RuntimeCatalogProvider,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeHostProviderSource,
  RuntimePackageDeclaration,
  RuntimeResourceDescriptor,
  RuntimeScopedResourcePort,
  RuntimeSkillAsset,
  RuntimeSkillReferenceAsset,
} from './types.js';

interface DeclaredSkill {
  readonly declaration: RuntimePackageDeclaration;
  readonly skill: RuntimeSkillAsset;
}

const MAX_DECLARATIONS = 256;
const MAX_SKILLS = 2_048;
const MAX_REFERENCES = 8_192;

/** Turns static package skills into runtime_search entries and portable resources. */
export function createPackageDiscoverySource(
  declarations: readonly RuntimePackageDeclaration[],
): RuntimeHostProviderSource {
  if (!Array.isArray(declarations) || declarations.length > MAX_DECLARATIONS) {
    throw new Error('Runtime package declarations exceed the configured bound.');
  }
  const snapshots = declarations.map((declaration) => {
    const skills = declaration.skills?.map((skill: RuntimeSkillAsset) => Object.freeze({
      ...skill,
      tags: skill.tags ? Object.freeze([...skill.tags]) : undefined,
      references: skill.references
        ? Object.freeze(skill.references.map((reference: RuntimeSkillReferenceAsset) => Object.freeze({ ...reference }))) : undefined,
    }));
    return Object.freeze({
      ...declaration,
      skills: skills ? Object.freeze(skills) : undefined,
    });
  });
  const skills = snapshots.flatMap((declaration) =>
    (declaration.skills ?? []).map((skill: RuntimeSkillAsset) => ({ declaration, skill })));
  if (skills.length > MAX_SKILLS
    || skills.reduce((count, item) => count + (item.skill.references?.length ?? 0), 0) > MAX_REFERENCES) {
    throw new Error('Runtime package skills exceed the configured bound.');
  }
  const frozenSkills = Object.freeze(skills.map(({ declaration, skill }) => ({
    declaration: Object.freeze(declaration),
    skill: Object.freeze(skill),
  })));
  const catalog: RuntimeCatalogProvider = {
    id: 'marshal.package-discovery',
    list: () => Object.freeze(frozenSkills.map(({ declaration, skill }) =>
      skillCatalogEntry(declaration.packageId, skill)).sort((a, b) => ordinal(a.id, b.id))),
    get: (id) => {
      const found = frozenSkills.find(({ skill }) => skillUri(skill) === id);
      return found ? skillCatalogEntry(found.declaration.packageId, found.skill) : undefined;
    },
  };
  const resources: RuntimeScopedResourcePort = {
    listResources: async () => skillResources(frozenSkills),
    readResource: async (uri) => {
      for (const { skill } of frozenSkills) {
        if (skillUri(skill) === uri) {
          return { uri, mimeType: 'text/markdown', text: skill.content };
        }
        for (const reference of skill.references ?? []) {
          if (skillReferenceUri(skill, reference.path) === uri) {
            return { uri, mimeType: 'text/markdown', text: reference.content };
          }
        }
      }
      throw new Error(`Runtime skill resource not found: ${uri}`);
    },
  };
  return () => ({ providers: [], catalog, resources });
}

function skillCatalogEntry(
  packageId: string,
  skill: RuntimeSkillAsset,
): RuntimeCatalogEntry {
  return {
    id: skillUri(skill),
    kind: 'skill',
    title: skill.title,
    description: skill.description,
    tags: [...(skill.tags ?? []), 'skill'],
    action: { type: 'resource_read', uri: skillUri(skill) },
    metadata: { packageId, skillId: skill.id },
  };
}

function skillResources(skills: readonly DeclaredSkill[]): readonly RuntimeResourceDescriptor[] {
  return Object.freeze(skills.flatMap(({ declaration, skill }) => [
    {
      uri: skillUri(skill),
      name: skill.title,
      description: skill.description,
      mimeType: 'text/markdown',
      catalog: skillResourceCatalog(declaration.packageId, skill),
    },
    ...(skill.references ?? []).map((reference) => ({
      uri: skillReferenceUri(skill, reference.path),
      name: `${skill.title}: ${reference.path}`,
      mimeType: 'text/markdown',
      catalog: skillResourceCatalog(declaration.packageId, skill, reference.path),
    })),
  ]).sort((a, b) => ordinal(a.uri, b.uri)));
}

function ordinal(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference) return difference;
  }
  return left.length - right.length;
}

function skillResourceCatalog(
  packageId: string,
  skill: RuntimeSkillAsset,
  referencePath?: string,
): NonNullable<RuntimeResourceDescriptor['catalog']> {
  return {
    owner: { type: 'package', id: packageId },
    metadata: {
      packageId,
      skillId: skill.id,
      ...(referencePath ? { referencePath } : {}),
    },
  };
}

function skillUri(skill: RuntimeSkillAsset): string {
  return `skill://${skill.id}`;
}

function skillReferenceUri(skill: RuntimeSkillAsset, path: string): string {
  return `${skillUri(skill)}/references/${encodeURIComponent(path.replaceAll('\\', '/'))}`;
}
