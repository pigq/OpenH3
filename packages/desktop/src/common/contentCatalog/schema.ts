import { z } from 'zod';
const text = z.string().trim().min(1).max(32_768);
export const localizedTextSchema = z
  .record(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/), text)
  .refine((v) => Object.keys(v).length > 0);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^official:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
const safePath = z
  .string()
  .max(240)
  .regex(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/)
  .refine((v) => v.split('/').every((p) => p !== '.' && p !== '..'));
export const assetSchema = z
  .object({
    sha256: digestSchema,
    path: safePath,
    mimeType: z.enum(['image/webp', 'image/png', 'image/jpeg', 'video/mp4']),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
  })
  .strict()
  .refine((a) => a.mimeType === 'video/mp4' || a.sizeBytes <= 4 * 1024 * 1024);
const attribution = z
  .object({
    author: text,
    license: text,
    sourceUrl: z
      .string()
      .url()
      .refine((u) => new URL(u).protocol === 'https:'),
  })
  .strict();
const requirements = {
  minClientVersion: version.default('0.0.0'),
  requiredCapabilities: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/))
    .max(50)
    .default([]),
};
const common = {
  id,
  revision: z.number().int().positive().safe(),
  origin: z.literal('official'),
  kind: z.enum(['image', 'video']),
  title: localizedTextSchema,
  description: localizedTextSchema,
  cover: digestSchema,
  ratio: z.enum(['3:4', '4:3', '16:9', '2:3', '6:7', '1:1', '9:16']),
  attribution,
  ...requirements,
};
export const officialEntrySchema = z.discriminatedUnion('entryType', [
  z
    .object({
      ...common,
      entryType: z.literal('template'),
      prompt: localizedTextSchema,
      parameters: z
        .record(
          z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
          z.union([z.string().max(4096), z.number().finite(), z.boolean()])
        )
        .default({}),
      requiresReference: z.boolean().default(false),
      media: digestSchema.optional(),
      duration: z.number().positive().max(120).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      entryType: z.literal('showcase'),
      media: digestSchema,
      templateRef: z.object({ id, revision: z.number().int().positive().safe() }).strict().optional(),
      duration: z.number().positive().max(120).optional(),
    })
    .strict(),
]);
export const modelCardSchema = z
  .object({
    id,
    revision: z.number().int().positive().safe(),
    origin: z.literal('official'),
    family: z.string().regex(/^[a-z0-9-]{1,64}$/),
    name: text,
    kind: z.enum(['image', 'video']),
    description: localizedTextSchema,
    cover: digestSchema,
    ...requirements,
  })
  .strict();
export const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseSequence: z.number().int().nonnegative().safe(),
    defaultLocale: z.string().min(2).max(32),
    publishedAt: z.string().datetime(),
    models: z.array(modelCardSchema).max(2000),
    entries: z.array(officialEntrySchema).max(2000),
    assets: z.array(assetSchema).max(6000),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    const assets = new Map(c.assets.map((a) => [a.sha256, a]));
    if (c.models.length + c.entries.length > 2000)
      ctx.addIssue({ code: 'custom', message: 'Too many official entries' });
    if (new Set(c.assets.map((a) => a.path)).size !== c.assets.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate resource path' });
    if (assets.size !== c.assets.length) ctx.addIssue({ code: 'custom', message: 'Duplicate asset digest' });
    const image = (hash: string) => assets.has(hash) && assets.get(hash)!.mimeType.startsWith('image/');
    for (const e of [...c.models, ...c.entries]) {
      if (ids.has(e.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate official ID' });
      ids.add(e.id);
      if (!image(e.cover)) ctx.addIssue({ code: 'custom', message: 'Missing image cover' });
      if (!e.description[c.defaultLocale]) ctx.addIssue({ code: 'custom', message: 'Missing default description' });
      if ('title' in e && !e.title[c.defaultLocale]) ctx.addIssue({ code: 'custom', message: 'Missing default title' });
      if ('prompt' in e && !e.prompt[c.defaultLocale])
        ctx.addIssue({ code: 'custom', message: 'Missing default prompt' });
      if ('media' in e && e.media && (!assets.has(e.media) || !assets.get(e.media)!.mimeType.startsWith(`${e.kind}/`)))
        ctx.addIssue({ code: 'custom', message: 'Missing or incompatible media' });
      if ('entryType' in e && e.kind === 'video' && (!e.media || !e.duration))
        ctx.addIssue({ code: 'custom', message: 'Video requires media and duration' });
    }
  });
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal('content-stable'),
    keyId: z.string().regex(/^[\w-]{1,64}$/),
    releaseSequence: z.number().int().positive().safe(),
    publishedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    minClientVersion: version,
    snapshotCommit: z.string().regex(/^[a-f0-9]{40}$/),
    catalogPath: safePath,
    catalogSha256: digestSchema,
    catalogSizeBytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
  })
  .strict();
type TemplateShape = z.infer<(typeof officialEntrySchema)['options'][0]>;
type ShowcaseShape = z.infer<(typeof officialEntrySchema)['options'][1]>;
export type OfficialTemplate = Required<Omit<TemplateShape, 'media' | 'duration'>> &
  Pick<TemplateShape, 'media' | 'duration'>;
export type OfficialShowcase = Required<Omit<ShowcaseShape, 'templateRef' | 'duration'>> &
  Pick<ShowcaseShape, 'templateRef' | 'duration'>;
export type OfficialEntry = OfficialTemplate | OfficialShowcase;
export type OfficialModelCard = Required<z.infer<typeof modelCardSchema>>;
export type ContentAsset = Required<z.infer<typeof assetSchema>>;
export type ContentCatalog = Omit<Required<z.infer<typeof catalogSchema>>, 'models' | 'entries' | 'assets'> & {
  models: OfficialModelCard[];
  entries: OfficialEntry[];
  assets: ContentAsset[];
};
export type ContentManifest = Required<z.infer<typeof manifestSchema>>;
export const parseCatalog = (input: unknown): ContentCatalog => catalogSchema.parse(input) as ContentCatalog;
export type ContentStatus = {
  changes?: { from: number; to: number; added: string[]; changed: string[]; removed: string[] };
  canManage?: boolean;
  phase:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'activating'
    | 'ready'
    | 'incompatible'
    | 'failed'
    | 'cancelled';
  activeSequence: number;
  availableSequence?: number;
  lastCheckedAt?: string;
  errorCode?: string;
  autoSync: boolean;
  sourceConfigured: boolean;
};
