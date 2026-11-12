import type { NavigateFunction } from 'react-router-dom';
import type {
  LocalDeviceSnapshot,
  LocalModelRecommendation,
} from '@/common/chat/document/creation/workflows/localModels';
import type { ComfyDraftIntent } from './comfyDraft';
import { comfyWorkflowStatus } from '@/common/chat/document/creation/workflows/identity';

export type ModelCenterEntry =
  | { token: string; action: 'install'; intent: ComfyDraftIntent }
  | { token: string; action: 'use'; profileId: string; kind: 'image' | 'video' };

/** Use the normal composer/session send path; the center never invokes an installer. */
export function startModelCenterInstallation(
  model: LocalModelRecommendation,
  device: LocalDeviceSnapshot,
  navigate: NavigateFunction,
  intent: 'install' | 'repair' = 'install'
) {
  const entry: ModelCenterEntry = {
    token: crypto.randomUUID(),
    action: 'install',
    intent: {
      family: model.family,
      name: model.name,
      kind: model.kind,
      intent,
      requestId: crypto.randomUUID(),
      profileId: intent === 'repair' ? model.profiles[0]?.id : undefined,
      installContext: {
        candidateId: model.candidateId,
        checkedAt: device.checkedAt,
        installDirectory: device.installDirectory,
      },
    },
  };
  return navigate('/ai-creation', { state: { modelCenterEntry: entry } });
}

export function useModelCenterProfile(model: LocalModelRecommendation, navigate: NavigateFunction) {
  const profile =
    model.profiles.find((item) => item.id === model.verifiedProfileId) ??
    model.profiles.find((item) => comfyWorkflowStatus(item) === 'verified') ??
    model.profiles[0];
  if (!profile) throw new Error('COMFY_PROFILE_REQUIRED');
  const entry: ModelCenterEntry = {
    token: crypto.randomUUID(),
    action: 'use',
    profileId: profile.id,
    kind: profile.kind,
  };
  return navigate('/ai-creation', { state: { modelCenterEntry: entry } });
}
