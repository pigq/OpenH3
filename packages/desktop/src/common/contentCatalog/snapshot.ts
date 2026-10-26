import type { OfficialTemplate } from './schema';
import { localize } from './policy';
import { z } from 'zod';
export const templateSnapshotSchema = z
  .object({
    templateId: z.string().regex(/^official:[A-Za-z0-9._-]+$/),
    templateRevision: z.number().int().positive().safe(),
    releaseSequence: z.number().int().nonnegative().safe(),
    locale: z.string().min(2).max(32),
    title: z.string().max(32768),
    prompt: z.string().max(32768),
    parameters: z.record(z.string().max(64), z.union([z.string().max(4096), z.number().finite(), z.boolean()])),
    requiresReference: z.boolean(),
  })
  .strict();
export type TemplateSnapshot = {
  templateId: string;
  templateRevision: number;
  releaseSequence: number;
  locale: string;
  title: string;
  prompt: string;
  parameters: Record<string, string | number | boolean>;
  requiresReference: boolean;
};
export function captureTemplateSnapshot(
  template: OfficialTemplate,
  releaseSequence: number,
  locale: string,
  defaultLocale: string
): TemplateSnapshot {
  return {
    templateId: template.id,
    templateRevision: template.revision,
    releaseSequence,
    locale,
    title: localize(template.title, locale, defaultLocale),
    prompt: localize(template.prompt, locale, defaultLocale),
    parameters: { ...template.parameters },
    requiresReference: template.requiresReference,
  };
}
