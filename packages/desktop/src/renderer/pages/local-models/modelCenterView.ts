import type { LocalModelRecommendation } from '@/common/chat/document/creation/workflows/localModels';
import { comfyWorkflowStatus } from '@/common/chat/document/creation/workflows/identity';

export type ModelTab = 'recommended' | 'all' | 'installed';
export type ModelKind = 'all' | 'image' | 'video';

/** Explain the registered precision, never infer it from a model's marketing name. */
export function modelPrecisionGuide(model: LocalModelRecommendation) {
  const precision = (model.quantization ?? '').toUpperCase();
  if (/UNCONFIRMED|UNKNOWN/.test(precision)) return undefined;
  if (/INT8/.test(precision) && /W4A8/.test(precision)) return { label: 'INT8 + W4A8', kind: 'w4a8' } as const;
  if (/NVFP4/.test(precision) && /INT8|BF16|FP8/.test(precision))
    return { label: [...new Set(precision.match(/NVFP4|INT8|BF16|FP8/g))].join(' / '), kind: 'mixed' } as const;
  if (/^NVFP4(?:\b|[-_])/.test(precision)) return { label: 'NVFP4', kind: 'nvfp4' } as const;
  if (/^INT8(?:\b|[-_])/.test(precision)) return { label: 'INT8', kind: 'int8' } as const;
  if (/^FP8(?:\b|[-_])/.test(precision)) return { label: 'FP8', kind: 'fp8' } as const;
  if (/^(BF16|FP16)(?:\b|[-_])/.test(precision))
    return { label: precision.startsWith('BF16') ? 'BF16' : 'FP16', kind: 'full' } as const;
  return undefined;
}

export function modelAction(model: LocalModelRecommendation): 'install' | 'use' | 'progress' {
  if (model.activity) return 'progress';
  return model.profiles.length ? 'use' : 'install';
}

/** Product copy comes from model identity; custom models use only their registered purpose. */
export function modelDescription(model: LocalModelRecommendation) {
  switch (model.family) {
    case 'h3':
    case 'fasth3-omni':
    case 'qwen-edit':
    case 'z-image':
    case 'flux-3-image-klein':
    case 'moss-image-base':
    case 'moss-image-sft':
    case 'krea2':
      return model.family;
    default:
      return model.kind === 'video' ? 'video' : model.purposes.includes('image-edit') ? 'editing' : 'image';
  }
}

/** Only preview an actual image from the route validated for the current device. */
export function verifiedPreviewArtifact(model: LocalModelRecommendation): string | undefined {
  if (model.status !== 'verified' || !model.verifiedProfileId) return undefined;
  const profile = model.profiles.find((item) => item.id === model.verifiedProfileId);
  if (!profile || comfyWorkflowStatus(profile) !== 'verified') return undefined;
  return profile.validation?.artifacts?.find(
    (path) => /^(?:[a-z]:[\\/]|\/)/i.test(path) && /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(path)
  );
}

/** Keep workflow variants inside their model set, while preserving custom model families. */
export function filterModels(models: LocalModelRecommendation[], kind: ModelKind, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return models.filter((model) => {
    if (kind !== 'all' && kind !== model.kind) return false;
    return (
      !needle ||
      [model.name, model.family, model.quantization, ...model.profiles.map((p) => p.version)]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle)
    );
  });
}

export function formatBytes(bytes: number | undefined, locale: string, unknown: string): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return unknown;
  const unit = bytes >= 1024 ** 3 ? 'GB' : 'MB';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / (unit === 'GB' ? 1024 ** 3 : 1024 ** 2))} ${unit}`;
}

export function usedPercent(total: number | undefined, free: number | undefined): number | undefined {
  if (total === undefined || free === undefined || total <= 0 || !Number.isFinite(total) || !Number.isFinite(free))
    return undefined;
  return Math.max(0, Math.min(100, ((total - free) / total) * 100));
}
