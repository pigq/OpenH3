import {
  assertComfyReferenceBindings,
  comfyFamilyInputIssues,
  unsupportedComfyInputs,
  type ComfyGenerationInput,
  type ComfyProfile,
} from '@/common/chat/document/creation/comfy';
import { comfyWorkflowStatus } from '@/common/chat/document/creation/workflows/identity';
import { sameLocalComfyModel } from './modelFiles';
import type { WorkflowSelectionMode } from '@/common/chat/document/creation/workflows/contracts';

export type ComfyWorkflowMatch = {
  profileId: string;
  workflowId: string;
  status: ReturnType<typeof comfyWorkflowStatus>;
  reasons: string[];
};

/** Match declared semantics before submitting a GPU job; undeclared identity/style roles are not inferred. */
export function inspectComfyWorkflow(profile: ComfyProfile, input: ComfyGenerationInput): ComfyWorkflowMatch {
  const metadata = profile.workflowMetadata;
  const reasons = [...comfyFamilyInputIssues(profile.family, input), ...unsupportedComfyInputs(profile, input)];
  const tasks = metadata?.tasks ?? profile.capabilities;
  const requestedTask = input.requirements?.task;
  if (requestedTask && !tasks.includes(requestedTask)) reasons.push('COMFY_WORKFLOW_TASK_UNSUPPORTED');
  const references =
    input.references ?? input.imagePaths?.map((file) => ({ type: 'image' as const, path: file })) ?? [];
  if (!metadata && (input.references?.some((ref) => ref.role) || input.requirements?.roles?.length))
    reasons.push('COMFY_REFERENCE_SEMANTICS_UNCONFIRMED');
  if (metadata?.adapter === 'external') reasons.push('COMFY_WORKFLOW_EXTERNAL_ADAPTER_REQUIRED');
  if (metadata?.adapter === 'fasth3-omni' && profile.family !== 'fasth3-omni')
    reasons.push('COMFY_WORKFLOW_EXTERNAL_ADAPTER_REQUIRED');
  const legacyRequiresImage =
    !metadata &&
    (profile.family === 'qwen-edit' ||
      tasks.includes('image-edit') ||
      tasks.includes('image-to-image') ||
      (!tasks.includes('text-to-video') && (tasks.includes('image-to-video') || tasks.includes('reference-to-video'))));
  if (
    !references.length &&
    (legacyRequiresImage || tasks.every((task) => !['text-to-image', 'text-to-video'].includes(task)))
  )
    reasons.push('COMFY_INPUT_IMAGE_REQUIRED');
  try {
    assertComfyReferenceBindings(profile, input);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    reasons.push(error.message);
  }
  if (input.requirements?.roles) {
    for (const role of input.requirements.roles) {
      if (!input.references?.some((ref) => ref.role === role)) reasons.push(`COMFY_REFERENCE_ROLE_REQUIRED:${role}`);
    }
  }
  return {
    profileId: profile.id,
    workflowId: metadata?.id ?? profile.id,
    status: comfyWorkflowStatus(profile),
    reasons: [...new Set(reasons)],
  };
}

/** Select within the unchanged base model, preferring a locally verified route. */
export function matchComfyWorkflows(
  anchor: ComfyProfile,
  profiles: readonly ComfyProfile[],
  input: ComfyGenerationInput,
  mode: WorkflowSelectionMode = 'auto',
  fixedWorkflowId?: string
): { selectedProfileId?: string; candidates: ComfyWorkflowMatch[] } {
  const scores = { verified: 0, 'pending-validation': 1, 'needs-preparation': 2, 'needs-repair': 3 };
  const candidates = profiles
    .filter((profile) => profile.id === anchor.id || sameLocalComfyModel(anchor, profile))
    .filter(
      (profile) =>
        mode === 'auto' ||
        (profile.id === anchor.id &&
          (profile.workflowMetadata?.id ?? profile.id) ===
            (fixedWorkflowId ?? anchor.workflowMetadata?.id ?? anchor.id))
    )
    .map((profile) => inspectComfyWorkflow(profile, input))
    .sort(
      (left, right) =>
        scores[left.status] - scores[right.status] ||
        Number(right.profileId === anchor.id) - Number(left.profileId === anchor.id)
    );
  const selected = candidates.find(
    (candidate) => !candidate.reasons.length && candidate.status !== 'needs-preparation'
  );
  return { selectedProfileId: selected?.profileId, candidates };
}
