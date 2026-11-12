import path from 'node:path';
import type { ComfyInventory } from '@/common/chat/document/creation/comfy';
import type { LocalModelCenterSnapshot } from '@/common/chat/document/creation/workflows/localModels';
import { probeLocalDevice } from '../../discovery/environment';
import { loadComfyInstallCatalog } from '../catalog';
import { evaluateLocalModelCenter, type ModelCenterActivity } from './evaluator';

export type LocalModelCenterServiceOptions = {
  dataDir: string;
  inventory: () => ComfyInventory;
  catalogRoot?: string;
  probe?: typeof probeLocalDevice;
  activities?: ModelCenterActivity[];
  registeredProfileIds?: string[];
};

/** Assemble a center snapshot without launching ComfyUI or inspecting Python/Torch. */
export async function readLocalModelCenter(
  options: LocalModelCenterServiceOptions,
  directory?: string
): Promise<LocalModelCenterSnapshot> {
  if (directory !== undefined && (!directory.trim() || !path.isAbsolute(directory)))
    throw new Error('COMFY_INSTALL_DIRECTORY_ABSOLUTE_REQUIRED');
  const installDirectory = directory ? path.resolve(directory) : path.resolve(options.dataDir);
  const device = await (options.probe ?? probeLocalDevice)(installDirectory);
  const inventory = options.inventory();
  let catalog: ReturnType<typeof loadComfyInstallCatalog>;
  try {
    catalog = loadComfyInstallCatalog(options.catalogRoot);
  } catch {
    // A broken packaged catalog cannot hide registered custom models or their existing workflows.
    inventory.complete = false;
    inventory.diagnostics.push({ code: 'COMFY_MODEL_CATALOG_UNAVAILABLE' });
    catalog = { root: '', candidates: [], baselines: [] };
  }
  return evaluateLocalModelCenter({
    device,
    inventory,
    catalog,
    activities: options.activities,
    registeredProfileIds: options.registeredProfileIds,
  });
}
