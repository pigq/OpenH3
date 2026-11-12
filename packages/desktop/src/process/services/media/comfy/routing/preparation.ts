import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { comfyProfileSchema, type ComfyProfile } from '@/common/chat/document/creation/comfy';
import type { ComfyWorkflow } from '@/common/chat/document/creation/workflows/contracts';
import { comfyComponentIdentityRole } from '@/common/chat/document/creation/workflows/identity';
import { sameLocalComfyModel } from './modelFiles';
import {
  loadComfyInstallCatalog,
  record,
  records,
  stringValue,
  type CatalogRecord,
  type ComfyInstallCatalog,
} from '../planning/catalog';
import { parseComfyWorkflowCatalog } from './catalog';

type Component = ComfyProfile['components'][number];
export type ComfyPendingWorkflow = {
  candidateId: string;
  workflowId: string;
  metadata: ComfyWorkflow;
  reason: string;
  missingComponents: CatalogRecord[];
  missingNodes: CatalogRecord[];
  additionalBytes: number;
};
export type ComfyPreparedWorkflows = {
  profiles: ComfyProfile[];
  /** Existing exact graph routes enriched in place; semantic metadata changes require fingerprint migration. */
  reusedProfiles?: ComfyProfile[];
  pending: ComfyPendingWorkflow[];
  matchedCandidateIds: string[];
  unmatchedReason?: string;
};

const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const sameComponent = (local: Component, source: CatalogRecord): boolean =>
  comfyComponentIdentityRole(local.role) === comfyComponentIdentityRole(stringValue(source.role)) &&
  Boolean(local.sha256) &&
  local.sha256!.toLowerCase() === stringValue(source.sha256).toLowerCase();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Input values may differ between calls; graph wiring and every unbound parameter must match. */
function recipeGraph(graph: CatalogRecord, bindings: CatalogRecord): string | undefined {
  const value = Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [
      id,
      { class_type: record(node).class_type, inputs: structuredClone(record(record(node).inputs)) },
    ])
  );
  for (const [parameter, targets] of Object.entries(bindings)) {
    for (const [index, target] of records(targets).entries()) {
      const inputs = value[stringValue(target.nodeId)]?.inputs;
      const key = stringValue(target.input);
      if (!inputs || !Object.hasOwn(inputs, key)) return undefined;
      inputs[key] = { parameter, index };
    }
  }
  return canonical(value);
}

function matchesCandidate(profile: ComfyProfile, candidate: CatalogRecord): boolean {
  if (candidate.family !== profile.family) return false;
  const components = records(candidate.components);
  const base = components.filter((component) => component.identityRole !== 'workflow');
  if (!base.length || !base.every((component) => profile.components.some((local) => sameComponent(local, component))))
    return false;
  // Only explicitly classified route weights may be omitted; never discard an unknown legacy base component.
  return profile.components
    .filter((local) => local.identityRole !== 'workflow')
    .every((local) => components.some((component) => sameComponent(local, component)));
}

function nodeAvailable(profile: ComfyProfile, node: CatalogRecord, candidate: CatalogRecord): boolean {
  const id = stringValue(node.id).toLowerCase();
  const nodeSource = records(candidate.nodes).find((source) => source.id === node.id);
  const repository = stringValue(nodeSource?.repository).split('/').at(-1)?.toLowerCase();
  return profile.nodes.some((installed) => {
    const name = installed.id.toLowerCase();
    if (id === 'comfyui-core') return name === 'comfyui-core' || name === 'comfyui';
    return name === id || Boolean(repository && (name === repository || name.startsWith(`${repository}-`)));
  });
}

function modelsRoot(profile: ComfyProfile): string {
  const args = profile.environment.launchArgs ?? [];
  const index = args.indexOf('--models-directory');
  return (
    args.find((arg) => arg.startsWith('--models-directory='))?.slice('--models-directory='.length) ??
    (index >= 0 ? args[index + 1] : undefined) ??
    path.join(profile.environment.root, 'models')
  );
}

/** Materialize vetted recipes using the selected profile's exact weight files and existing runtime. No downloads or GPU work. */
export function prepareComfyWorkflowVariants(
  profile: ComfyProfile,
  outputRoot: string,
  catalog: ComfyInstallCatalog = loadComfyInstallCatalog(),
  existingProfiles: readonly ComfyProfile[] = [profile]
): ComfyPreparedWorkflows {
  const candidates = catalog.candidates.filter((candidate) => matchesCandidate(profile, candidate));
  const result: ComfyPreparedWorkflows = {
    profiles: [],
    reusedProfiles: [],
    pending: [],
    matchedCandidateIds: candidates.map((candidate) => stringValue(candidate.id)),
    ...(!candidates.length ? { unmatchedReason: 'COMFY_CATALOG_MODEL_IDENTITY_UNMATCHED' } : {}),
  };
  const routes = parseComfyWorkflowCatalog(catalog);
  const existing = existingProfiles
    .filter(
      (entry) =>
        canonical(entry.environment) === canonical(profile.environment) &&
        sameLocalComfyModel(entry, profile) &&
        fs.existsSync(entry.workflowPath)
    )
    .map((entry) => {
      const bytes = fs.readFileSync(entry.workflowPath);
      return { profile: entry, hash: digest(bytes), graph: record(JSON.parse(bytes.toString('utf8'))) };
    });
  if (candidates.length && !routes.some((route) => candidates.some((candidate) => candidate.id === route.candidateId)))
    result.unmatchedReason = 'COMFY_CATALOG_EXECUTABLE_WORKFLOW_MISSING';
  for (const candidate of candidates) {
    for (const route of routes.filter((entry) => entry.candidateId === candidate.id)) {
      const components = [...records(candidate.components), ...route.preparation.additionalComponents];
      const missingComponents = components.filter(
        (component) =>
          !profile.components.some(
            (local) => sameComponent(local, component) && fs.existsSync(local.path) && fs.statSync(local.path).isFile()
          )
      );
      const missingNodes = records(route.workflow.requiredNodes).filter(
        (node) => !nodeAvailable(profile, node, candidate)
      );
      const pending = (reason: string): void => {
        result.pending.push({
          candidateId: route.candidateId,
          workflowId: route.metadata.id,
          metadata: { ...route.metadata, preparation: 'pending' },
          reason,
          missingComponents,
          missingNodes,
          additionalBytes: missingComponents.reduce((total, component) => total + Number(component.sizeBytes), 0),
        });
      };
      if (missingComponents.length || missingNodes.length || route.metadata.adapter === 'external') {
        pending(
          missingComponents.length
            ? 'COMFY_WORKFLOW_COMPONENTS_REQUIRED'
            : missingNodes.length
              ? 'COMFY_WORKFLOW_NODES_REQUIRED'
              : 'COMFY_WORKFLOW_EXTERNAL_ADAPTER_REQUIRED'
        );
        continue;
      }
      const graph = structuredClone(record(route.workflow.graph));
      let unsupportedPath = false;
      for (const node of Object.values(graph)) {
        const current = record(node);
        const inputs = record(current.inputs);
        const keys =
          current.class_type === 'ModelPatchLoader' ? ['name'] : ['unet_name', 'clip_name', 'vae_name', 'lora_name'];
        for (const key of keys) {
          if (typeof inputs[key] !== 'string') continue;
          const source = components.find(
            (component) => (component.name || path.basename(stringValue(component.path))) === inputs[key]
          );
          if (!source) throw new Error(`COMFY_CATALOG_COMPONENT_MISSING:${route.metadata.id}:${inputs[key]}`);
          const local = profile.components.find((component) => sameComponent(component, source))!;
          const directory = stringValue(source.directory) || path.basename(path.dirname(stringValue(source.path)));
          const directories =
            directory === 'diffusion_models'
              ? [directory, 'unet']
              : directory === 'text_encoders'
                ? [directory, 'clip']
                : [directory];
          const relative = directories
            .map((folder) => path.relative(path.join(modelsRoot(profile), folder), local.path))
            .find((name) => name && name !== '..' && !name.startsWith(`..${path.sep}`) && !path.isAbsolute(name));
          if (!relative) {
            unsupportedPath = true;
            break;
          }
          inputs[key] = relative.replaceAll('\\', '/');
        }
      }
      if (unsupportedPath) {
        pending('COMFY_WORKFLOW_MODEL_PATH_ADAPTATION_REQUIRED');
        continue;
      }
      const source = `${JSON.stringify(graph, null, 2)}\n`;
      const workflowSha256 = digest(source);
      const bindings = record(route.workflow.bindings);
      const reused = existing.find(
        (entry) =>
          route.metadata.inputs.every(
            (input) =>
              !input.binding ||
              canonical(entry.profile.bindings[input.binding]?.[input.bindingIndex ?? 0]) ===
                canonical(records(bindings[input.binding])[input.bindingIndex ?? 0])
          ) && recipeGraph(entry.graph, bindings) === recipeGraph(graph, bindings)
      );
      if (reused) {
        const existingHash = reused.hash;
        const existingProfile = reused.profile;
        if (existingProfile.workflowSha256 && existingProfile.workflowSha256.toLowerCase() !== existingHash) {
          pending('COMFY_WORKFLOW_PREPARED_FILE_CHANGED');
          continue;
        }
        const recipeEvidence =
          route.metadata.evidence
            ?.filter((entry) => entry.kind === 'recipe')
            .map((entry) => Object.assign({}, entry, { workflowHash: existingHash! })) ?? [];
        const identity = {
          id: route.metadata.id,
          revision: existingHash!,
          tasks: route.metadata.tasks,
          inputs: route.metadata.inputs,
          adapter: route.metadata.adapter,
        };
        const current = existingProfile.workflowMetadata;
        const metadataUnchanged =
          current &&
          canonical(identity) ===
            canonical({
              id: current.id,
              revision: current.revision,
              tasks: current.tasks,
              inputs: current.inputs,
              adapter: current.adapter,
            });
        const existingExecution = metadataUnchanged
          ? (current.evidence?.filter((entry) => entry.kind === 'execution' && entry.workflowHash === existingHash) ??
            [])
          : [];
        result.reusedProfiles!.push(
          comfyProfileSchema.parse({
            ...existingProfile,
            state: metadataUnchanged ? existingProfile.state : 'downloaded',
            validation: metadataUnchanged ? existingProfile.validation : undefined,
            workflowSha256: existingHash,
            workflowMetadata: {
              ...route.metadata,
              revision: existingHash!,
              preparation: 'ready',
              evidence: [...recipeEvidence, ...existingExecution],
            },
          })
        );
        continue;
      }
      const id = `catalog-${digest(JSON.stringify([profile.environment, route.metadata.id, workflowSha256])).slice(0, 32)}`;
      const workflowPath = path.join(path.resolve(outputRoot), `${id}.json`);
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
      if (fs.existsSync(workflowPath)) {
        if (digest(fs.readFileSync(workflowPath)) !== workflowSha256) {
          pending('COMFY_WORKFLOW_PREPARED_FILE_CHANGED');
          continue;
        }
      } else fs.writeFileSync(workflowPath, source, { flag: 'wx' });
      result.profiles.push(
        comfyProfileSchema.parse({
          ...profile,
          components: profile.components.filter(
            (component) =>
              component.identityRole !== 'workflow' || components.some((required) => sameComponent(component, required))
          ),
          id,
          name: `${profile.family} · ${route.metadata.tasks.join(' / ')}`,
          state: 'downloaded',
          workflowPath,
          workflowSha256,
          workflowMetadata: {
            ...route.metadata,
            revision: workflowSha256,
            preparation: 'ready',
            evidence: route.metadata.evidence
              ?.filter((entry) => entry.kind === 'recipe')
              .map((entry) => Object.assign({}, entry, { workflowHash: workflowSha256 })),
          },
          bindings: route.workflow.bindings,
          defaults: route.workflow.defaults,
          capabilities: route.workflow.capabilities,
          validation: undefined,
          memoryPolicy: undefined,
        })
      );
    }
  }
  return result;
}
