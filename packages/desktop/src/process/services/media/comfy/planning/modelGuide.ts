import fs from 'node:fs';
import path from 'node:path';
import { comfyFamilySchema, type BuiltinComfyFamily, type ComfyFamily } from '@/common/chat/document/creation/comfy';
import { loadComfyInstallCatalog, records, stringValue, workflowsForCandidate } from './catalog';

const familyReferences: Record<BuiltinComfyFamily, string> = {
  h3: 'h3.md',
  'qwen-edit': 'qwen-edit.md',
  'z-image': 'z-image.md',
  'fasth3-omni': 'fasth3-omni.md',
  'flux-3-image-klein': 'z-image.md',
  'moss-image-base': 'z-image.md',
  'moss-image-sft': 'z-image.md',
  krea2: 'z-image.md',
};

/** Read curated knowledge. This neither selects a recipe nor probes or changes the user's environment. */
export function readComfyModelGuide(family: ComfyFamily, candidateId?: string, resourcesRoot?: string) {
  const catalog = loadComfyInstallCatalog(resourcesRoot);
  const directory = path.join(catalog.root, 'skills', 'comfyui-local');
  const candidates = catalog.candidates.filter((item) => item.family === family);
  const chosen = candidateId ? candidates.find((item) => item.id === candidateId) : undefined;
  if (candidateId && !chosen) throw new Error('COMFY_GUIDE_CANDIDATE_NOT_FOUND');
  const workflows = chosen ? workflowsForCandidate(catalog, chosen) : [];
  const workflow = workflows[0];
  const builtin = comfyFamilySchema.safeParse(family);
  if (chosen && !workflow) throw new Error('COMFY_GUIDE_WORKFLOW_NOT_FOUND');
  const references = [
    'SKILL.md',
    ...(builtin.success ? [`references/${familyReferences[builtin.data]}`] : ['references/install-evidence.md']),
    'references/environment-and-repair.md',
    'references/source-catalog.md',
    'references/workflow-routing.md',
  ]
    .map((file) => path.join(directory, file))
    .filter((file) => fs.existsSync(file));
  return {
    family,
    catalogued: candidates.length > 0,
    execution: 'agent' as const,
    purpose:
      'Use these recommended components and workflows to avoid known installation mistakes. Inspect the actual device and existing environment before choosing a route. A catalog core pin describes the reference recipe dependency, not a requirement to reinstall a compatible existing ComfyUI.',
    references,
    capabilityInventory: catalog.capabilityInventory?.filter((entry) => entry.family === family),
    preparationPolicy: catalog.preparationPolicy,
    validationReference: fs.existsSync(path.join(directory, 'smoke-reference.png'))
      ? path.join(directory, 'smoke-reference.png')
      : undefined,
    candidates: candidates.map((candidate) => ({
      id: stringValue(candidate.id),
      quantization: stringValue(candidate.quantization),
      hardware: candidate.hardware,
      runtimePins: candidate.runtimePins,
      workflowAvailable: workflowsForCandidate(catalog, candidate).length > 0,
      workflows: workflowsForCandidate(catalog, candidate).map((variant) => ({
        id: variant.id,
        workflowMetadata: variant.workflowMetadata,
        preparation: variant.preparation,
        apiConversionRequired: variant.apiConversionRequired === true,
      })),
      components: records(candidate.components).map((component) => ({
        name: stringValue(component.name) || path.basename(stringValue(component.path)),
        role: component.role,
        precision: component.precision,
        sizeBytes: component.sizeBytes,
      })),
    })),
    ...(chosen && workflow
      ? {
          recipe: {
            candidate: { ...chosen, components: records(chosen.components) },
            workflow,
            workflows,
            verifiedOnThisMachine: false as const,
          },
        }
      : {}),
    bootstrap: {
      pythonCandidates: [
        path.join(catalog.root, 'bundled-python', 'python.exe'),
        path.join(catalog.root, 'bundled-python', `win32-${process.arch}`, 'python', 'python.exe'),
      ].filter((file) => fs.existsSync(file)),
      gitCandidates: [
        path.join(catalog.root, 'bundled-git', 'cmd', 'git.exe'),
        path.join(catalog.root, 'bundled-git', `win32-${process.arch}`, 'cmd', 'git.exe'),
      ].filter((file) => fs.existsSync(file)),
      note: 'Private bootstrap tools are available for scoped commands without installing system Python/Git or changing the global PATH. Verify the selected interpreter and its venv/pip support.',
    },
  };
}
