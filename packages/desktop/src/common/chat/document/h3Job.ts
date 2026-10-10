import { z } from 'zod';

export const h3JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type H3JobStatus = z.infer<typeof h3JobStatusSchema>;

export const h3RequestedModeSchema = z.enum(['auto', 't2v', 'fl2v', 'ref2va']);
export type H3RequestedMode = z.infer<typeof h3RequestedModeSchema>;
export const h3ResolvedModeSchema = z.enum(['t2v', 'fl2v', 'ref2va']);
export type H3ResolvedMode = z.infer<typeof h3ResolvedModeSchema>;
export const h3ReferenceSchema = z
  .object({
    type: z.enum(['image', 'video', 'audio']),
    path: z.string().trim().min(1),
  })
  .strict();
export type H3Reference = z.infer<typeof h3ReferenceSchema>;

export const h3GenerationSpecSchema = z
  .object({
    prompt: z.string().trim().min(1).max(20_000),
    durationSeconds: z.number().finite().min(4).max(15).optional(),
    megapixels: z.number().finite().positive().max(2).optional(),
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    mode: h3RequestedModeSchema.optional(),
    references: z.array(h3ReferenceSchema).max(12).optional(),
    referenceImagePath: z.string().min(1).optional(),
  })
  .strict();
export type H3GenerationSpec = z.infer<typeof h3GenerationSpecSchema>;
export type H3NormalizedGenerationSpec = Omit<H3GenerationSpec, 'mode' | 'references' | 'referenceImagePath'> & {
  mode: H3RequestedMode;
  references: H3Reference[];
};

function collectReferences(spec: Pick<H3GenerationSpec, 'references' | 'referenceImagePath'>): H3Reference[] {
  const references = [...(spec.references ?? [])];
  if (
    spec.referenceImagePath &&
    !references.some((reference) => reference.type === 'image' && reference.path === spec.referenceImagePath)
  ) {
    references.unshift({ type: 'image', path: spec.referenceImagePath });
  }
  return references;
}

function validateReferenceLimits(references: H3Reference[]): void {
  const count = (type: H3Reference['type']): number => references.filter((reference) => reference.type === type).length;
  if (references.length > 12) throw new Error('H3_REFERENCE_LIMIT_TOTAL');
  if (count('image') > 9) throw new Error('H3_REFERENCE_LIMIT_IMAGES');
  if (count('video') > 3) throw new Error('H3_REFERENCE_LIMIT_VIDEOS');
  if (count('audio') > 3) throw new Error('H3_REFERENCE_LIMIT_AUDIO');
}

export function inferH3Mode(
  spec: Pick<H3GenerationSpec, 'mode' | 'references' | 'referenceImagePath'>
): H3ResolvedMode {
  const references = collectReferences(spec);
  validateReferenceLimits(references);
  const requested = spec.mode ?? 'auto';
  const allImages = references.every((reference) => reference.type === 'image');
  if (requested === 't2v') {
    if (references.length) throw new Error('H3_T2V_REFERENCES_NOT_ALLOWED');
    return 't2v';
  }
  if (requested === 'fl2v') {
    if (!allImages || references.length < 1 || references.length > 2)
      throw new Error('H3_FL2V_REQUIRES_ONE_OR_TWO_IMAGES');
    return 'fl2v';
  }
  if (requested === 'ref2va') {
    if (!references.length) throw new Error('H3_REF2VA_REQUIRES_REFERENCES');
    return 'ref2va';
  }
  if (!references.length) return 't2v';
  return allImages && references.length <= 2 ? 'fl2v' : 'ref2va';
}

export function normalizeH3GenerationSpec(specInput: unknown): H3NormalizedGenerationSpec {
  const parsed = h3GenerationSpecSchema.parse(specInput);
  const references = collectReferences(parsed);
  const mode = parsed.mode ?? 'auto';
  inferH3Mode({ mode, references });
  const { referenceImagePath: _legacyReferenceImagePath, ...spec } = parsed;
  return { ...spec, mode, references };
}

export type H3Artifact = {
  filename: string;
  subfolder: string;
  type: string;
  mimeType: string;
  resourcePath?: string;
};

export type H3ComfyDiagnosis = {
  category: 'OOM' | 'MISSING_MODEL' | 'MISSING_NODE' | 'INVALID_INPUT' | 'EXECUTION_FAILED';
  nodeId?: string;
  retryable: false;
  action: string;
};

/** Backend activity, never a time-based estimate of total completion. */
export type H3Activity = {
  phase: 'waiting' | 'executing' | 'node-progress' | 'finalizing';
  nodeId?: string;
  nodeType?: string;
  value?: number;
  max?: number;
  updatedAt: string;
};

export type H3Job = {
  id: string;
  spec: H3NormalizedGenerationSpec;
  resolvedMode: H3ResolvedMode;
  status: H3JobStatus;
  progress: number;
  activity?: H3Activity;
  monitor?: H3Monitor;
  /** A remote prompt may still own GPU work. Blocks replacement submissions across restarts. */
  remoteUncertain?: boolean;
  submissionPending?: boolean;
  promptId?: string;
  parentVersionId?: string;
  cancelRequested?: boolean;
  startedAt?: string;
  finishedAt?: string;
  artifacts: H3Artifact[];
  error?: string;
  diagnosis?: H3ComfyDiagnosis;
};

export type H3Monitor = {
  state: 'connected' | 'reconnecting' | 'suspected-stall' | 'missing';
  remoteState?: 'queued' | 'running' | 'absent';
  lastHeartbeatAt?: string;
  consecutiveFailures: number;
};

/** Agent calls are snapshots, not a loop that waits for GPU work. The UI owns live updates. */
export function h3AgentSnapshot(job: H3Job) {
  return {
    ...job,
    terminal: !['queued', 'running'].includes(job.status),
    stopPolling: true,
    automaticRetryAllowed: false,
    nextAction: job.remoteUncertain
      ? 'CONFIRM_REMOTE_STOP'
      : ['queued', 'running'].includes(job.status)
        ? 'END_TURN_UI_WILL_MONITOR'
        : job.status === 'succeeded'
          ? 'SHOW_RESULT'
          : 'EXPLAIN_FAILURE_WAIT_FOR_USER',
  };
}

export const h3VersionSchema = z
  .object({
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    label: z.string().min(1).max(200),
    jobId: z.string().min(1),
    createdAt: z.string().min(1),
    selected: z.boolean(),
    artifactPath: z.string().min(1).optional(),
  })
  .strict();
export type H3Version = z.infer<typeof h3VersionSchema>;

export function createH3Job(specInput: unknown, id = crypto.randomUUID()): H3Job {
  const spec = normalizeH3GenerationSpec(specInput);
  return { id, spec, resolvedMode: inferH3Mode(spec), status: 'queued', progress: 0, artifacts: [] };
}
