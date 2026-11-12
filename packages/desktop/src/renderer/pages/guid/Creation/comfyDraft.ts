import {
  comfyFamilyKind,
  comfyFamilySchema,
  type ComfyFamily,
  type BuiltinComfyFamily,
  type ComfyIntent,
} from '@/common/chat/document/creation/comfy';

export type ComfyDraftIntent = {
  family: ComfyFamily;
  intent: Exclude<ComfyIntent, 'generate'>;
  profileId?: string;
  requestId?: string;
  name?: string;
  kind?: 'image' | 'video';
  installContext?: import('@/common/chat/document/creation/workflows/localModels').LocalModelInstallContext;
};

let pendingIntent: ComfyDraftIntent | undefined;
export function readComfyDraftIntent() {
  return pendingIntent;
}
export function writeComfyDraftIntent(intent?: ComfyDraftIntent) {
  pendingIntent = intent ? { ...intent, requestId: intent.requestId ?? crypto.randomUUID() } : undefined;
  return pendingIntent;
}

const COMFY_FAMILY_NAMES = {
  h3: 'H3',
  'fasth3-omni': 'FastH3-Omni',
  'qwen-edit': 'Qwen-Edit',
  'z-image': 'Z-Image',
  'flux-3-image-klein': 'FLUX 3 Image Klein',
  'moss-image-base': 'MOSS-Image-Base',
  'moss-image-sft': 'MOSS-Image-SFT',
  krea2: 'Krea 2',
} as const satisfies Record<BuiltinComfyFamily, string>;

export const COMFY_FAMILIES = comfyFamilySchema.options.map((family) => ({
  family,
  name: COMFY_FAMILY_NAMES[family],
  kind: comfyFamilyKind(family),
}));

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
export function comfyFamilyDetails(family: ComfyFamily, custom?: Pick<ComfyDraftIntent, 'name' | 'kind'>) {
  return (
    COMFY_FAMILIES.find((item) => item.family === family) ?? {
      family,
      name: custom?.name ?? family,
      kind: comfyFamilyKind(family, custom?.kind),
    }
  );
}
