import { describe, it, expect } from 'vitest';
import { catalogSchema, officialEntrySchema } from '@/common/contentCatalog/schema';
import { resolveEntryAction, localize, supportsEntry } from '@/common/contentCatalog/policy';
import { captureTemplateSnapshot } from '@/common/contentCatalog/snapshot';
const sha = 'a'.repeat(64);
const base = {
  id: 'official:test',
  revision: 1,
  origin: 'official',
  kind: 'image',
  title: { 'en-US': 'Title' },
  description: { 'en-US': 'Description' },
  cover: sha,
  ratio: '3:4',
  requiredCapabilities: [],
  minClientVersion: '0.0.0',
  attribution: { author: 'Author', license: 'CC0', sourceUrl: 'https://example.com/work' },
};
const template = {
  ...base,
  entryType: 'template',
  prompt: { 'en-US': 'First prompt' },
  parameters: {},
  requiresReference: false,
};
const showcase = { ...base, entryType: 'showcase', media: sha };
const catalog = {
  schemaVersion: 1,
  releaseSequence: 1,
  defaultLocale: 'en-US',
  publishedAt: '2026-10-23T00:00:00Z',
  models: [],
  entries: [template, showcase],
  assets: [{ sha256: sha, path: 'assets/cover.webp', mimeType: 'image/webp', sizeBytes: 10 }],
};
describe('official content contract', () => {
  it('accepts templates and showcases separately', () => {
    expect(officialEntrySchema.parse(template).entryType).toBe('template');
    expect(officialEntrySchema.parse(showcase).entryType).toBe('showcase');
  });
  it('rejects generation fields in showcases', () => {
    expect(officialEntrySchema.safeParse({ ...showcase, prompt: { 'en-US': 'execute' } }).success).toBe(false);
  });
  it('rejects missing template prompts and nonofficial origins', () => {
    expect(officialEntrySchema.safeParse({ ...template, prompt: undefined }).success).toBe(false);
    expect(officialEntrySchema.safeParse({ ...template, origin: 'user' }).success).toBe(false);
  });
  it('rejects duplicate IDs, missing default text and escaping assets', () => {
    expect(catalogSchema.safeParse(catalog).success).toBe(false);
    expect(catalogSchema.safeParse({ ...catalog, entries: [{ ...template, title: { de: 'Hallo' } }] }).success).toBe(
      false
    );
    expect(
      catalogSchema.safeParse({
        ...catalog,
        entries: [template],
        assets: [{ ...catalog.assets[0], path: '../secret' }],
      }).success
    ).toBe(false);
  });
  it('does not invent a template action for a showcase', () => {
    const entry = officialEntrySchema.parse(showcase);
    expect(resolveEntryAction(entry, [], { version: '2.0.0', capabilities: [] }).template).toBeUndefined();
  });
  it('requires the exact referenced compatible published template', () => {
    const entry = officialEntrySchema.parse({ ...showcase, templateRef: { id: template.id, revision: 2 } });
    expect(
      resolveEntryAction(entry, [officialEntrySchema.parse(template)], { version: '2.0.0', capabilities: [] }).template
    ).toBeUndefined();
  });
  it('gates unknown capabilities and falls back to default language', () => {
    expect(
      supportsEntry({ ...template, requiredCapabilities: ['future'] }, { version: '2.0.0', capabilities: [] })
    ).toBe(false);
    expect(localize(template.title, 'ja-JP', 'en-US')).toBe('Title');
  });
  it('captures an independent template copy', () => {
    const item = officialEntrySchema.parse(template);
    if (item.entryType !== 'template') throw Error();
    const copy = captureTemplateSnapshot(item, 1, 'en-US', 'en-US');
    item.prompt['en-US'] = 'new';
    expect(copy.prompt).toBe('First prompt');
    expect(copy.templateRevision).toBe(1);
  });
  it('rejects image showcases with video media and duplicate resource paths', () => {
    expect(
      catalogSchema.safeParse({
        ...catalog,
        entries: [{ ...showcase, id: 'official:showcase' }],
        assets: [{ ...catalog.assets[0], mimeType: 'video/mp4' }],
      }).success
    ).toBe(false);
    expect(
      catalogSchema.safeParse({
        ...catalog,
        entries: [template],
        assets: [...catalog.assets, { ...catalog.assets[0], sha256: 'b'.repeat(64) }],
      }).success
    ).toBe(false);
  });
});
