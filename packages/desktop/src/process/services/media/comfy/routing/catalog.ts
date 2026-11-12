import { createHash } from 'node:crypto';
import path from 'node:path';
import { comfyWorkflowSchema, type ComfyWorkflow } from '@/common/chat/document/creation/workflows/contracts';
import {
  loadComfyInstallCatalog,
  record,
  records,
  stringValue,
  type CatalogRecord,
  type ComfyInstallCatalog,
} from '../planning/catalog';

export type ComfyCatalogWorkflow = {
  candidateId: string;
  family: string;
  workflow: CatalogRecord;
  metadata: ComfyWorkflow;
  preparation: {
    policy: 'with-base' | 'on-demand';
    sharedComponents: Array<{ role: string; name: string; sha256: string; sizeBytes: number }>;
    additionalComponents: CatalogRecord[];
    additionalBytes: number;
  };
};

/** Read exact candidate recipes; this catalog never confers local runtime verification. */
export function readComfyWorkflowCatalog(resourcesRoot?: string): ComfyCatalogWorkflow[] {
  return parseComfyWorkflowCatalog(loadComfyInstallCatalog(resourcesRoot));
}

export function parseComfyWorkflowCatalog(catalog: ComfyInstallCatalog): ComfyCatalogWorkflow[] {
  return catalog.baselines.map((workflow) => {
    const candidate = catalog.candidates.find((entry) => entry.id === workflow.candidateId);
    if (!candidate || candidate.family !== workflow.family) throw new Error('COMFY_CATALOG_MODEL_MISMATCH');
    const metadata = comfyWorkflowSchema.parse(workflow.workflowMetadata);
    const graph = record(workflow.graph);
    const hash = createHash('sha256')
      .update(`${JSON.stringify(graph, null, 2)}\n`)
      .digest('hex');
    if (
      metadata.id !== workflow.id ||
      workflow.graphSha256 !== hash ||
      metadata.revision !== hash ||
      !metadata.source ||
      metadata.evidence?.some((evidence) => evidence.workflowHash !== hash)
    )
      throw new Error(`COMFY_CATALOG_GRAPH_MISMATCH:${workflow.id}`);
    const bindings = record(workflow.bindings);
    for (const destinations of Object.values(bindings)) {
      for (const destination of records(destinations)) {
        const inputs = record(record(graph[stringValue(destination.nodeId)]).inputs);
        if (!Object.hasOwn(inputs, stringValue(destination.input)))
          throw new Error(`COMFY_CATALOG_BINDING_MISSING:${workflow.id}`);
      }
    }
    for (const input of metadata.inputs) {
      if (input.binding && !records(bindings[input.binding])[input.bindingIndex ?? 0])
        throw new Error(`COMFY_CATALOG_INPUT_BINDING_MISSING:${workflow.id}`);
    }
    const preparation = record(workflow.preparation);
    const components = records(candidate.components);
    const additionalComponents = records(preparation.additionalComponents);
    const allComponents = [...components, ...additionalComponents];
    const loaderKeys = ['unet_name', 'clip_name', 'vae_name', 'lora_name'];
    for (const node of Object.values(graph)) {
      const keys = record(node).class_type === 'ModelPatchLoader' ? ['name'] : loaderKeys;
      for (const key of keys) {
        const name = record(record(node).inputs)[key];
        if (
          typeof name === 'string' &&
          !allComponents.some((component) => (component.name || path.basename(stringValue(component.path))) === name)
        )
          throw new Error(`COMFY_CATALOG_COMPONENT_MISSING:${workflow.id}:${name}`);
      }
    }
    for (const component of records(workflow.components)) {
      if (!allComponents.some((known) => known.role === component.role && known.sha256 === component.sha256))
        throw new Error(`COMFY_CATALOG_COMPONENT_IDENTITY:${workflow.id}`);
    }
    return {
      candidateId: stringValue(candidate.id),
      family: stringValue(candidate.family),
      workflow,
      metadata,
      preparation: {
        policy: preparation.policy === 'on-demand' ? 'on-demand' : 'with-base',
        sharedComponents: components.map((component) => ({
          role: stringValue(component.role),
          name: stringValue(component.name) || path.basename(stringValue(component.path)),
          sha256: stringValue(component.sha256),
          sizeBytes: Number(component.sizeBytes),
        })),
        additionalComponents,
        additionalBytes: additionalComponents.reduce((total, component) => total + Number(component.sizeBytes), 0),
      },
    };
  });
}
