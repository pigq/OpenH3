import { z } from 'zod';

export const workflowSelectionModeSchema = z.enum(['auto', 'fixed']);
export type WorkflowSelectionMode = z.infer<typeof workflowSelectionModeSchema>;

export const comfyReferenceRoleSchema = z.enum([
  'edit-source',
  'identity',
  'style',
  'structure',
  'first-frame',
  'last-frame',
  'mask',
  'reference',
]);
export type ComfyReferenceRole = z.infer<typeof comfyReferenceRoleSchema>;

export const workflowTaskSchema = z.enum([
  'text-to-image',
  'image-to-image',
  'image-edit',
  'multi-reference-image',
  'inpaint',
  'text-to-video',
  'image-to-video',
  'reference-to-video',
  'first-last-frame-video',
]);
export type WorkflowTask = z.infer<typeof workflowTaskSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/i);
const nonempty = z.string().min(1);
const pinnedRevision = nonempty.refine(
  (value) => !/^(latest|main|master|HEAD|stable|nightly)$/i.test(value),
  'A fixed revision is required'
);

export const comfyWorkflowInputSchema = z
  .object({
    role: comfyReferenceRoleSchema,
    type: z.enum(['image', 'video', 'audio']),
    minCount: z.number().int().nonnegative(),
    maxCount: z.number().int().nonnegative(),
    /** The profile binding whose destinations accept this role, in reference order. */
    binding: nonempty.optional(),
    bindingIndex: z.number().int().nonnegative().optional(),
  })
  .refine(({ minCount, maxCount }) => minCount <= maxCount, 'Minimum input count exceeds capacity');
export type ComfyWorkflowInput = z.infer<typeof comfyWorkflowInputSchema>;

export const comfyWorkflowEvidenceSchema = z.object({
  kind: z.enum(['recipe', 'dependencies', 'execution']),
  workflowHash: digest,
  checkedAt: nonempty,
  inputRoles: z.array(comfyReferenceRoleSchema).optional(),
  referenceCount: z.number().int().nonnegative().optional(),
  environmentFingerprint: nonempty.optional(),
});
export type ComfyWorkflowEvidence = z.infer<typeof comfyWorkflowEvidenceSchema>;

export const comfyWorkflowSchema = z.object({
  id: nonempty,
  revision: pinnedRevision,
  tasks: z.array(workflowTaskSchema).min(1),
  inputs: z.array(comfyWorkflowInputSchema),
  adapter: z.enum(['native', 'fasth3-omni', 'external']),
  preparation: z.enum(['ready', 'pending', 'repair']),
  source: z.object({ url: z.string().url(), sha256: digest }).optional(),
  evidence: z.array(comfyWorkflowEvidenceSchema).optional(),
});
export type ComfyWorkflow = z.infer<typeof comfyWorkflowSchema>;

export const comfyGenerationRequirementsSchema = z.object({
  task: workflowTaskSchema,
  roles: z.array(comfyReferenceRoleSchema).optional(),
});
export type ComfyGenerationRequirements = z.infer<typeof comfyGenerationRequirementsSchema>;

export const modelConstraintSchema = z
  .object({
    modelSetId: nonempty,
    selectionRevision: z.number().int().nonnegative(),
    workflowMode: workflowSelectionModeSchema,
    fixedWorkflowId: nonempty.optional(),
  })
  .refine(
    ({ workflowMode, fixedWorkflowId }) => workflowMode !== 'fixed' || fixedWorkflowId !== undefined,
    'A fixed workflow selection requires a workflow ID'
  );
export type ModelConstraint = z.infer<typeof modelConstraintSchema>;

export const generationAttemptRequestSchema = z.object({
  taskId: nonempty,
  attemptId: nonempty,
  predecessorAttemptId: nonempty.optional(),
});
export type GenerationAttemptRequest = z.infer<typeof generationAttemptRequestSchema>;

export const generationAttemptIdentitySchema = generationAttemptRequestSchema.extend({
  modelSetId: nonempty,
  selectionRevision: z.number().int().nonnegative(),
  workflowId: nonempty,
  workflowRevision: pinnedRevision,
  workflowHash: digest,
  inputFingerprint: nonempty,
});
export type GenerationAttemptIdentity = z.infer<typeof generationAttemptIdentitySchema>;

/** Captured by execution after checking the actual files, graph, and runtime. */
export type GenerationExecutionSnapshot = {
  identity: GenerationAttemptIdentity;
  profileId: string;
  environmentFingerprint: string;
  dependencies: Array<{ role: string; path: string; sha256?: string; version: string; precision: string }>;
  parameters: Record<string, string | number | boolean>;
  references: Array<{
    id: string;
    type: 'image' | 'video' | 'audio';
    role?: ComfyReferenceRole;
    path: string;
    sha256: string;
    maskFor?: string;
    width?: number;
    height?: number;
    orientation?: number;
  }>;
};
