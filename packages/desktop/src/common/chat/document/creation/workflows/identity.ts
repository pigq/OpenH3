import type { ComfyProfile } from '../comfy';

type Component = ComfyProfile['components'][number];
type ModelIdentityProfile = Pick<ComfyProfile, 'id' | 'kind'> &
  Partial<Pick<ComfyProfile, 'components' | 'family' | 'quantization'>>;

/** Older H3 profiles used encoder for the same text-encoder component. Stored records remain intact. */
export const comfyComponentIdentityRole = (role: string): string => (role === 'encoder' ? 'text-encoder' : role);

function immutableSource(component: Component): string | undefined {
  if (!component.url) return undefined;
  const url = new URL(component.url);
  if (
    url.protocol === 'https:' &&
    ['huggingface.co', 'hf-mirror.com'].includes(url.hostname) &&
    /^\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\/.+/i.test(url.pathname)
  )
    return `https://huggingface.co${url.pathname}`;
  if (
    url.protocol === 'https:' &&
    url.hostname === 'raw.githubusercontent.com' &&
    /^\/[^/]+\/[^/]+\/[a-f0-9]{40}\/.+/i.test(url.pathname)
  )
    return `https://raw.githubusercontent.com${url.pathname}`;
  return undefined;
}

/** Legacy components remain part of the base model until their dependency scope is established. */
export function comfyBaseComponents(profile: ModelIdentityProfile): Component[] {
  return (profile.components ?? []).filter((component) => component.identityRole !== 'workflow');
}

function contentIdentity(component: Component): string | undefined {
  const source = component.sha256 ? `sha256:${component.sha256.toLowerCase()}` : immutableSource(component);
  return source
    ? JSON.stringify([comfyComponentIdentityRole(component.role), component.precision, component.sizeBytes, source])
    : undefined;
}

/** Group only proven model contents; unknown sources retain their existing profile identity. */
export function getComfyModelSetId(profile: ModelIdentityProfile): string {
  const base = comfyBaseComponents(profile);
  const components = base.map(contentIdentity);
  if (
    !profile.family ||
    !profile.quantization ||
    !components.length ||
    components.some((identity) => identity === undefined)
  )
    return `profile:${profile.id}`;
  // Keep the complete canonical identity to avoid introducing a lossy browser-side hash.
  return `model:${JSON.stringify([profile.family, profile.kind, profile.quantization, ...components.toSorted()])}`;
}

/** Compare base component contents and precisions without letting route dependencies change the model. */
export function sameComfyModel(left: ComfyProfile, right: ComfyProfile): boolean {
  if (left.family !== right.family || left.kind !== right.kind || left.quantization !== right.quantization)
    return false;
  const leftBase = comfyBaseComponents(left),
    rightBase = comfyBaseComponents(right);
  if (!leftBase.length || leftBase.length !== rightBase.length) return false;
  // One-to-one matching also handles several shards with incomplete metadata in either record.
  const matches = new Map<number, number>();
  const match = (leftIndex: number, visited: Set<number>): boolean => {
    for (let rightIndex = 0; rightIndex < rightBase.length; rightIndex++) {
      if (visited.has(rightIndex) || !sameComponent(leftBase[leftIndex], rightBase[rightIndex])) continue;
      visited.add(rightIndex);
      const prior = matches.get(rightIndex);
      if (prior === undefined || match(prior, visited)) {
        matches.set(rightIndex, leftIndex);
        return true;
      }
    }
    return false;
  };
  return leftBase.every((_, index) => match(index, new Set()));
}

function sameComponent(left: Component, right: Component): boolean {
  if (
    comfyComponentIdentityRole(left.role) !== comfyComponentIdentityRole(right.role) ||
    left.precision !== right.precision
  )
    return false;
  if (left.sizeBytes !== undefined && right.sizeBytes !== undefined && left.sizeBytes !== right.sizeBytes) return false;
  if (left.sha256 && right.sha256) return left.sha256.toLowerCase() === right.sha256.toLowerCase();
  const leftSource = immutableSource(left),
    rightSource = immutableSource(right);
  if (leftSource && rightSource) return leftSource === rightSource;
  const normalize = (file: string): string => {
    const normalized = file.replaceAll('\\', '/').replace(/\/$/, '');
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  return normalize(left.path) === normalize(right.path) && left.version === right.version;
}

/** Reject an automatic route that changes or cannot establish the selected base model. */
export function assertSameComfyModel(left: ComfyProfile, right: ComfyProfile): void {
  if (!sameComfyModel(left, right)) throw new Error('COMFY_REPAIR_MODEL_CHANGED');
}

export type ComfyModelGroup = { modelSetId: string; profiles: ComfyProfile[] };

export type ComfyWorkflowStatus = 'verified' | 'pending-validation' | 'needs-preparation' | 'needs-repair';

/** Display the route's own evidence; a different graph cannot inherit an earlier verification. */
export function comfyWorkflowStatus(
  profile: Pick<ComfyProfile, 'state' | 'workflowMetadata' | 'workflowSha256'>
): ComfyWorkflowStatus {
  const workflow = profile.workflowMetadata;
  if (profile.state === 'invalid' || workflow?.preparation === 'repair') return 'needs-repair';
  if (workflow?.preparation === 'pending') return 'needs-preparation';
  if (
    profile.state === 'verified' &&
    (!workflow ||
      workflow.evidence?.some(
        (evidence) =>
          evidence.kind === 'execution' && evidence.workflowHash.toLowerCase() === profile.workflowSha256?.toLowerCase()
      ))
  )
    return 'verified';
  return 'pending-validation';
}

/** Preserve every workflow and its own validation inside the shared model entry. */
export function groupComfyModels(profiles: readonly ComfyProfile[]): ComfyModelGroup[] {
  const groups = new Map<string, ComfyModelGroup>();
  for (const profile of profiles) {
    const modelSetId = getComfyModelSetId(profile);
    const group = groups.get(modelSetId);
    if (group) group.profiles.push(profile);
    else groups.set(modelSetId, { modelSetId, profiles: [profile] });
  }
  return [...groups.values()];
}
