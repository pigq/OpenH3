import { COMFY_FAMILIES } from '@/renderer/pages/guid/Creation/comfyDraft';
import { CREATION_TEMPLATES } from '@/renderer/pages/guid/utils/creationTemplates';
import type { ContentCatalog } from '@/common/contentCatalog/schema';
import guid from '@/renderer/services/i18n/locales/zh-CN/guid.json';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';
export const templateSnapshotFixture: TemplateSnapshot = {
  templateId: 'official:test-template',
  templateRevision: 1,
  releaseSequence: 1,
  locale: 'en-US',
  title: 'Original template',
  prompt: 'Original template prompt',
  parameters: { width: 1024 },
  requiresReference: false,
};
export const galleryFixture: ContentCatalog = {
  schemaVersion: 1,
  releaseSequence: 0,
  publishedAt: '2026-10-23T00:00:00Z',
  defaultLocale: 'zh-CN',
  models: COMFY_FAMILIES.map((e) => ({
    ...e,
    id: 'official:model-' + e.family,
    revision: 1,
    origin: 'official',
    description: { 'zh-CN': e.name },
    cover: '1'.padStart(64, '0'),
    minClientVersion: '0.0.0',
    requiredCapabilities: [],
    attribution: { author: 'Test', license: 'CC0', sourceUrl: 'https://github.com/pigq/OpenH3' },
  })),
  assets: [],
  entries: CREATION_TEMPLATES.map((e, index) => ({
    id: 'official:' + e.key,
    revision: 1,
    origin: 'official',
    entryType: 'template',
    kind: e.kind,
    title: { 'zh-CN': guid.templates[e.key].title },
    description: { 'zh-CN': guid.templates[e.key].title },
    prompt: { 'zh-CN': guid.templates[e.key].prompt },
    parameters: {},
    requiresReference: !!e.requiresReference,
    cover: String(index + 1).padStart(64, '0'),
    ratio: e.ratio,
    minClientVersion: '0.0.0',
    requiredCapabilities: [],
    attribution: { author: 'Test', license: 'CC0', sourceUrl: 'https://github.com/pigq/OpenH3' },
    ...(e.kind === 'video' ? { media: String(index + 101).padStart(64, '0'), duration: e.duration } : {}),
  })),
};
