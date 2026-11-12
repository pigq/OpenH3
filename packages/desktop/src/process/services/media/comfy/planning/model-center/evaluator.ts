import fs from 'node:fs';
import crypto from 'node:crypto';
import type { ComfyInventory, ComfyProfile } from '@/common/chat/document/creation/comfy';
import {
  comfyWorkflowStatus,
  getComfyModelSetId,
  groupComfyModels,
} from '@/common/chat/document/creation/workflows/identity';
import type {
  LocalDeviceSnapshot,
  LocalModelCenterSnapshot,
  LocalModelPurpose,
  LocalModelRecommendation,
  LocalModelReason,
} from '@/common/chat/document/creation/workflows/localModels';
import {
  record,
  records,
  stringValue,
  workflowsForCandidate,
  type ComfyInstallCatalog,
  type CatalogRecord,
} from '../catalog';
import { comfyMemoryBudget } from '../hardwareSelection';

export type ModelCenterActivity = {
  family: string;
  candidateId?: string;
  profileId?: string;
  conversationId: string;
  state: string;
  updatedAt: string;
};
export const activeModelCenterActivity = (state: string): boolean =>
  ['awaiting-consent', 'authorized', 'running', 'paused', 'detecting'].includes(state);
export type ModelCenterOptions = {
  inventory: ComfyInventory;
  device: LocalDeviceSnapshot;
  catalog: ComfyInstallCatalog;
  activities?: ModelCenterActivity[];
  registeredProfileIds?: string[];
};
type Component = ComfyProfile['components'][number];
const size = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

function fileMatches(component: Component): boolean {
  try {
    const stat = fs.statSync(component.path);
    return stat.isFile() && component.sizeBytes !== undefined && stat.size === component.sizeBytes;
  } catch {
    return false;
  }
}

function candidateComponents(candidate: CatalogRecord): Component[] {
  return records(candidate.components).map((item) => ({
    name: stringValue(item.name),
    path: '',
    role: stringValue(item.role),
    identityRole: item.identityRole === 'workflow' ? 'workflow' : item.identityRole === 'base' ? 'base' : undefined,
    version: stringValue(item.revision),
    precision: stringValue(item.precision),
    url: stringValue(item.url) || undefined,
    sha256: stringValue(item.sha256) || undefined,
    sizeBytes: size(item.sizeBytes),
  }));
}

/** Use the existing library identity; family and filenames alone cannot prove equivalence. */
function candidateMatches(candidate: CatalogRecord, profile: ComfyProfile): boolean {
  if (candidate.family !== profile.family) return false;
  return (
    getComfyModelSetId(profile) ===
    getComfyModelSetId({
      id: `candidate:${stringValue(candidate.id)}`,
      family: profile.family,
      kind: profile.kind,
      quantization: stringValue(candidate.quantization, profile.quantization),
      components: candidateComponents(candidate),
    })
  );
}

function purposes(kind: 'image' | 'video', tasks: string[]): LocalModelPurpose[] {
  if (kind === 'video') return ['video'];
  const result: LocalModelPurpose[] = [];
  if (tasks.some((task) => /text-to-image|text-to-photo/.test(task))) result.push('image-generation');
  if (tasks.some((task) => /edit|inpaint|outpaint|image-to-image/.test(task))) result.push('image-edit');
  return result.length ? result : ['image-generation'];
}

function hasWorkflow(profile: ComfyProfile): boolean {
  try {
    return (
      fs.statSync(profile.workflowPath).isFile() &&
      (!profile.workflowSha256 ||
        crypto.createHash('sha256').update(fs.readFileSync(profile.workflowPath)).digest('hex') ===
          profile.workflowSha256.toLowerCase())
    );
  } catch {
    return false;
  }
}

function hardwareUnchanged(profile: ComfyProfile, device: LocalDeviceSnapshot): boolean {
  const previous = profile.validation?.runtime?.hardware;
  if (!previous || previous.os !== device.os || previous.arch !== device.arch || device.gpuStatus !== 'available')
    return false;
  if ((previous.osRelease && previous.osRelease !== device.osRelease) || (previous.cpu && previous.cpu !== device.cpu))
    return false;
  const gpus = records(previous.gpus);
  return (
    gpus.length > 0 &&
    gpus.every((prior) =>
      device.gpus.some(
        (current) =>
          current.vendor !== 'unknown' &&
          (current.vendor === 'apple' || current.sharedMemory || (current.totalMemoryBytes ?? 0) > 0) &&
          (current.vendor !== 'nvidia' || Boolean(current.driver && current.computeCapability)) &&
          ['name', 'vendor', 'totalMemoryBytes', 'driver', 'computeCapability'].every(
            (key) => prior[key] === undefined || prior[key] === current[key as keyof typeof current]
          )
      )
    )
  );
}

function hasModelFiles(profile: ComfyProfile): boolean {
  return profile.components.every((component) => {
    try {
      const stat = fs.statSync(component.path);
      return stat.isFile() && (component.sizeBytes === undefined || stat.size === component.sizeBytes);
    } catch {
      return false;
    }
  });
}

function bytesFor(
  components: Component[],
  existing: Component[]
): {
  totalBytes?: number;
  downloadBytes?: number;
  reusedBytes: number;
} {
  const sizes = components.map((component) => size(component.sizeBytes));
  const totalBytes =
    sizes.length && sizes.every((bytes) => bytes !== undefined)
      ? sizes.reduce<number>((sum, bytes) => sum + bytes!, 0)
      : undefined;
  // Registered digest + expected bytes + current file size is lightweight reuse evidence.
  const reusedBytes = components.reduce((sum, component) => {
    if (!component.sha256 || !size(component.sizeBytes)) return sum;
    return existing.some(
      (item) =>
        item.sha256?.toLowerCase() === component.sha256!.toLowerCase() &&
        item.sizeBytes === component.sizeBytes &&
        fileMatches(item)
    )
      ? sum + component.sizeBytes!
      : sum;
  }, 0);
  return { totalBytes, downloadBytes: totalBytes === undefined ? undefined : totalBytes - reusedBytes, reusedBytes };
}

function evaluate(
  candidate: CatalogRecord | undefined,
  profiles: ComfyProfile[],
  options: ModelCenterOptions
): LocalModelRecommendation {
  const { device, catalog } = options;
  const registered = (profile: ComfyProfile): boolean =>
    !options.registeredProfileIds || options.registeredProfileIds.includes(profile.id);
  const currentVerified = new Set(
    profiles
      .filter(
        (profile) =>
          registered(profile) &&
          comfyWorkflowStatus(profile) === 'verified' &&
          Boolean(profile.validation?.fingerprint) &&
          !profile.validation?.error &&
          hasWorkflow(profile) &&
          hasModelFiles(profile) &&
          hardwareUnchanged(profile, device)
      )
      .map((profile) => profile.id)
  );
  const ordered = profiles.toSorted(
    (a, b) =>
      Number(currentVerified.has(b.id)) - Number(currentVerified.has(a.id)) ||
      Number(registered(b)) - Number(registered(a)) ||
      Number(comfyWorkflowStatus(b) === 'verified') - Number(comfyWorkflowStatus(a) === 'verified') ||
      a.id.localeCompare(b.id)
  );
  const primary = ordered[0];
  const family = primary?.family ?? stringValue(candidate?.family);
  const kind =
    primary?.kind ?? (candidate?.kind === 'video' || ['h3', 'fasth3-omni'].includes(family) ? 'video' : 'image');
  const components = primary ? primary.components : candidateComponents(candidate!);
  const workflows = candidate
    ? workflowsForCandidate(catalog, candidate).filter(
        (workflow) => Object.keys(record(workflow.graph)).length > 0 && workflow.apiConversionRequired !== true
      )
    : [];
  const available = ordered.filter(hasWorkflow);
  const verified = currentVerified.size > 0;
  const tasks = [
    ...ordered.flatMap((profile) => profile.workflowMetadata?.tasks ?? profile.capabilities),
    ...workflows.flatMap((workflow) =>
      Array.isArray(workflow.capabilities)
        ? workflow.capabilities.filter((task): task is string => typeof task === 'string')
        : []
    ),
  ];
  const bytes = bytesFor(
    components,
    options.inventory.profiles
      .filter(
        (profile) =>
          ['loadable', 'verified'].includes(profile.state) &&
          Boolean(profile.validation?.fingerprint) &&
          !profile.validation?.error
      )
      .flatMap((profile) => profile.components)
  );
  const reasons: LocalModelReason[] = [];
  let unknown = false;
  let insufficient = false;
  const missing = (reason: LocalModelReason): void => {
    unknown = true;
    reasons.push(reason);
  };
  const gap = (reason: LocalModelReason): void => {
    insufficient = true;
    reasons.push(reason);
  };
  if (!components.length || components.some((item) => !size(item.sizeBytes) || !item.sha256 || !item.version))
    missing('component-metadata-missing');
  if (!available.length && !workflows.length) missing('workflow-missing');
  if (!device.disk) missing('disk-unknown');
  // Existing content needs no second copy of all weights; reserve space only for new downloads.
  if (
    bytes.downloadBytes !== undefined &&
    bytes.downloadBytes > 0 &&
    device.disk &&
    bytes.downloadBytes + Math.max(4 * 2 ** 30, Math.ceil(bytes.downloadBytes * 0.1)) > device.disk.freeBytes
  )
    gap('disk-insufficient');
  const precision = [candidate?.quantization, ...components.map((item) => item.precision)].join(' ');
  const blackwellRequired = record(candidate?.hardware).blackwellOnly === true || /NVFP4/i.test(precision);
  if (candidate && !(['win32', 'linux'].includes(device.os) && device.arch === 'x64')) missing('platform-unknown');
  const gpus = device.gpus
    .map((gpu, index) => ({ gpu, index }))
    .filter(({ gpu }) => !candidate || gpu.vendor === 'nvidia');
  let eligible = gpus;
  if (candidate) {
    eligible = gpus.filter(({ gpu }) => {
      const capability = Number(gpu.computeCapability);
      return (
        !Number.isFinite(capability) ||
        (blackwellRequired ? ['10.0', '10.3', '12.0', '12.1'].includes(gpu.computeCapability!) : capability >= 8)
      );
    });
    if (gpus.length && !eligible.length) {
      if (blackwellRequired && gpus.some(({ gpu }) => Number(gpu.computeCapability) > 12.1))
        missing('hardware-unknown');
      else gap('gpu-architecture-insufficient');
    }
  }
  const budgets = eligible
    .map(({ gpu, index }) => ({
      gpu,
      index,
      budget: comfyMemoryBudget(
        components.map((item) => size(item.sizeBytes)),
        device,
        { ...gpu, sharedMemory: gpu.sharedMemory || gpu.vendor === 'apple' }
      ),
    }))
    .toSorted(
      (a, b) =>
        Number(b.budget?.fitsTotal === true) - Number(a.budget?.fitsTotal === true) ||
        (b.gpu.totalMemoryBytes ?? 0) - (a.gpu.totalMemoryBytes ?? 0) ||
        a.index - b.index
    );
  const selected = budgets[0];
  const memory = selected?.budget;
  if (!gpus.length || !selected || memory?.fitsTotal === undefined) missing('hardware-unknown');
  else if (budgets.every(({ budget }) => budget?.fitsTotal === false)) gap('memory-insufficient');
  if (
    memory?.fitsTotal &&
    (memory.fitsAvailable === false ||
      (selected?.gpu.totalMemoryBytes !== undefined &&
        memory.requiredBytes <= selected.gpu.totalMemoryBytes &&
        selected.gpu.freeMemoryBytes !== undefined &&
        memory.requiredBytes > selected.gpu.freeMemoryBytes))
  )
    reasons.push('temporary-memory-pressure');
  if (
    memory &&
    selected &&
    (selected.gpu.totalMemoryBytes === undefined || memory.requiredBytes > selected.gpu.totalMemoryBytes)
  )
    reasons.push('offload-required');
  if (candidate && selected && (!selected.gpu.computeCapability || !selected.gpu.driver)) missing('hardware-unknown');
  // Saved runtime evidence is usable; opening the center never imports Python or runs a native kernel.
  const runtimeEvidence = ordered.some(
    (profile) =>
      profile.state === 'loadable' &&
      profile.validation?.runtime?.packages.torch &&
      !profile.validation.error &&
      hardwareUnchanged(profile, device)
  );
  if (!verified && !runtimeEvidence) missing('runtime-unverified');
  if (
    !verified &&
    (record(candidate?.hardware).kernelValidationRequired === true || /ConvRot|NVFP4|W4A8|GPTQ/i.test(precision))
  )
    missing('native-kernel-unverified');
  if (verified) reasons.unshift('verified-workflow');
  else if (!unknown && !insufficient) reasons.push('capacity-compatible');
  const status = verified ? 'verified' : insufficient ? 'insufficient' : unknown ? 'unknown' : 'compatible';
  const candidateId = candidate ? stringValue(candidate.id) : undefined;
  const registeredName = ordered
    .filter(registered)
    .toSorted((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))[0]?.name;
  const activity = [...(options.activities ?? [])]
    .filter(
      (item) =>
        activeModelCenterActivity(item.state) &&
        item.family === family &&
        (!item.profileId || ordered.some((profile) => profile.id === item.profileId)) &&
        (!item.candidateId || item.candidateId === candidateId)
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    id: primary ? getComfyModelSetId(primary) : `candidate:${candidateId}`,
    family,
    name: stringValue(
      candidate?.name,
      registeredName ?? primary?.name ?? stringValue(candidate?.id, family).replace(/-discovery$/, '')
    ),
    kind,
    candidateId,
    quantization:
      primary?.quantization ??
      stringValue(candidate?.quantization, components.map((item) => `${item.role}:${item.precision}`).join(' + ')),
    purposes: purposes(kind, tasks),
    status,
    reasons: [...new Set(reasons)],
    installed: ordered.some(registered),
    modelSetId: primary ? getComfyModelSetId(primary) : undefined,
    profiles: ordered,
    verifiedProfileId: ordered.find((profile) => currentVerified.has(profile.id))?.id,
    workflowCount: ordered.length || workflows.length,
    ...bytes,
    requiredMemoryBytes:
      memory?.requiredBytes ??
      comfyMemoryBudget(
        components.map((item) => size(item.sizeBytes)),
        device,
        {}
      )?.requiredBytes,
    selectedGpuIndex: selected?.index,
    activity: activity ? { conversationId: activity.conversationId, state: activity.state } : undefined,
    installContext: { candidateId, checkedAt: device.checkedAt, installDirectory: device.installDirectory },
  };
}

/** Keep model identity stable while collecting all registered workflows and catalog candidates. */
export function evaluateLocalModelCenter(options: ModelCenterOptions): LocalModelCenterSnapshot {
  const consumed = new Set<string>();
  const models = groupComfyModels(options.inventory.profiles).map((group) => {
    const candidate = options.catalog.candidates.find((item) => candidateMatches(item, group.profiles[0]));
    if (candidate) consumed.add(stringValue(candidate.id));
    return evaluate(candidate, group.profiles, options);
  });
  for (const candidate of options.catalog.candidates) {
    if (!consumed.has(stringValue(candidate.id))) models.push(evaluate(candidate, [], options));
  }
  const rank = { verified: 0, compatible: 1, unknown: 2, insufficient: 3 };
  models.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      Number(b.installed) - Number(a.installed) ||
      (a.totalBytes ?? Infinity) - (b.totalBytes ?? Infinity) ||
      a.family.localeCompare(b.family) ||
      a.id.localeCompare(b.id)
  );
  const recommendations: LocalModelRecommendation[] = [];
  const coveredPurposes = new Set<LocalModelPurpose>();
  for (const purpose of ['image-generation', 'image-edit', 'video'] as const) {
    if (coveredPurposes.has(purpose)) continue;
    const choice = models.find(
      (model) => model.status !== 'insufficient' && model.purposes.includes(purpose) && !recommendations.includes(model)
    );
    if (choice) {
      recommendations.push(choice);
      choice.purposes.forEach((covered) => coveredPurposes.add(covered));
    }
  }
  return {
    checkedAt: options.device.checkedAt,
    device: options.device,
    inventory: options.inventory,
    recommendations,
    models,
  };
}
