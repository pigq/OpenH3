import type { ComfyFamily, ComfyIntent } from '@/common/chat/document/creation/comfy';

export type ComfyDraftIntent = {
  family: ComfyFamily;
  intent: Exclude<ComfyIntent, 'generate'>;
  profileId?: string;
  requestId?: string;
};

let pendingIntent: ComfyDraftIntent | undefined;
export function readComfyDraftIntent() {
  return pendingIntent;
}
export function writeComfyDraftIntent(intent?: ComfyDraftIntent) {
  pendingIntent = intent ? { ...intent, requestId: intent.requestId ?? crypto.randomUUID() } : undefined;
  return pendingIntent;
}

export const COMFY_FAMILIES = [
  { family: 'h3', name: 'H3', kind: 'video' },
  { family: 'fasth3-omni', name: 'FastH3-Omni', kind: 'video' },
  { family: 'qwen-edit', name: 'Qwen-Edit', kind: 'image' },
  { family: 'z-image', name: 'Z-Image', kind: 'image' },
  { family: 'flux-3-image-klein', name: 'FLUX 3 Image Klein', kind: 'image' },
  { family: 'moss-image-base', name: 'MOSS-Image-Base', kind: 'image' },
  { family: 'moss-image-sft', name: 'MOSS-Image-SFT', kind: 'image' },
  { family: 'krea2', name: 'Krea 2', kind: 'image' },
] as const;

/** Locate optional image recipe documentation without adding it to the Skill instruction. */
export function comfyFamilyRecipeKey(family: ComfyFamily) {
  switch (family) {
    case 'flux-3-image-klein':
      return 'guid.comfy.recipes.flux-3-image-klein' as const;
    case 'moss-image-base':
      return 'guid.comfy.recipes.moss-image-base' as const;
    case 'moss-image-sft':
      return 'guid.comfy.recipes.moss-image-sft' as const;
    case 'krea2':
      return 'guid.comfy.recipes.krea2' as const;
    default:
      return undefined;
  }
}

/** Keep the target in metadata while leaving the installation request editable. */
export function comfyFamilyDetails(family: ComfyFamily) {
  return COMFY_FAMILIES.find((item) => item.family === family)!;
}
