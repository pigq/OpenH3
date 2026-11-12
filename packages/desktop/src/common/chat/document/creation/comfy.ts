import { z } from 'zod';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';
import type { LocalModelInstallContext } from './workflows/localModels';
import {
  comfyGenerationRequirementsSchema,
  comfyReferenceRoleSchema,
  comfyWorkflowSchema,
  type GenerationAttemptIdentity,
  type GenerationExecutionSnapshot,
} from './workflows/contracts';

const pinnedVersion = z
  .string()
  .min(1)
  .refine((value) => !/^(latest|main|master|HEAD|stable|nightly)$/i.test(value), 'A fixed revision is required');
const requestId = z.string().uuid();
const absolutePath = z
  .string()
  .min(1)
  .refine((value) => /^(?:[a-z]:[\\/]|\/)/i.test(value), 'An absolute path is required');
export const localModelInstallContextSchema = z.object({
  candidateId: z.string().min(1).optional(),
  checkedAt: z.string().min(1),
  installDirectory: absolutePath,
}) as z.ZodType<LocalModelInstallContext>;
const localUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  }, 'A local ComfyUI endpoint is required');
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
export const comfyFamilySchema = z.enum([
  'h3',
  'fasth3-omni',
  'qwen-edit',
  'z-image',
  'flux-3-image-klein',
  'moss-image-base',
  'moss-image-sft',
  'krea2',
]);
export type BuiltinComfyFamily = z.infer<typeof comfyFamilySchema>;
/** The curated directory is not a whitelist for Agent-installed models. */
export const comfyModelFamilySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
export type ComfyFamily = z.infer<typeof comfyModelFamilySchema>;
export type ComfyIntent = 'generate' | 'install' | 'repair' | 'install-other';
export const comfyReferenceSchema = z.object({
  type: z.enum(['image', 'video', 'audio']),
  path: absolutePath,
  id: z.string().min(1).optional(),
  role: comfyReferenceRoleSchema.optional(),
  maskFor: z.string().min(1).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** EXIF orientation, captured after inspecting the source image. */
  orientation: z.number().int().min(1).max(8).optional(),
});
export type ComfyReference = z.infer<typeof comfyReferenceSchema>;
export const comfyGenerationInputSchema = z
  .object({
    prompt: z.string().min(1),
    imagePaths: z.array(absolutePath).max(9).optional(),
    /** Ordered multimodal references. Order is preserved for Omni prompt numbering and workflow binding. */
    references: z.array(comfyReferenceSchema).max(12).optional(),
    requirements: comfyGenerationRequirementsSchema.optional(),
    negativePrompt: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    seed: z.number().int().nonnegative().optional(),
    durationSeconds: z.number().positive().max(120).optional(),
    batchSize: z.number().int().positive().max(16).optional(),
    offload: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.imagePaths !== undefined && input.references !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['references'],
        message: 'COMFY_IMAGE_PATHS_AND_REFERENCES_CONFLICT',
      });
      return;
    }
    const counts = { image: 0, video: 0, audio: 0 };
    for (const reference of input.references ?? []) counts[reference.type]++;
    const references = input.references ?? [];
    const ids = references.flatMap((reference) => (reference.id ? [reference.id] : []));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['references'], message: 'COMFY_REFERENCE_ID_DUPLICATE' });
    for (const [index, reference] of references.entries()) {
      if (reference.role !== 'mask' && reference.maskFor === undefined) continue;
      const source = references.find((candidate) => candidate.id === reference.maskFor);
      if (
        reference.role !== 'mask' ||
        reference.type !== 'image' ||
        !reference.id ||
        !reference.maskFor ||
        source?.role !== 'edit-source' ||
        source.type !== 'image' ||
        reference.width !== source.width ||
        reference.height !== source.height ||
        reference.orientation !== source.orientation
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['references', index],
          message: 'COMFY_MASK_SOURCE_MISMATCH',
        });
    }
    for (const [type, count, maximum] of [
      ['image', counts.image, 9],
      ['video', counts.video, 3],
      ['audio', counts.audio, 3],
    ] as const) {
      if (count > maximum) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['references'],
          message: `COMFY_REFERENCE_LIMIT:${type}:${maximum}`,
        });
      }
    }
  });
export type ComfyGenerationInput = z.infer<typeof comfyGenerationInputSchema>;

/** Parses the shared input contract and applies family-specific generation requirements. */
export function validateComfyGenerationInputForFamily(family: ComfyFamily, input: unknown): ComfyGenerationInput {
  const parsed = comfyGenerationInputSchema.parse(input);
  const errors = comfyFamilyInputIssues(family, parsed);
  if (errors.length) throw new Error(errors[0]);
  return parsed;
}

/** Return model constraints to the planner without treating a missing intermediate asset as a failed generation. */
export function comfyFamilyInputIssues(family: ComfyFamily, parsed: ComfyGenerationInput): string[] {
  const errors: string[] = [];
  if (family === 'fasth3-omni') {
    const hasImage = Boolean(parsed.imagePaths?.length || parsed.references?.some(({ type }) => type === 'image'));
    const hasVideo = Boolean(parsed.references?.some(({ type }) => type === 'video'));
    if (!hasImage && !hasVideo) errors.push('COMFY_OMNI_REFERENCE_REQUIRED');
    if (parsed.durationSeconds !== undefined && (parsed.durationSeconds < 5 || parsed.durationSeconds > 15))
      errors.push('COMFY_OMNI_DURATION_RANGE:5:15');
  }
  return errors;
}

const COMFY_FAMILY_KINDS = {
  h3: 'video',
  'fasth3-omni': 'video',
  'qwen-edit': 'image',
  'z-image': 'image',
  'flux-3-image-klein': 'image',
  'moss-image-base': 'image',
  'moss-image-sft': 'image',
  krea2: 'image',
} as const satisfies Record<BuiltinComfyFamily, 'image' | 'video'>;

/** Every supported family declares its output kind; new families cannot default to image. */
export function comfyFamilyKind(family: ComfyFamily, declaredKind?: 'image' | 'video'): 'image' | 'video' {
  const builtin = comfyFamilySchema.safeParse(family);
  if (builtin.success) return COMFY_FAMILY_KINDS[builtin.data];
  if (!declaredKind) throw new Error('COMFY_MODEL_KIND_REQUIRED');
  return declaredKind;
}

export const comfyProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][\w.-]{0,99}$/),
  family: comfyModelFamilySchema,
  name: z.string().min(1),
  kind: z.enum(['image', 'video']),
  version: pinnedVersion,
  quantization: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  workflowMetadata: comfyWorkflowSchema.optional(),
  state: z.enum(['downloaded', 'loadable', 'verified', 'invalid']),
  environment: z.object({
    root: absolutePath,
    python: absolutePath,
    baseUrl: localUrl,
    launchArgs: z
      .array(z.string())
      .optional()
      .describe(
        'Additional ComfyUI runtime options. The application manages listener and runtime/media directories: do not include --listen, --port, --base-directory, --input-directory or --output-directory, including --flag=value forms. Set the loopback listening address and port in environment.baseUrl instead.'
      ),
  }),
  components: z
    .array(
      z.object({
        role: z.string().min(1),
        /** Only established route dependencies may be excluded from base model identity. */
        identityRole: z.enum(['base', 'workflow']).optional(),
        name: z.string().min(1),
        path: absolutePath,
        version: pinnedVersion,
        precision: z.string().min(1),
        url: z.string().url().optional(),
        /** Approved, byte-identical download transports in domestic-first fallback order. */
        sourceUrls: z.array(z.string().url()).min(1).max(4).optional(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .optional(),
        sizeBytes: z.number().int().positive().optional(),
      })
    )
    .min(1),
  nodes: z.array(z.object({ id: z.string().min(1), version: pinnedVersion })).min(1),
  workflowPath: absolutePath,
  workflowSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  bindings: z.record(z.string(), z.array(z.object({ nodeId: z.string().min(1), input: z.string().min(1) })).min(1)),
  defaults: z.record(z.string(), scalar),
  memoryPolicy: z
    .object({
      minWidth: z.number().int().positive().optional(),
      minHeight: z.number().int().positive().optional(),
      dimensionStep: z.number().int().positive().optional(),
      minBatchSize: z.number().int().positive().optional(),
      allowOffload: z.boolean().optional(),
      evidence: z.string().min(1),
    })
    .optional(),
  validation: z
    .object({
      fingerprint: z.string(),
      checkedAt: z.string(),
      promptId: z.string().optional(),
      artifacts: z.array(z.string()).optional(),
      error: z.string().optional(),
      runtime: z
        .object({
          python: z.string(),
          packages: z.record(z.string(), z.string()),
          comfyRevision: z.string().optional(),
          nodeRevisions: z.record(z.string(), z.string()),
          hardware: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ComfyProfile = z.infer<typeof comfyProfileSchema>;

/** Resolve each supplied reference to its declared role slot or its legacy positional destination. */
export function resolveComfyReferenceBindings(
  profile: ComfyProfile,
  input: ComfyGenerationInput
): ComfyProfile['bindings'][string] {
  const references: ComfyReference[] =
    input.references ?? input.imagePaths?.map((file) => ({ type: 'image' as const, path: file })) ?? [];
  const workflow = profile.workflowMetadata;
  if (input.requirements && !(workflow?.tasks ?? profile.capabilities).includes(input.requirements.task))
    throw new Error('COMFY_WORKFLOW_TASK_UNSUPPORTED');
  if (profile.family !== 'fasth3-omni' && references.some((reference) => reference.type !== 'image'))
    throw new Error('COMFY_MULTIMODAL_WORKFLOW_REQUIRED');
  let destinations: ComfyProfile['bindings'][string];
  if (
    references.some((reference) => reference.role !== undefined) ||
    input.requirements?.roles?.length ||
    (input.requirements && !references.length && workflow?.inputs.length)
  ) {
    if (!workflow) throw new Error('COMFY_REFERENCE_ROLE_UNSUPPORTED');
    const counts = workflow.inputs.map(() => 0);
    destinations = [];
    for (const reference of references) {
      if (!reference.role) throw new Error('COMFY_REFERENCE_ROLE_REQUIRED');
      const slotIndex = workflow.inputs.findIndex(
        (slot, index) => slot.role === reference.role && slot.type === reference.type && counts[index] < slot.maxCount
      );
      if (slotIndex < 0) throw new Error('COMFY_REFERENCE_ROLE_UNSUPPORTED');
      const slot = workflow.inputs[slotIndex];
      const offset = counts[slotIndex]++;
      if (profile.family === 'fasth3-omni' && workflow.adapter === 'fasth3-omni') {
        if (reference.role !== 'reference') throw new Error('COMFY_REFERENCE_ROLE_UNSUPPORTED');
        continue;
      }
      const destination = slot.binding && profile.bindings[slot.binding]?.[(slot.bindingIndex ?? 0) + offset];
      if (!destination) throw new Error('COMFY_IMAGE_BINDINGS_MISSING');
      destinations.push(destination);
    }
    if (workflow.inputs.some((slot, index) => counts[index] < slot.minCount))
      throw new Error('COMFY_REFERENCE_COUNT_MISMATCH');
    if (input.requirements?.roles?.some((role) => !references.some((reference) => reference.role === role)))
      throw new Error('COMFY_REFERENCE_ROLE_REQUIRED');
  } else {
    if (profile.family === 'fasth3-omni') return [];
    destinations = (
      profile.bindings.image ??
      profile.bindings.images ??
      profile.bindings.imagePaths ??
      profile.bindings.inputImage ??
      []
    ).slice(0, references.length);
    if (references.length > destinations.length) throw new Error('COMFY_IMAGE_BINDINGS_MISSING');
  }
  const used = destinations.map(({ nodeId, input: target }) => JSON.stringify([nodeId, target]));
  if (new Set(used).size !== used.length) throw new Error('COMFY_IMAGE_BINDINGS_DUPLICATE');
  return destinations;
}

/** Check capacity and semantic destinations before runtime validation. */
export function assertComfyReferenceBindings(profile: ComfyProfile, input: ComfyGenerationInput): void {
  resolveComfyReferenceBindings(profile, input);
}

/** Group identical local recipes for display, retaining the selected record's own validation. */
export function distinctComfyProfiles(
  profiles: readonly ComfyProfile[],
  preferredIds: readonly string[] = []
): ComfyProfile[] {
  const canonicalPath = (value: string): string => {
    const normalized = value.replaceAll('\\', '/').replace(/\/$/, '');
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object')
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
        .join(',')}}`;
    return JSON.stringify(value) ?? 'null';
  };
  const identity = (profile: ComfyProfile): string => {
    // Incomplete summaries have no evidence for equivalence. Never merge by name.
    if (
      !profile.environment?.root ||
      !profile.environment.python ||
      !profile.components?.length ||
      !profile.nodes?.length ||
      !profile.bindings ||
      !profile.defaults ||
      (!profile.workflowSha256 && !profile.workflowPath)
    )
      return profile.id;
    return stable({
      family: profile.family,
      kind: profile.kind,
      quantization: profile.quantization,
      environment: {
        root: canonicalPath(profile.environment.root),
        python: canonicalPath(profile.environment.python),
        launchArgs: profile.environment.launchArgs ?? [],
      },
      components: profile.components
        .map((component) => ({
          role: component.role,
          identityRole: component.identityRole,
          path: canonicalPath(component.path),
          version: component.version,
          precision: component.precision,
          sha256: component.sha256,
          sizeBytes: component.sizeBytes,
          // A pinned source identifies unchecksummed bytes. It may be omitted
          // only when the digest establishes content identity independently.
          source: component.sha256
            ? undefined
            : {
                url: component.url,
                sourceUrls: [...(component.sourceUrls ?? [])].sort(),
              },
        }))
        .sort((a, b) => stable(a).localeCompare(stable(b))),
      nodes: [...profile.nodes].sort((a, b) => stable(a).localeCompare(stable(b))),
      workflow: profile.workflowSha256?.toLowerCase() ?? canonicalPath(profile.workflowPath),
      workflowMetadata: profile.workflowMetadata,
      bindings: profile.bindings,
      defaults: profile.defaults,
      memoryPolicy: profile.memoryPolicy,
      capabilities: [...profile.capabilities].sort(),
    });
  };
  const score = (profile: ComfyProfile): number => {
    const selected = preferredIds.indexOf(profile.id);
    return selected >= 0
      ? 1000 + preferredIds.length - selected
      : profile.state === 'verified'
        ? 3
        : profile.state === 'loadable'
          ? 2
          : profile.state === 'downloaded'
            ? 1
            : 0;
  };
  const unique = new Map<string, ComfyProfile>();
  for (const profile of profiles) {
    const key = identity(profile),
      prior = unique.get(key);
    if (!prior || score(profile) > score(prior)) unique.set(key, profile);
  }
  return [...unique.values()];
}
const graph = z
  .record(z.string(), z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }))
  .refine((value) => Object.keys(value).length > 0);
export const comfyInstallPlanSchema = comfyProfileSchema.omit({ state: true, validation: true }).extend({
  targetRoot: absolutePath,
  downloadBytes: z.number().int().nonnegative(),
  requiredBytes: z.number().int().nonnegative(),
  reason: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  workflow: graph,
  /** Exact pinned source bytes, when reserializing would invalidate a bundled workflow identity. */
  workflowSource: z
    .string()
    .min(1)
    .max(8 * 1024 * 1024)
    .optional(),
  /** Existing registered component paths outside writable roots; checksum reuse only, never written. */
  reuseOnlyPaths: z.array(absolutePath).max(256).optional(),
  commands: z
    .array(
      z.object({
        executable: z.string().min(1),
        args: z.array(z.string()),
        cwd: absolutePath,
        label: z.string().min(1),
        revision: pinnedVersion,
        stage: z.enum(['prepare', 'finish']).default('prepare'),
      })
    )
    .max(50),
  smokeInput: comfyGenerationInputSchema,
  repair: z.boolean().default(false),
});
export type ComfyInstallPlan = z.infer<typeof comfyInstallPlanSchema>;

/**
 * A model-card installation request. The card deliberately sends only the
 * family/intent/profile identity and optional user-selected install context. The Agent selects execution using curated
 * knowledge and the actual environment; this schema is for the optional managed executor.
 *
 * `plan` is retained on the request branch for older clients which already
 * constructed a complete plan. Identity-only requests ask that optional executor to plan.
 */
export const comfyInstallRequestSchema = z.union([
  z.object({
    action: z.literal('request'),
    family: comfyModelFamilySchema,
    kind: z.enum(['image', 'video']).optional(),
    intent: z.enum(['install', 'repair', 'install-other']),
    profileId: z.string().min(1).optional(),
    installContext: localModelInstallContextSchema.optional(),
    sourceOverrides: z
      .array(z.object({ component: z.string().min(1), urls: z.array(z.string().url()).min(1).max(4) }))
      .max(64)
      .optional(),
    requestId: requestId.optional(),
  }),
  z.object({ action: z.literal('request'), plan: comfyInstallPlanSchema }),
  z.object({ action: z.literal('plan'), plan: comfyInstallPlanSchema }),
]);
export type ComfyInstallIdentityRequest = {
  action: 'request';
  family: ComfyFamily;
  kind?: 'image' | 'video';
  intent: Exclude<ComfyIntent, 'generate'>;
  profileId?: string;
  installContext?: LocalModelInstallContext;
  sourceOverrides?: Array<{ component: string; urls: string[] }>;
  requestId?: string;
};
export type ComfyInstallRequest =
  | ComfyInstallIdentityRequest
  | { action: 'request'; plan: ComfyInstallPlan }
  | { action: 'plan'; plan: ComfyInstallPlan };

export type ComfyApprovalDecision = { mode: 'automatic' | 'manual'; runtimeMode?: string };
export type ComfyInstallPreparation = {
  requestId: string;
  conversationId: string;
  family: ComfyFamily;
  intent: Exclude<ComfyIntent, 'generate'>;
  status: 'detecting' | 'failed' | 'interrupted';
  attempts?: number;
  repeatedErrors?: number;
  inputKey?: string;
  error?: string;
  updatedAt: string;
};
export type ComfyOperation = {
  id: string;
  requestId: string;
  conversationId: string;
  state: 'awaiting-consent' | 'authorized' | 'running' | 'paused' | 'failed' | 'completed' | 'cancelled';
  /** Agent completion receipts describe verified work; they never execute a saved install plan. */
  execution?: 'agent';
  validationJobId?: string;
  plan: ComfyInstallPlan;
  /** Original model-card identity, persisted atomically with the immutable plan. */
  installRequest?: ComfyInstallIdentityRequest;
  progress?: string;
  error?: string;
  profileId?: string;
  updatedAt: string;
  snapshotDirectory?: string;
  diagnosticLogPath?: string;
  diagnosis?: ComfyDiagnosis;
  approval?: ComfyApprovalDecision & { source: 'session' | 'ui'; checkedAt: string };
  /** Persisted budget shared by Agent recovery across application restarts. */
  recoveryAttempts?: number;
  /** Per failed execution stage, so fixing one stage does not exhaust later repairs. */
  recoveryStageAttempts?: Record<string, number>;
};
export type ComfyDiagnosis = { category: string; nodeId?: string; retryable: boolean; action: string };

/** Resolve missing scalar bindings before selecting or starting a workflow. */
export function unsupportedComfyInputs(profile: ComfyProfile, input: ComfyGenerationInput): string[] {
  const { imagePaths: _images, references: _references, requirements: _requirements, ...values } = input;
  return Object.entries(values)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        !profile.bindings[key]?.length &&
        !(key === 'durationSeconds' && profile.bindings.frames?.length)
    )
    .map(([key]) => `COMFY_INPUT_UNSUPPORTED:${key}`);
}

/** Identify workflow evidence that needs Agent repair, never permission to replay a failed submission. */
export function comfyWorkflowRepairReason(failure: {
  error?: string;
  diagnosis?: { category?: string };
}):
  | 'reference-bindings'
  | 'reference-routing'
  | 'missing-node'
  | 'workflow-schema'
  | 'runtime-revision'
  | 'input-adapter'
  | undefined {
  const [code, detail] = (failure.error ?? '').split(':');
  switch (code) {
    case 'COMFY_IMAGE_BINDINGS_MISSING':
    case 'COMFY_IMAGE_BINDINGS_DUPLICATE':
      return 'reference-bindings';
    case 'COMFY_REFERENCE_INPUT_DISCONNECTED':
    case 'COMFY_REFERENCE_OUTPUT_UNCONFIRMED':
      return 'reference-routing';
    case 'COMFY_MULTIMODAL_WORKFLOW_REQUIRED':
    case 'COMFY_OMNI_REFERENCE_BINDING_MISSING':
      return 'input-adapter';
    case 'COMFY_NODE_REVISION_UNCONFIRMED':
    case 'COMFY_NODE_REVISION_MISMATCH':
      return 'runtime-revision';
    case 'COMFY_BINDING_INVALID':
    case 'COMFY_INPUT_UNSUPPORTED':
    case 'COMFY_PROMPT_BINDING_MISSING':
    case 'COMFY_API_WORKFLOW_REQUIRED':
    case 'COMFY_WORKFLOW_INVALID_JSON':
      return 'workflow-schema';
    case 'COMFY_EXISTING_RUNTIME_INCOMPATIBLE':
      return detail === 'WORKFLOW_NODE_OR_INPUT_UNSUPPORTED' ? 'workflow-schema' : undefined;
    case 'H3_WORKFLOW_PREFLIGHT':
    case 'H3_COMFY_PROMPT_REJECTED':
    case 'H3_COMFY_EXECUTION_FAILED':
    case 'COMFY_PROMPT_REJECTED': {
      const category = failure.diagnosis?.category ?? detail;
      if (category === 'MISSING_NODE') return 'missing-node';
      return category === 'INVALID_INPUT' && code !== 'H3_COMFY_EXECUTION_FAILED' ? 'workflow-schema' : undefined;
    }
    default:
      return undefined;
  }
}
export type ComfyInstallationValidation = {
  id: string;
  requestId: string;
  conversationId: string;
  family: ComfyFamily;
  profileId: string;
  state: 'completed' | 'failed';
  updatedAt: string;
  error?: string;
  diagnosis?: ComfyDiagnosis;
  diagnosticLogPath?: string;
  promptId?: string;
  artifacts: Array<{ path: string; mimeType: string }>;
  purpose?: 'generation' | 'workflow-repair' | 'installation';
  selectionProfileId?: string;
  originalInput?: ComfyGenerationInput;
  profile?: ComfyProfile;
};
export type ComfyGenerationJob = {
  templateSnapshot?: TemplateSnapshot;
  identity?: GenerationAttemptIdentity;
  snapshot?: GenerationExecutionSnapshot;
  id: string;
  profileId: string;
  kind: 'image' | 'video';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  promptId?: string;
  artifacts: Array<{ path: string; mimeType: string }>;
  error?: string;
  diagnosis?: ComfyDiagnosis;
  diagnosticLogPath?: string;
  submissionUncertain?: boolean;
  /** Successful job that resolved this failed request; historical failure evidence remains intact. */
  recoveredBy?: string;
  createdAt: string;
  updatedAt: string;
  adjustments?: Array<{ reason: string; input: ComfyGenerationInput }>;
  /** External prompts are observed without owning or interrupting their execution. */
  observationOnly?: boolean;
  /** Scoped repair evidence returned only for a failed workflow-capability attempt. */
  originalInput?: ComfyGenerationInput;
  profile?: ComfyProfile;
};

export type ComfyInventoryDiagnostic = { code: string; path?: string };
export type ComfyInventory = {
  profiles: ComfyProfile[];
  workflowPreparations?: Array<{
    modelSetId: string;
    profileId: string;
    workflowId: string;
    tasks: string[];
    reason: string;
    additionalBytes: number;
  }>;
  complete: boolean;
  diagnostics: ComfyInventoryDiagnostic[];
  checkedAt?: string;
};
