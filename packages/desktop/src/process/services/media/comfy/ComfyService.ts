import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { templateSnapshotSchema, type TemplateSnapshot } from '@/common/contentCatalog/snapshot';
import {
  comfyModelFamilySchema,
  comfyInstallPlanSchema,
  comfyProfileSchema,
  comfyFamilyKind,
  validateComfyGenerationInputForFamily,
  comfyFamilyInputIssues,
  comfyGenerationInputSchema,
  unsupportedComfyInputs,
  assertComfyReferenceBindings,
  comfyWorkflowRepairReason,
  comfyInstallRequestSchema,
  localModelInstallContextSchema,
  type ComfyDiagnosis,
  type ComfyGenerationInput,
  type ComfyGenerationJob,
  type ComfyInstallPlan,
  type ComfyOperation,
  type ComfyProfile,
  type ComfyApprovalDecision,
  type ComfyInstallIdentityRequest,
  type ComfyInstallRequest,
  type ComfyInstallPreparation,
  type ComfyInstallationValidation,
  type ComfyInventory,
  type ComfyInventoryDiagnostic,
} from '@/common/chat/document/creation/comfy';
import {
  modelConstraintSchema,
  workflowSelectionModeSchema,
  generationAttemptRequestSchema,
  type GenerationAttemptRequest,
} from '@/common/chat/document/creation/workflows/contracts';
import { assertSameComfyModel, getComfyModelSetId } from '@/common/chat/document/creation/workflows/identity';
import { inspectComfyWorkflow, matchComfyWorkflows } from './routing/matcher';
import { resolveComfyModelFiles } from './routing/modelFiles';
import { buildAttemptIdentity, captureGenerationSnapshot } from './routing/attempts';
import type { ComfyPreparedWorkflows } from './routing/preparation';
import { probeComfyEnvironment, type ComfyEnvironmentReport } from './discovery/environment';
import { isTrustedComfySource } from './planning/transportSelection';
import type { ComfyInstallPlanningContext } from './planning/installPlanner';
import { readLocalModelCenter } from './planning/model-center/service';
import { activeModelCenterActivity } from './planning/model-center/evaluator';
import type { LocalModelCenterSnapshot } from '@/common/chat/document/creation/workflows/localModels';
import type { ComfyWorkflowEngine } from './workflowEngine';
import { verifyComfySmokeArtifact } from './mediaValidation';
import {
  sharedComfyRuntimeCoordinator,
  comfyRuntimeSignature,
  clearBoundComfyRuntime,
  type ComfyCleanupReason,
  type ComfyRuntimeCoordinator,
} from './runtimeCoordinator';

const uuid = z.string().uuid();
const bindingSchema = z.object({
  requestId: uuid,
  conversationId: z.string().min(1),
  profileId: z.string().optional(),
  family: comfyModelFamilySchema.optional(),
  intent: z.enum(['generate', 'install', 'repair', 'install-other']).default('generate'),
  source: z.enum(['local', 'cloud']).optional(),
  kind: z.enum(['image', 'video']).optional(),
  templateSnapshot: templateSnapshotSchema.optional(),
  modelSetId: z.string().optional(),
  selectionRevision: z.number().int().nonnegative().optional(),
  workflowMode: workflowSelectionModeSchema.optional(),
  fixedWorkflowId: z.string().optional(),
  modelConstraint: modelConstraintSchema.optional(),
  origin: z.literal('conversation').optional(),
  installContext: localModelInstallContextSchema.optional(),
});
export type ComfySelection = z.infer<typeof bindingSchema>;
function sameSelection(left: ComfySelection | undefined, right: ComfySelection | undefined): boolean {
  return Boolean(
    left && right && JSON.stringify(bindingSchema.parse(left)) === JSON.stringify(bindingSchema.parse(right))
  );
}
export type ComfyResourceScope = { requestId?: string; conversationId?: string };
const repairAdoptionSchema = z.object({
  selection: bindingSchema,
  jobId: uuid,
  updatedAt: z.string().min(1),
  failedJobs: z.array(z.object({ id: uuid, updatedAt: z.string().min(1) })),
});
type RepairAdoption = z.infer<typeof repairAdoptionSchema>;
type SavedJob = ComfyGenerationJob & {
  requestId: string;
  profile: ComfyProfile;
  input: ComfyGenerationInput;
  submittedInput?: ComfyGenerationInput;
  submissionPending?: boolean;
  reconnectAfter?: number;
  verify?: boolean;
  /** Preserve user-output validation semantics when a first generation reconnects. */
  validationMode?: 'smoke' | 'generation';
  selectionAtSubmission?: ComfySelection;
  executionWorkflow?: { path: string; sha256: string };
  /** Exact terminal update consumed by an Agent; ordinary UI reads do not acknowledge it. */
  agentObservedUpdate?: string;
  /** Persisted across restarts so one generation can consume at most one OOM retry. */
  oomRetryCount?: number;
};
type Engine = Pick<
  ComfyWorkflowEngine,
  'validate' | 'snapshotFingerprint' | 'ensureStarted' | 'generate' | 'resume' | 'cancel' | 'stopOwned'
> & {
  /** Resolves an identity shared by all ComfyUI endpoints on the same device. */
  runtimeResourceKey?: (profile: ComfyProfile) => Promise<string>;
  /** Resolves only after the selected Comfy runtime is confirmed idle and memory release is observed. */
  clearMemory?: (profile: ComfyProfile, reason: ComfyCleanupReason, signal: AbortSignal) => Promise<void>;
};
export type ComfyServiceOptions = {
  filename: string;
  engine: Engine;
  prepareWorkflows?: (profile: ComfyProfile, profiles: ComfyProfile[]) => ComfyPreparedWorkflows;
  checkPlan?: (plan: ComfyInstallPlan) => void;
  /**
   * Build an immutable plan from a model-card identity after probing this
   * machine. The callback runs in the media service process so the model
   * cannot inject paths, commands, or unverified sources into an install.
   */
  preparePlan?: (
    requestId: string,
    request: ComfyInstallIdentityRequest,
    profiles: ComfyProfile[],
    context?: ComfyInstallPlanningContext
  ) => ComfyInstallPlan | Promise<ComfyInstallPlan>;
  /** Incrementally inspect known roots and instances; discovery never grants verification. */
  discover?: ((profiles: ComfyProfile[]) => Promise<ComfyProfile[]>) & {
    diagnostics?: () => ComfyInventoryDiagnostic[];
    lightweight?: (profiles: ComfyProfile[]) => Promise<ComfyProfile[]>;
  };
  install: (plan: ComfyInstallPlan, signal: AbortSignal, progress: (detail: string) => void) => Promise<ComfyProfile>;
  probe?: typeof probeComfyEnvironment;
  verifyArtifact?: typeof verifyComfySmokeArtifact;
  runtimeCoordinator?: ComfyRuntimeCoordinator;
  /** Read the active runtime's observed approval mode; never trust model input or a cached binding. */
  resolveApproval?: (conversationId: string) => Promise<ComfyApprovalDecision>;
};
function clone<T>(value: T): T {
  return structuredClone(value);
}
function recipe(profile: ComfyProfile): string {
  const { state: _state, validation: _validation, ...value } = profile;
  return JSON.stringify(value);
}
function assertRepairModel(original: ComfyProfile, candidate: ComfyProfile): void {
  assertSameComfyModel(resolveComfyModelFiles(original), resolveComfyModelFiles(candidate));
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function diagnosis(error: unknown): ComfyDiagnosis | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('diagnosis' in error) return error.diagnosis as ComfyDiagnosis;
  if ('cause' in error) return diagnosis(error.cause);
  return undefined;
}
function remoteTerminal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('remoteTerminal' in error && error.remoteTerminal === true) return true;
  return 'cause' in error && remoteTerminal(error.cause);
}
function diagnosticLogPath(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if (
    'diagnosticLogPath' in error &&
    typeof error.diagnosticLogPath === 'string' &&
    path.isAbsolute(error.diagnosticLogPath)
  )
    return error.diagnosticLogPath;
  if ('cause' in error) return diagnosticLogPath(error.cause);
  return undefined;
}
function assertFamily(profile: Pick<ComfyProfile, 'family' | 'kind'>): void {
  if (profile.kind !== comfyFamilyKind(profile.family, profile.kind)) throw new Error('COMFY_FAMILY_KIND_MISMATCH');
}
function hardware(report: ComfyEnvironmentReport): string {
  return JSON.stringify({
    os: report.machine.os,
    arch: report.machine.arch,
    memory: report.machine.totalMemoryBytes,
    gpus: report.machine.gpus.map(({ freeMemoryBytes: _free, ...gpu }) => gpu),
  });
}
function assertDetection(report: ComfyEnvironmentReport, plan: ComfyInstallPlan): void {
  const { machine } = report;
  const cpu =
    report.runtime.status === 'available' &&
    report.runtime.accelerator === 'cpu' &&
    Boolean(report.runtime.packages.torch) &&
    plan.environment.launchArgs?.includes('--cpu');
  const missing: string[] = [];
  if (!machine.os) missing.push('os');
  if (!machine.arch) missing.push('architecture');
  if (!(machine.totalMemoryBytes > 0)) missing.push('ram-total');
  if (!(machine.freeMemoryBytes >= 0)) missing.push('ram-free');
  if (!machine.disk || !(machine.disk.freeBytes >= 0)) missing.push('disk-free');
  if (!cpu) {
    if (machine.gpuStatus !== 'available' || !machine.gpus.length) missing.push('gpu');
    machine.gpus.forEach((gpu, index) => {
      if (gpu.vendor === 'unknown') missing.push(`gpu-${index}-vendor`);
      if (gpu.vendor === 'nvidia' || gpu.vendor === 'amd') {
        if (!gpu.driver) missing.push(`gpu-${index}-driver`);
        if (!(Number(gpu.totalMemoryBytes) > 0)) missing.push(`gpu-${index}-vram-total`);
        if (!(Number(gpu.freeMemoryBytes) >= 0)) missing.push(`gpu-${index}-vram-free`);
      }
      if (gpu.vendor === 'nvidia' && !gpu.computeCapability) missing.push(`gpu-${index}-compute-capability`);
    });
  }
  if (missing.length || !machine.disk) throw new Error(`COMFY_DETECTION_INCOMPLETE:${missing.join(',')}`);
  if (
    /nvfp4/i.test(
      [plan.quantization, ...plan.components.map((component) => `${component.precision} ${component.name}`)].join(' ')
    )
  ) {
    const nvidia = machine.gpus.filter((gpu) => gpu.vendor === 'nvidia');
    if (!nvidia.length || nvidia.every((gpu) => Number(gpu.computeCapability) < 10))
      throw new Error('COMFY_DEVICE_CONDITIONS_INSUFFICIENT:NVFP4_REQUIRES_BLACKWELL');
    // Multi-device selection and unrecognized future architectures need explicit kernel/device evidence.
    // Known Blackwell CUDA capabilities: https://developer.nvidia.com/cuda/gpus
    if (nvidia.some((gpu) => !['10.0', '10.3', '12.0', '12.1'].includes(gpu.computeCapability ?? '')))
      throw new Error('COMFY_DETECTION_INCOMPLETE:NVFP4_SELECTED_BLACKWELL_DEVICE');
  }
  if (machine.disk.freeBytes < plan.requiredBytes) throw new Error('COMFY_DISK_SPACE_INSUFFICIENT');
}

/** Durable, conversation-scoped installation consent and immutable generation snapshots. */
export class ComfyService {
  private catalog = new Map<string, ComfyProfile>();
  private bindings = new Map<string, ComfySelection>();
  /** In-flight callback guards only; validated adoption does not change the user's request. */
  private continuationSelections = new Map<string, { requestId?: string }>();
  /** Linked installation/repair requests retain their parent selection; keep the persisted legacy key. */
  private repairParents = new Map<string, ComfySelection>();
  private operations = new Map<string, ComfyOperation>();
  /** Exact terminal versions consumed by an Agent; never exposed in operation snapshots. */
  private operationObservations = new Map<string, string>();
  private preparations = new Map<string, ComfyInstallPreparation>();
  private jobs = new Map<string, SavedJob>();
  /** Verified adoption receipts link only the failed attempts observed before that repair validation. */
  private repairAdoptions = new Map<string, RepairAdoption>();
  private probes = new Map<string, string>();
  private operationScopes = new Map<string, ComfySelection>();
  private failures = new Map<string, { error: string; count: number }>();
  private controllers = new Map<string, AbortController>();
  private pending = new Set<Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  private cancelledConversations = new Set<string>();
  private validating = false;
  private closing = false;
  private refreshing?: Promise<ComfyProfile[]>;
  private activityKnown = true;
  private inventoryDiagnostics: ComfyInventoryDiagnostic[] = [];
  private inventoryCheckedAt?: string;
  private workflowPreparations = new Map<string, NonNullable<ComfyInventory['workflowPreparations']>>();
  constructor(private options: ComfyServiceOptions) {
    fs.mkdirSync(path.dirname(options.filename), { recursive: true });
    if (!fs.existsSync(options.filename)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(options.filename, 'utf8')) as {
        profiles: unknown[];
        bindings: unknown[];
        operations: ComfyOperation[];
        operationObservations?: Array<[string, string]>;
        preparations?: ComfyInstallPreparation[];
        jobs: SavedJob[];
        repairAdoptions?: RepairAdoption[];
        probes?: Array<[string, string]>;
        operationScopes?: Array<[string, ComfySelection]>;
        failures?: Array<[string, { error: string; count: number }]>;
        cancelledConversations?: string[];
        repairParents?: Array<[string, ComfySelection]>;
      };
      for (const value of saved.profiles) {
        const profile = comfyProfileSchema.parse(value);
        this.catalog.set(profile.id, profile);
      }
      for (const value of saved.bindings) {
        const scope = bindingSchema.parse(value);
        this.bindings.set(scope.requestId, scope);
      }
      for (const [childId, parent] of saved.repairParents ?? []) {
        const snapshot = bindingSchema.parse(parent);
        const child = this.bindings.get(uuid.parse(childId));
        if (
          !child ||
          child.intent === 'generate' ||
          child.source !== 'local' ||
          child.conversationId !== snapshot.conversationId
        )
          throw new Error('COMFY_REPAIR_SCOPE_MISMATCH');
        this.repairParents.set(childId, snapshot);
      }
      for (const value of saved.operations) {
        uuid.parse(value.id);
        comfyInstallPlanSchema.parse(value.plan);
        this.operations.set(value.id, { ...value, state: value.state === 'running' ? 'paused' : value.state });
      }
      for (const [id, updatedAt] of z
        .array(z.tuple([uuid, z.string().min(1)]))
        .parse(saved.operationObservations ?? []))
        this.operationObservations.set(id, updatedAt);
      for (const value of saved.preparations ?? []) {
        uuid.parse(value.requestId);
        if (this.bindings.get(value.requestId)?.conversationId !== value.conversationId)
          throw new Error('COMFY_PREPARATION_SCOPE_MISMATCH');
        this.preparations.set(value.requestId, {
          ...value,
          status: value.status === 'detecting' ? 'interrupted' : value.status,
        });
      }
      for (const value of saved.jobs) {
        uuid.parse(value.id);
        comfyProfileSchema.parse(value.profile);
        validateComfyGenerationInputForFamily(value.profile.family, value.input);
        this.jobs.set(
          value.id,
          value.status === 'running'
            ? {
                ...value,
                status: value.promptId ? 'queued' : 'failed',
                ...(value.promptId ? {} : { error: 'COMFY_SUBMISSION_STATE_UNKNOWN', submissionUncertain: true }),
              }
            : value
        );
      }
      for (const receipt of z.array(repairAdoptionSchema).parse(saved.repairAdoptions ?? []))
        this.repairAdoptions.set(receipt.jobId, receipt);
      this.probes = new Map(saved.probes ?? []);
      this.cancelledConversations = new Set(saved.cancelledConversations ?? []);
      this.operationScopes = new Map(saved.operationScopes ?? []);
      this.failures = new Map(saved.failures ?? []);
    } catch (error) {
      // Keep the original manifest intact: corrupt consent must never start an operation.
      this.activityKnown = false;
      fs.copyFileSync(options.filename, `${options.filename}.corrupt-${Date.now()}`, fs.constants.COPYFILE_EXCL);
      this.catalog.clear();
      this.bindings.clear();
      this.repairParents.clear();
      this.operations.clear();
      this.operationObservations.clear();
      this.preparations.clear();
      this.jobs.clear();
      this.repairAdoptions.clear();
      this.probes.clear();
      console.error('[comfy] COMFY_STATE_RECOVERY_FAILED', error);
    }
    // A failed write is not evidence that the state we successfully read is corrupt.
    this.flush();
  }
  private flush(): void {
    const temporary = `${this.options.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify(
          {
            profiles: [...this.catalog.values()],
            bindings: [...this.bindings.values()],
            repairParents: [...this.repairParents],
            operations: [...this.operations.values()],
            operationObservations: [...this.operationObservations],
            preparations: [...this.preparations.values()],
            jobs: [...this.jobs.values()],
            repairAdoptions: [...this.repairAdoptions.values()],
            probes: [...this.probes],
            operationScopes: [...this.operationScopes],
            failures: [...this.failures],
            cancelledConversations: [...this.cancelledConversations],
          },
          null,
          2
        ),
        { flag: 'wx', mode: 0o600 }
      );
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(temporary, this.options.filename);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 5)
            throw error;
          // Retry only the completed replacement; never unlink committed profiles or consent.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
        }
      }
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Preserve the original persistence error when temporary cleanup also fails.
      }
    }
  }
  private scope(requestId: string): ComfySelection {
    uuid.parse(requestId);
    const scope = this.bindings.get(requestId);
    if (!scope || this.cancelledConversations.has(scope.conversationId))
      throw new Error('COMFY_CONVERSATION_UNAVAILABLE');
    const parent = this.repairParents.get(requestId);
    if (parent && !sameSelection(this.bindings.get(parent.requestId), parent))
      throw new Error('COMFY_SELECTION_CHANGED');
    return scope;
  }
  bind(input: unknown): void {
    const value = bindingSchema.parse(input),
      prior = this.bindings.get(value.requestId);
    if (this.repairParents.has(value.requestId)) throw new Error('COMFY_REPAIR_SCOPE_IMMUTABLE');
    if (prior && prior.conversationId !== value.conversationId) throw new Error('COMFY_CONVERSATION_MISMATCH');
    if (this.cancelledConversations.has(value.conversationId)) throw new Error('COMFY_CONVERSATION_UNAVAILABLE');
    const profile = value.profileId ? this.catalog.get(value.profileId) : undefined;
    if (value.profileId && !profile) throw new Error('COMFY_PROFILE_NOT_FOUND');
    if (profile && value.family && profile.family !== value.family) throw new Error('COMFY_FAMILY_MISMATCH');
    if (profile && value.modelConstraint && value.modelConstraint.modelSetId !== getComfyModelSetId(profile))
      throw new Error('COMFY_MODEL_CONSTRAINT_MISMATCH');
    const next: ComfySelection = {
      ...value,
      templateSnapshot: value.templateSnapshot ?? prior?.templateSnapshot,
      family: value.family ?? profile?.family,
      source: value.source ?? (value.family || profile ? 'local' : prior?.source),
      kind: value.kind ?? profile?.kind ?? (value.family ? comfyFamilyKind(value.family) : prior?.kind),
    };
    const continuation = this.continuationSelections.get(value.conversationId);
    if (!sameSelection(prior, next) || (continuation?.requestId && continuation.requestId !== value.requestId))
      this.continuationSelections.set(value.conversationId, { requestId: value.requestId });
    else if (continuation) continuation.requestId = value.requestId;
    this.bindings.set(value.requestId, next);
    this.flush();
  }
  selection(requestId: string): ComfySelection {
    return clone(this.scope(requestId));
  }
  /** Give plain-chat installations a persistent scope without changing any user-selected generation target. */
  conversationInstallationRequest(conversationId: string): string {
    const conversation = z.string().trim().min(1).parse(conversationId);
    if (this.cancelledConversations.has(conversation)) throw new Error('COMFY_CONVERSATION_UNAVAILABLE');
    const existing = [...this.bindings.values()].find(
      (scope) => scope.conversationId === conversation && !scope.family && !scope.source
    );
    if (existing) return existing.requestId;
    const requestId = crypto.randomUUID();
    this.bindings.set(requestId, bindingSchema.parse({ requestId, conversationId: conversation }));
    this.flush();
    return requestId;
  }
  /** Keep each Agent-selected model scoped to this conversation without creating a UI model selection. */
  conversationGenerationRequest(conversationId: string, profileId: string): string {
    const conversation = z.string().trim().min(1).parse(conversationId);
    if (this.cancelledConversations.has(conversation)) throw new Error('COMFY_CONVERSATION_UNAVAILABLE');
    const existing = [...this.bindings.values()].find(
      (scope) =>
        scope.origin === 'conversation' && scope.conversationId === conversation && scope.profileId === profileId
    );
    if (existing) return existing.requestId;
    const profile = this.profile(profileId);
    const requestId = crypto.randomUUID();
    this.bindings.set(
      requestId,
      bindingSchema.parse({
        requestId,
        conversationId: conversation,
        profileId,
        family: profile.family,
        kind: profile.kind,
        source: 'local',
        intent: 'generate',
        workflowMode: 'auto',
        origin: 'conversation',
      })
    );
    this.flush();
    return requestId;
  }
  /** Plain-chat resolution inspects the Agent's chosen model without persisting a selection or starting work. */
  resolveConversationWorkflow(conversationId: string, profileId: string, input: unknown) {
    const conversation = z.string().trim().min(1).parse(conversationId);
    if (this.cancelledConversations.has(conversation)) throw new Error('COMFY_CONVERSATION_UNAVAILABLE');
    return this.resolveProfileWorkflow(this.profile(profileId), input, 'auto');
  }
  /** Watch authoritative user binding changes during one callback send, without treating repair progress as cancellation. */
  captureContinuationSelection(requestId: string, conversationId: string): () => boolean {
    const scope = this.bindings.get(requestId);
    if (!scope || scope.conversationId !== conversationId) return () => false;
    // A persisted old event cannot nominate the active request after restart.
    // Until a real bind arrives, the worker's conversation read checks its request ID.
    const captured = this.continuationSelections.get(conversationId) ?? {};
    this.continuationSelections.set(conversationId, captured);
    return () =>
      (!captured.requestId || captured.requestId === requestId) &&
      this.continuationSelections.get(conversationId) === captured &&
      !this.cancelledConversations.has(conversationId);
  }
  /** Adopt a real, validated workflow variant while retaining the user's selected model and precision. */
  async adoptRepairedProfile(requestId: string, profileId: string, jobId: string): Promise<ComfySelection> {
    const scope = clone(this.scope(requestId));
    if (scope.source !== 'local' || scope.intent !== 'generate' || !scope.profileId)
      throw new Error('COMFY_GENERATION_INTENT_REQUIRED');
    const original = clone(this.profile(scope.profileId));
    const candidate = clone(this.profile(profileId));
    const job = this.jobs.get(jobId);
    const adopted = this.repairAdoptions.get(jobId);
    if (
      adopted &&
      job?.requestId === requestId &&
      job.profileId === profileId &&
      job.status === 'succeeded' &&
      (sameSelection(scope, adopted.selection) || sameSelection(scope, { ...adopted.selection, profileId }))
    )
      return this.selection(requestId);
    if (
      !job ||
      job.requestId !== requestId ||
      job.profileId !== profileId ||
      !job.verify ||
      job.status !== 'succeeded' ||
      job.submissionUncertain ||
      job.observationOnly ||
      !job.artifacts.length ||
      candidate.state !== 'verified' ||
      !candidate.validation?.fingerprint ||
      candidate.validation.promptId !== job.promptId ||
      recipe(candidate) !== recipe(job.profile)
    )
      throw new Error('COMFY_INSTALL_VALIDATION_REQUIRED');
    if (!sameSelection(job.selectionAtSubmission, scope)) throw new Error('COMFY_SELECTION_CHANGED');
    assertRepairModel(original, candidate);
    const assertCurrent = (): void => {
      if (
        !sameSelection(this.scope(requestId), scope) ||
        recipe(this.profile(original.id)) !== recipe(original) ||
        JSON.stringify(this.profile(profileId)) !== JSON.stringify(candidate)
      )
        throw new Error('COMFY_SELECTION_CHANGED');
      if (this.closing) throw new Error('COMFY_SERVICE_STOPPING');
      if (
        [...this.jobs.values()].some(
          (item) =>
            this.isRequestRelated(item.requestId, requestId) &&
            (['queued', 'running'].includes(item.status) || item.submissionUncertain)
        ) ||
        [...this.operations.values()].some(
          (item) =>
            this.isRequestRelated(item.requestId, requestId) &&
            !['failed', 'completed', 'cancelled'].includes(item.state)
        )
      )
        throw new Error('COMFY_RUNTIME_BUSY');
    };
    assertCurrent();
    if ((await this.options.engine.snapshotFingerprint(candidate)) !== candidate.validation.fingerprint)
      throw new Error('COMFY_PROFILE_CHANGED');
    assertCurrent();
    const jobs = [...this.jobs.values()];
    const failedJobs = jobs
      .slice(
        0,
        jobs.findIndex((item) => item.id === jobId)
      )
      .flatMap((failed) => {
        if (
          failed.requestId !== requestId ||
          failed.status !== 'failed' ||
          failed.submissionUncertain ||
          failed.observationOnly ||
          !sameSelection(failed.selectionAtSubmission, scope)
        )
          return [];
        try {
          assertRepairModel(failed.profile, candidate);
          return [{ id: failed.id, updatedAt: failed.updatedAt }];
        } catch {
          return [];
        }
      });
    this.repairAdoptions.set(jobId, {
      selection: bindingSchema.parse(scope),
      jobId,
      updatedAt: job.updatedAt,
      failedJobs,
    });
    this.bindings.set(
      requestId,
      scope.workflowMode === 'auto' || scope.modelConstraint?.workflowMode === 'auto' ? scope : { ...scope, profileId }
    );
    this.flush();
    return this.selection(requestId);
  }
  profiles(): ComfyProfile[] {
    return [...this.catalog.values()].map(clone);
  }
  recordProgressProfile(input: ComfyProfile): void {
    const profile = comfyProfileSchema.parse(input);
    if (profile.state === 'verified') throw new Error('COMFY_VERIFICATION_REQUIRED');
    this.catalog.set(profile.id, clone(profile));
    this.flush();
  }
  register(input: unknown): ComfyProfile {
    const parsed = resolveComfyModelFiles(comfyProfileSchema.parse(input)),
      prior = this.catalog.get(parsed.id);
    assertFamily(parsed);
    if (prior && recipe(prior) !== recipe(parsed)) throw new Error('COMFY_PROFILE_ID_CONFLICT');
    if (prior) return clone(prior);
    const profile: ComfyProfile = {
      ...parsed,
      state: parsed.state === 'invalid' ? 'invalid' : 'downloaded',
      validation:
        parsed.state === 'invalid'
          ? {
              fingerprint: '',
              checkedAt: new Date().toISOString(),
              error: parsed.validation?.error ?? 'COMFY_REVALIDATION_REQUIRED',
            }
          : undefined,
    };
    this.catalog.set(profile.id, profile);
    this.prepareWorkflows(profile.id);
    this.flush();
    return clone(this.profile(profile.id));
  }
  private profile(id: string): ComfyProfile {
    const profile = this.catalog.get(id);
    if (!profile) throw new Error('COMFY_PROFILE_NOT_FOUND');
    return profile;
  }
  async refreshProfiles(): Promise<ComfyProfile[]> {
    if (this.refreshing) return this.refreshing;
    const pending = this.refreshProfileCatalog();
    this.refreshing = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = undefined;
    }
  }
  private async refreshProfileCatalog(): Promise<ComfyProfile[]> {
    this.inventoryDiagnostics = [];
    this.inventoryCheckedAt = new Date().toISOString();
    if (this.options.discover && !this.closing) {
      try {
        const discovered = await this.options.discover(this.profiles());
        this.inventoryDiagnostics = this.options.discover.diagnostics?.() ?? [];
        for (const profile of discovered) {
          try {
            this.register(profile);
          } catch (error) {
            // One changed or incomplete installation must not hide other environments.
            console.warn('[comfy] profile discovery rejected', { profileId: profile.id, error: message(error) });
            this.inventoryDiagnostics.push({
              code: 'COMFY_INVENTORY_PROFILE_REJECTED',
              path: profile.environment.root,
            });
          }
        }
      } catch (error) {
        console.warn('[comfy] profile discovery failed', { error: message(error) });
        this.inventoryDiagnostics.push({
          code: message(error).match(/^COMFY_[A-Z_]+/)?.[0] ?? 'COMFY_INVENTORY_UNAVAILABLE',
        });
        if (!this.catalog.size) throw new Error('COMFY_INVENTORY_UNAVAILABLE', { cause: error });
      }
    }
    for (const profile of this.catalog.values()) {
      if (profile.state !== 'verified') continue;
      try {
        const fingerprint = await this.options.engine.snapshotFingerprint(clone(profile));
        if (fingerprint !== profile.validation?.fingerprint) throw new Error('COMFY_PROFILE_CHANGED');
      } catch (error) {
        // A stopped server is not a change. Generation starts it and verifies its actual identity.
        if (message(error) === 'COMFY_SERVER_UNAVAILABLE') continue;
        profile.state = 'invalid';
        profile.validation = {
          fingerprint: profile.validation?.fingerprint ?? '',
          checkedAt: new Date().toISOString(),
          error: message(error),
        };
        this.flush();
      }
    }
    if (this.options.prepareWorkflows) {
      for (const profile of this.profiles()) this.prepareWorkflows(profile.id);
    }
    return this.profiles();
  }
  inventory(): ComfyInventory {
    return {
      profiles: this.profiles(),
      complete: this.inventoryDiagnostics.length === 0,
      diagnostics: clone(this.inventoryDiagnostics),
      checkedAt: this.inventoryCheckedAt,
      workflowPreparations: [...this.workflowPreparations.values()].flat(),
    };
  }
  /** Lightweight library refresh: never starts a runtime or asks the engine to import Python. */
  async modelCenter(directory?: string): Promise<LocalModelCenterSnapshot> {
    if (directory !== undefined && (!directory.trim() || !path.isAbsolute(directory)))
      throw new Error('COMFY_INSTALL_DIRECTORY_ABSOLUTE_REQUIRED');
    const inventory = this.inventory();
    const registeredProfileIds = inventory.profiles.map((profile) => profile.id);
    inventory.checkedAt = new Date().toISOString();
    if (this.options.discover?.lightweight && !this.closing) {
      try {
        const discovered = await this.options.discover.lightweight(inventory.profiles);
        inventory.diagnostics = this.options.discover.diagnostics?.() ?? [];
        for (const value of discovered) {
          const profile = comfyProfileSchema.safeParse(value);
          if (!profile.success) {
            inventory.diagnostics.push({ code: 'COMFY_INVENTORY_PROFILE_REJECTED' });
            continue;
          }
          // Discovery is an ephemeral display snapshot; only explicit registration changes the registry.
          if (!inventory.profiles.some((saved) => saved.id === profile.data.id))
            inventory.profiles.push({ ...profile.data, state: 'downloaded', validation: undefined });
        }
      } catch (error) {
        inventory.diagnostics.push({
          code: message(error).match(/^COMFY_[A-Z_]+/)?.[0] ?? 'COMFY_INVENTORY_UNAVAILABLE',
        });
      }
    }
    inventory.complete = inventory.diagnostics.length === 0;
    return readLocalModelCenter(
      {
        dataDir: path.dirname(this.options.filename),
        inventory: () => inventory,
        registeredProfileIds,
        activities: [
          ...[...this.operations.values()]
            .filter(
              (item) => activeModelCenterActivity(item.state) && !this.cancelledConversations.has(item.conversationId)
            )
            .map((item) => ({
              family: item.plan.family,
              profileId: item.profileId,
              candidateId: item.installRequest?.installContext?.candidateId,
              conversationId: item.conversationId,
              state: item.state,
              updatedAt: item.updatedAt,
            })),
          ...[...this.preparations.values()]
            .filter((item) => item.status === 'detecting' && !this.cancelledConversations.has(item.conversationId))
            .map((item) => ({
              family: item.family,
              conversationId: item.conversationId,
              state: item.status,
              updatedAt: item.updatedAt,
            })),
        ],
      },
      directory
    );
  }
  async revalidate(id: string, input?: unknown): Promise<ComfyProfile> {
    const profile = clone(this.profile(id));
    if (this.pending.size || this.validating) throw new Error('COMFY_RUNTIME_BUSY');
    this.validating = true;
    const signal = new AbortController().signal;
    try {
      const checked = await this.options.engine.validate(profile);
      const loadable: ComfyProfile = {
        ...profile,
        state: 'loadable',
        validation: {
          fingerprint: checked.fingerprint,
          checkedAt: new Date().toISOString(),
          ...('runtime' in checked ? { runtime: checked.runtime } : {}),
        },
      };
      this.catalog.set(id, loadable);
      this.flush();
      if (input === undefined) return clone(loadable);
      const result = await this.options.engine.generate(
        loadable,
        validateComfyGenerationInputForFamily(loadable.family, input),
        signal
      );
      if (!result.artifacts.some((artifact) => artifact.mimeType.startsWith(`${profile.kind}/`)))
        throw new Error('COMFY_SMOKE_OUTPUT_MISSING');
      for (const artifact of result.artifacts.filter((artifact) => artifact.mimeType.startsWith(`${profile.kind}/`)))
        await (this.options.verifyArtifact ?? verifyComfySmokeArtifact)(artifact, profile.kind, signal, {
          profile,
          input: validateComfyGenerationInputForFamily(loadable.family, input),
        });
      const current = await this.options.engine.snapshotFingerprint(loadable);
      if (current !== checked.fingerprint) throw new Error('COMFY_PROFILE_CHANGED');
      const verified: ComfyProfile = {
        ...loadable,
        state: 'verified',
        validation: {
          ...loadable.validation!,
          promptId: result.promptId,
          artifacts: result.artifacts.map((artifact) => artifact.path),
        },
      };
      this.catalog.set(id, verified);
      this.flush();
      return clone(verified);
    } catch (error) {
      this.catalog.set(id, {
        ...profile,
        state: 'invalid',
        validation: { fingerprint: '', checkedAt: new Date().toISOString(), error: message(error) },
      });
      this.flush();
      throw error;
    } finally {
      this.validating = false;
    }
  }
  /** Adopt only this request's successfully validated profile into the normal model-card UI. */
  async completeAgentInstallation(requestId: string, jobId: string): Promise<ComfyOperation> {
    this.scope(requestId);
    const saved = this.jobs.get(jobId);
    if (saved && this.isRequestRelated(saved.requestId, requestId)) requestId = saved.requestId;
    const scope = clone(this.scope(requestId));
    if (scope.source !== 'local' || scope.intent === 'generate') throw new Error('COMFY_INSTALL_INTENT_REQUIRED');
    if (
      !saved ||
      saved.requestId !== requestId ||
      !saved.verify ||
      saved.status !== 'succeeded' ||
      saved.submissionUncertain
    )
      throw new Error('COMFY_INSTALL_VALIDATION_REQUIRED');
    if (
      [...this.operations.values()].some(
        (item) => item.requestId === requestId && !['failed', 'completed', 'cancelled'].includes(item.state)
      )
    )
      throw new Error('COMFY_EXISTING_OPERATION_ACTIVE');
    const profile = clone(this.profile(saved.profileId));
    const prior = [...this.operations.values()].find(
      (item) => item.execution === 'agent' && item.requestId === requestId && item.validationJobId === jobId
    );
    if (
      (scope.intent === 'repair' || saved.selectionAtSubmission?.intent === 'repair') &&
      (!saved.selectionAtSubmission ||
        (!sameSelection(scope, saved.selectionAtSubmission) &&
          !(
            prior?.state === 'completed' &&
            prior.profileId === profile.id &&
            sameSelection(scope, { ...saved.selectionAtSubmission, profileId: profile.id })
          )))
    )
      throw new Error('COMFY_SELECTION_CHANGED');
    if (
      profile.family !== scope.family ||
      (scope.intent !== 'repair' && scope.profileId && scope.profileId !== profile.id)
    )
      throw new Error('COMFY_FAMILY_MISMATCH');
    const original = scope.intent === 'repair' && scope.profileId ? clone(this.profile(scope.profileId)) : undefined;
    if (original) assertRepairModel(original, profile);
    if (prior?.state === 'completed') return clone(prior);
    if (
      profile.state !== 'verified' ||
      !profile.validation?.fingerprint ||
      profile.validation.promptId !== saved.promptId ||
      recipe(profile) !== recipe(saved.profile) ||
      !saved.artifacts.length
    )
      throw new Error('COMFY_INSTALL_VALIDATION_REQUIRED');
    if (resolveComfyModelFiles(profile).components.some((component) => !component.sha256 || !component.sizeBytes))
      throw new Error('COMFY_COMPONENT_IDENTITY_REQUIRED');
    const fingerprint = await this.options.engine.snapshotFingerprint(profile);
    const currentProfile = this.profile(profile.id);
    if (
      fingerprint !== profile.validation.fingerprint ||
      recipe(currentProfile) !== recipe(profile) ||
      currentProfile.state !== 'verified' ||
      currentProfile.validation?.fingerprint !== fingerprint ||
      currentProfile.validation?.promptId !== saved.promptId
    )
      throw new Error('COMFY_PROFILE_CHANGED');
    if (
      !sameSelection(this.scope(requestId), scope) ||
      (original && recipe(this.profile(original.id)) !== recipe(original))
    )
      throw new Error('COMFY_SELECTION_CHANGED');
    if (this.closing) throw new Error('COMFY_SERVICE_STOPPING');
    if (
      [...this.operations.values()].some(
        (item) => item.requestId === requestId && !['failed', 'completed', 'cancelled'].includes(item.state)
      )
    )
      throw new Error('COMFY_EXISTING_OPERATION_ACTIVE');
    const completed = [...this.operations.values()].find(
      (item) => item.execution === 'agent' && item.requestId === requestId && item.validationJobId === jobId
    );
    if (completed) return clone(completed);
    const workflowSource = fs.readFileSync(profile.workflowPath, 'utf8');
    const workflowSha256 = crypto.createHash('sha256').update(workflowSource).digest('hex');
    if (profile.workflowSha256 && profile.workflowSha256 !== workflowSha256) throw new Error('COMFY_PROFILE_CHANGED');
    const plan = comfyInstallPlanSchema.parse({
      ...profile,
      targetRoot: profile.environment.root,
      workflow: JSON.parse(workflowSource),
      workflowSource,
      workflowSha256,
      commands: [],
      downloadBytes: 0,
      requiredBytes: 0,
      reason: 'Agent installation completed and validated on this device',
      evidence: ['execution:agent', `validation-job:${jobId}`, `runtime-fingerprint:${fingerprint}`],
      smokeInput: saved.input,
      repair: scope.intent === 'repair',
    });
    const superseded = [...this.operations.values()].find(
      (item) => item.requestId === requestId && item.state === 'failed'
    );
    const operation: ComfyOperation = {
      id: superseded?.id ?? crypto.randomUUID(),
      requestId,
      conversationId: scope.conversationId,
      state: 'completed',
      execution: 'agent',
      validationJobId: jobId,
      plan,
      profileId: profile.id,
      progress: 'verified',
      updatedAt: new Date().toISOString(),
      ...(superseded?.snapshotDirectory ? { snapshotDirectory: superseded.snapshotDirectory } : {}),
    };
    this.operations.set(operation.id, operation);
    this.bindings.set(requestId, { ...scope, profileId: profile.id });
    this.flush();
    this.prepareWorkflows(profile.id);
    return clone(operation);
  }
  async request(requestId: string, input: unknown): Promise<ComfyOperation> {
    if (this.closing) throw new Error('COMFY_SERVICE_STOPPING');
    // Existing internal callers pass the plan directly. Keep that contract
    // while accepting the new identity-only request from the MCP tool.
    const parsed = comfyInstallRequestSchema.safeParse(input);
    const installRequest: ComfyInstallRequest = parsed.success
      ? (parsed.data as ComfyInstallRequest)
      : ({ action: 'request', plan: comfyInstallPlanSchema.parse(input) } as const);
    const scope = clone(this.scope(requestId));
    const identity = 'family' in installRequest ? installRequest : undefined;
    if (identity && scope.installContext) identity.installContext = clone(scope.installContext);
    if (identity?.intent === 'repair' && scope.intent === 'generate') {
      if (identity.requestId && identity.requestId !== requestId) throw new Error('COMFY_REQUEST_MISMATCH');
      if ((scope.source || scope.family) && (scope.source !== 'local' || scope.family !== identity.family))
        throw new Error('COMFY_FAMILY_MISMATCH');
      if (identity.profileId && scope.profileId && identity.profileId !== scope.profileId)
        throw new Error('COMFY_PROFILE_ID_MISMATCH');
      const profileId = scope.profileId ?? identity.profileId;
      if (!profileId) throw new Error('COMFY_PROFILE_REQUIRED');
      const child = this.linkInstallation(scope, { ...identity, profileId });
      return this.request(child, { ...identity, requestId: child, profileId });
    }
    if (
      identity &&
      identity.intent !== 'repair' &&
      (scope.source !== 'local' ||
        scope.family !== identity.family ||
        scope.intent !== identity.intent ||
        (identity.profileId && scope.profileId && identity.profileId !== scope.profileId))
    ) {
      if (identity.requestId && identity.requestId !== requestId) throw new Error('COMFY_REQUEST_MISMATCH');
      const child = this.linkInstallation(scope, identity);
      return this.request(child, { ...identity, requestId: child });
    }
    if (identity) this.assertInstallIdentity(requestId, identity);
    const inputKey = JSON.stringify(
      identity
        ? [
            identity.family,
            identity.intent,
            identity.profileId,
            identity.installContext?.installDirectory,
            identity.sourceOverrides ?? [],
          ]
        : installRequest
    );
    const key = identity ? requestId : JSON.stringify([requestId, inputKey]);
    const pending = this.requesting.get(key);
    if (pending) {
      if (pending.inputKey !== inputKey) throw new Error('COMFY_INSTALL_REQUEST_ID_CONFLICT');
      return clone(await pending.promise);
    }
    const request = (async () => {
      if (identity) {
        const previous = [...this.operations.values()].find(
          (operation) => operation.requestId === requestId && operation.installRequest
        );
        if (previous) {
          const saved = previous.installRequest!;
          if (
            saved.family !== identity.family ||
            saved.intent !== identity.intent ||
            saved.profileId !== identity.profileId ||
            saved.installContext?.installDirectory !== identity.installContext?.installDirectory
          )
            throw new Error('COMFY_INSTALL_REQUEST_ID_CONFLICT');
          if (JSON.stringify(saved.sourceOverrides ?? []) !== JSON.stringify(identity.sourceOverrides ?? []))
            throw new Error('COMFY_EXISTING_OPERATION_USE_RECOVER');
          return this.applyRequestApproval(previous);
        }
      }
      if (identity) {
        const prior = this.preparations.get(requestId);
        const changedSources = prior?.inputKey !== inputKey && Boolean(identity.sourceOverrides?.length);
        if (
          (prior?.attempts ?? 0) >= 3 ||
          (!changedSources && (prior?.attempts ?? 0) >= 2 && (prior?.repeatedErrors ?? 0) >= 2)
        )
          throw new Error('COMFY_REPEATED_ERROR_REPLAN');
        this.preparations.set(requestId, {
          requestId,
          conversationId: scope.conversationId,
          family: identity.family,
          intent: identity.intent,
          status: 'detecting',
          attempts: (prior?.attempts ?? 0) + 1,
          inputKey,
          repeatedErrors: changedSources ? 0 : (prior?.repeatedErrors ?? 0),
          error: prior?.error,
          updatedAt: new Date().toISOString(),
        });
        this.flush();
      }
      try {
        const plan = await this.resolveInstallPlan(requestId, installRequest);
        if (!sameSelection(this.scope(requestId), scope)) throw new Error('COMFY_SELECTION_CHANGED');
        return await this.requestPlan(requestId, plan, identity);
      } catch (error) {
        const preparation = this.preparations.get(requestId);
        if (preparation) {
          this.preparations.set(requestId, {
            ...preparation,
            status: 'failed',
            repeatedErrors: preparation.error === message(error) ? (preparation.repeatedErrors ?? 0) + 1 : 1,
            error: message(error),
            updatedAt: new Date().toISOString(),
          });
          this.flush();
        }
        throw error;
      }
    })();
    this.requesting.set(key, { inputKey, promise: request });
    try {
      return clone(await request);
    } finally {
      this.requesting.delete(key);
    }
  }
  /** A new explicit installation target must not rewrite the conversation's generation selection. */
  installationScope(
    requestId: string,
    family: ComfyProfile['family'],
    intent: 'install' | 'install-other',
    kind?: ComfyProfile['kind']
  ): string {
    const parent = this.scope(requestId);
    if (parent.source === 'local' && parent.family === family && parent.intent === intent) return requestId;
    return this.linkInstallation(parent, {
      action: 'request',
      family,
      intent,
      kind,
      installContext: parent.installContext,
    });
  }
  private linkInstallation(parent: ComfySelection, identity: ComfyInstallIdentityRequest): string {
    const selectedProfile = identity.profileId ? this.catalog.get(identity.profileId) : undefined;
    if (selectedProfile && selectedProfile.family !== identity.family) throw new Error('COMFY_FAMILY_MISMATCH');
    const existing = [...this.repairParents].find(([id, snapshot]) => {
      const child = this.bindings.get(id);
      const operation = [...this.operations.values()].find((item) => item.requestId === id && item.installRequest);
      const profileId = operation?.installRequest ? operation.installRequest.profileId : child?.profileId;
      return (
        sameSelection(snapshot, parent) &&
        child?.family === identity.family &&
        child.intent === identity.intent &&
        profileId === identity.profileId &&
        child.installContext?.installDirectory === identity.installContext?.installDirectory
      );
    });
    if (existing) return existing[0];
    const requestId = crypto.randomUUID();
    this.bindings.set(requestId, {
      requestId,
      conversationId: parent.conversationId,
      family: identity.family,
      intent: identity.intent,
      profileId: identity.profileId,
      installContext: identity.installContext,
      source: 'local',
      kind: comfyFamilyKind(identity.family, selectedProfile?.kind ?? identity.kind),
    });
    this.repairParents.set(requestId, clone(parent));
    this.flush();
    return requestId;
  }
  private async resolveInstallPlan(
    requestId: string,
    request: ComfyInstallRequest,
    context?: ComfyInstallPlanningContext
  ): Promise<ComfyInstallPlan> {
    if (request.action === 'plan' || 'plan' in request) {
      if ('requestId' in request && request.requestId && request.requestId !== requestId)
        throw new Error('COMFY_REQUEST_MISMATCH');
      return request.plan;
    }
    this.assertInstallIdentity(requestId, request);
    if (!this.options.preparePlan) throw new Error('COMFY_INSTALL_PLANNER_UNAVAILABLE');
    await this.refreshProfiles();
    const plan = comfyInstallPlanSchema.parse(
      await this.options.preparePlan(
        requestId,
        { ...request, installContext: this.scope(requestId).installContext ?? request.installContext },
        this.profiles(),
        context
      )
    );
    if (plan.family !== request.family) throw new Error('COMFY_FAMILY_MISMATCH');
    if (request.profileId && plan.id !== request.profileId) throw new Error('COMFY_PROFILE_ID_MISMATCH');
    return plan;
  }
  private assertInstallIdentity(requestId: string, request: ComfyInstallIdentityRequest): void {
    if (request.requestId && request.requestId !== requestId) throw new Error('COMFY_REQUEST_MISMATCH');
    const scope = this.scope(requestId);
    if (scope.source !== 'local' || scope.family !== request.family) throw new Error('COMFY_FAMILY_MISMATCH');
    if (scope.intent !== request.intent) throw new Error('COMFY_INSTALL_INTENT_MISMATCH');
    if (request.profileId && scope.profileId && request.profileId !== scope.profileId)
      throw new Error('COMFY_PROFILE_ID_MISMATCH');
  }
  private readonly requesting = new Map<string, { inputKey: string; promise: Promise<ComfyOperation> }>();
  private async requestPlan(
    requestId: string,
    plan: ComfyInstallPlan,
    installRequest?: ComfyInstallIdentityRequest
  ): Promise<ComfyOperation> {
    const scope = clone(this.scope(requestId));
    assertFamily(plan);
    this.options.checkPlan?.(plan);
    if (scope.source !== 'local' || !scope.family || scope.family !== plan.family)
      throw new Error('COMFY_FAMILY_MISMATCH');
    if (scope.intent === 'generate') throw new Error('COMFY_INSTALL_INTENT_REQUIRED');
    if (plan.repair && scope.intent !== 'repair') throw new Error('COMFY_REPAIR_INTENT_REQUIRED');
    const prior = [...this.operations.values()].find(
      (item) =>
        item.requestId === requestId && item.state !== 'cancelled' && JSON.stringify(item.plan) === JSON.stringify(plan)
    );
    if (prior) return this.applyRequestApproval(prior);
    if (
      [...this.operations.values()].filter((item) => !['completed', 'cancelled', 'failed'].includes(item.state))
        .length >= 200
    )
      throw new Error('COMFY_OPERATION_LIMIT');
    const existing = this.catalog.get(plan.id);
    if (existing && !plan.repair) {
      const {
        targetRoot: _root,
        downloadBytes: _download,
        requiredBytes: _required,
        reason: _reason,
        evidence: _evidence,
        workflow: _workflow,
        commands: _commands,
        smokeInput: _smoke,
        reuseOnlyPaths: _reuseOnlyPaths,
        workflowSource: _workflowSource,
        repair: _repair,
        ...candidate
      } = plan;
      if (recipe(existing) !== recipe({ ...candidate, state: 'downloaded' }))
        throw new Error('COMFY_PROFILE_ID_CONFLICT');
    }
    const report = await (this.options.probe ?? probeComfyEnvironment)({
      ...plan.environment,
      installDirectory: plan.targetRoot,
    });
    assertDetection(report, plan);
    if (!sameSelection(this.scope(requestId), scope)) throw new Error('COMFY_SELECTION_CHANGED');
    const operation: ComfyOperation = {
      id: crypto.randomUUID(),
      requestId,
      conversationId: scope.conversationId,
      plan: clone(plan),
      ...(installRequest ? { installRequest: clone(installRequest) } : {}),
      state: 'awaiting-consent',
      updatedAt: new Date().toISOString(),
    };
    this.operations.set(operation.id, operation);
    this.preparations.delete(requestId);
    this.probes.set(operation.id, hardware(report));
    this.operationScopes.set(operation.id, clone(scope));
    this.flush();
    return this.applyRequestApproval(operation);
  }
  private async applyRequestApproval(operation: ComfyOperation): Promise<ComfyOperation> {
    const resolve = this.options.resolveApproval;
    if (!resolve || !['awaiting-consent', 'authorized', 'paused'].includes(operation.state)) return clone(operation);
    let decision: ComfyApprovalDecision;
    try {
      decision = await resolve(operation.conversationId);
    } catch {
      this.updateOperation(operation.id, { error: 'COMFY_APPROVAL_MODE_UNAVAILABLE' });
      console.warn('[comfy] approval lookup unavailable', { operationId: operation.id, family: operation.plan.family });
      return this.operation(operation.id, { requestId: operation.requestId });
    }
    if (this.closing) throw new Error('COMFY_SERVICE_STOPPING');
    const current = this.operation(operation.id, { requestId: operation.requestId });
    if (!['awaiting-consent', 'authorized', 'paused'].includes(current.state)) return current;
    const approval = { ...decision, source: 'session' as const, checkedAt: new Date().toISOString() };
    this.updateOperation(operation.id, {
      approval,
      ...(current.error === 'COMFY_APPROVAL_MODE_UNAVAILABLE' ? { error: undefined } : {}),
    });
    if (decision.mode !== 'automatic') return this.operation(operation.id, { requestId: operation.requestId });
    if (!sameSelection(this.scope(operation.requestId), this.operationScopes.get(operation.id)))
      throw new Error('COMFY_SELECTION_CHANGED');
    this.authorize(operation.id, operation.conversationId, approval);
    return this.start(operation.id, operation.requestId);
  }
  private assertResourceScope(requestId: string, conversationId: string, scope: ComfyResourceScope): void {
    if (!scope?.requestId && !scope?.conversationId) throw new Error('COMFY_REQUEST_REQUIRED');
    if (scope.requestId) {
      uuid.parse(scope.requestId);
      if (!this.isRequestRelated(requestId, scope.requestId)) throw new Error('COMFY_REQUEST_MISMATCH');
    }
    if (scope.conversationId && scope.conversationId !== conversationId) throw new Error('COMFY_CONVERSATION_MISMATCH');
  }
  /** Include only installations/repairs derived from this request, never unrelated conversation work. */
  isRequestRelated(resourceRequestId: string, requestId: string): boolean {
    return resourceRequestId === requestId || this.repairParents.get(resourceRequestId)?.requestId === requestId;
  }
  private savedOperation(id: string): ComfyOperation {
    const value = this.operations.get(id);
    if (!value) throw new Error('COMFY_OPERATION_NOT_FOUND');
    return clone(value);
  }
  operation(id: string, scope: ComfyResourceScope): ComfyOperation {
    const value = this.savedOperation(id);
    this.assertResourceScope(value.requestId, value.conversationId, scope);
    return value;
  }
  /** Acknowledge only the exact terminal version explicitly observed through an Agent tool. */
  acknowledgeOperation(id: string, scope: ComfyResourceScope, updatedAt: string): boolean {
    const operation = this.operation(id, scope);
    if (!['completed', 'failed', 'cancelled'].includes(operation.state) || operation.updatedAt !== updatedAt)
      return false;
    if (this.operationObservations.get(id) !== updatedAt) {
      this.operationObservations.set(id, updatedAt);
      this.flush();
    }
    return true;
  }
  activity(conversationId: string): {
    operations: ComfyOperation[];
    jobs: ComfyGenerationJob[];
    preparations: ComfyInstallPreparation[];
  } {
    if (!conversationId) throw new Error('COMFY_CONVERSATION_REQUIRED');
    return {
      preparations: [...this.preparations.values()]
        .filter((preparation) => preparation.conversationId === conversationId)
        .map(clone),
      operations: [...this.operations.values()]
        .filter((operation) => operation.conversationId === conversationId)
        .map(clone),
      jobs: [...this.jobs.values()]
        .filter((job) => this.bindings.get(job.requestId)?.conversationId === conversationId)
        .map((job) => this.job(job.id, { conversationId })),
    };
  }
  private updateOperation(id: string, update: Partial<ComfyOperation>): void {
    const current = this.savedOperation(id);
    // updatedAt is also the acknowledgement version; rapid repairs must produce a new one.
    const previous = Date.parse(current.updatedAt);
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    this.operations.set(id, { ...current, ...update, updatedAt });
    this.flush();
  }
  private supportsAutomaticRuntimeReplan(operation: ComfyOperation, failure: string): boolean {
    if (
      operation.approval?.mode !== 'automatic' ||
      failure.includes('COMFY_PREFLIGHT_CLEANUP_FAILED:') ||
      operation.plan.repair ||
      operation.installRequest?.intent !== 'install' ||
      operation.installRequest.profileId
    )
      return false;
    return (
      failure.startsWith('COMFY_EXISTING_RUNTIME_INCOMPATIBLE:') ||
      (operation.progress === 'bootstrap:python-venv' &&
        failure.startsWith('COMFY_COMMAND_FAILED:bootstrap:python-venv:')) ||
      (/spawn git(?:\.exe)? ENOENT/i.test(failure) &&
        operation.plan.commands.some((step) => step.label === 'bootstrap:comfy-clone' && step.args[0] === 'clone'))
    );
  }
  /** Snapshots for the application-owned Agent continuation worker. */
  installationUpdates(): ComfyOperation[] {
    return [...this.operations.values()]
      .filter((operation) => {
        const scope = this.bindings.get(operation.requestId);
        const parent = this.repairParents.get(operation.requestId);
        return (
          (!parent || sameSelection(this.bindings.get(parent.requestId), parent)) &&
          operation.execution !== 'agent' &&
          this.operationObservations.get(operation.id) !== operation.updatedAt &&
          !this.cancelledConversations.has(operation.conversationId) &&
          scope?.conversationId === operation.conversationId &&
          scope.intent !== 'generate' &&
          scope.family === operation.plan.family &&
          (!operation.installRequest || scope.intent === operation.installRequest.intent) &&
          (operation.state === 'failed' || operation.state === 'completed')
        );
      })
      .map((operation) => ({
        ...clone(operation),
        requestId: this.repairParents.get(operation.requestId)?.requestId ?? operation.requestId,
      }));
  }
  /** Return Agent validation outcomes separately from fixed-installer operations. */
  installationValidationUpdates(): ComfyInstallationValidation[] {
    const jobs = [...this.jobs.values()];
    return jobs.flatMap((job) => {
      const scope = this.bindings.get(job.requestId);
      const parent = this.repairParents.get(job.requestId);
      const generation = scope?.intent === 'generate';
      const repair = scope?.intent === 'repair';
      const workflowRepair = (generation || repair) && job.verify && job.validationMode !== 'generation';
      const repairNeeded =
        generation &&
        job.status === 'failed' &&
        !job.submissionUncertain &&
        !job.observationOnly &&
        Boolean(comfyWorkflowRepairReason(job));
      // Observing a repairable failure does not finish the creative goal. The worker
      // persists one delivery per terminal version, after the active Agent is idle.
      const relatedWork =
        repairNeeded &&
        (jobs.slice(jobs.indexOf(job) + 1).some((other) => this.isRequestRelated(other.requestId, job.requestId)) ||
          [...this.operations.values()].some(
            (operation) =>
              this.isRequestRelated(operation.requestId, job.requestId) &&
              (!['failed', 'completed', 'cancelled'].includes(operation.state) ||
                (operation.plan.repair &&
                  sameSelection(this.repairParents.get(operation.requestId), job.selectionAtSubmission) &&
                  Date.parse(operation.updatedAt) > Date.parse(job.updatedAt)))
          ) ||
          [...this.preparations.values()].some(
            (preparation) =>
              this.isRequestRelated(preparation.requestId, job.requestId) && preparation.status === 'detecting'
          ) ||
          Boolean(this.recoveredJob(job)));
      if (
        (!job.verify && !generation) ||
        !scope ||
        (parent && !sameSelection(this.bindings.get(parent.requestId), parent)) ||
        ((generation || repair || job.selectionAtSubmission?.intent === 'repair') &&
          !sameSelection(scope, job.selectionAtSubmission)) ||
        (generation && !workflowRepair && job.status !== 'failed') ||
        this.cancelledConversations.has(scope.conversationId) ||
        scope.family !== job.profile.family ||
        (!workflowRepair && scope.profileId && scope.profileId !== job.profileId) ||
        jobs.findLast(
          (other) =>
            other.requestId === job.requestId &&
            (generation || repair || (other.verify && other.profileId === job.profileId))
        )?.id !== job.id ||
        job.submissionUncertain ||
        (job.agentObservedUpdate === job.updatedAt && !repairNeeded) ||
        relatedWork ||
        !['succeeded', 'failed'].includes(job.status) ||
        [...this.operations.values()].some(
          (operation) => operation.execution === 'agent' && operation.validationJobId === job.id
        )
      )
        return [];
      return [
        {
          id: job.id,
          requestId: parent?.requestId ?? job.requestId,
          conversationId: scope.conversationId,
          family: job.profile.family,
          profileId: job.profileId,
          state: job.status === 'succeeded' ? ('completed' as const) : ('failed' as const),
          updatedAt: job.updatedAt,
          error: job.error,
          diagnosis: job.diagnosis,
          diagnosticLogPath: job.diagnosticLogPath,
          promptId: job.promptId,
          artifacts: clone(job.artifacts),
          ...(repairNeeded
            ? { originalInput: clone(job.submittedInput ?? job.input), profile: clone(job.profile) }
            : {}),
          ...(generation
            ? {
                purpose: workflowRepair ? ('workflow-repair' as const) : ('generation' as const),
                selectionProfileId: scope.profileId,
              }
            : parent
              ? { purpose: 'installation' as const }
              : {}),
        },
      ];
    });
  }
  /** A schema failure before downloads may need a different runtime, with fresh approval for the changed plan. */
  async recoverOrReplanInstallation(
    id: string,
    requestId: string,
    sourceOverrides?: ComfyInstallIdentityRequest['sourceOverrides']
  ): Promise<ComfyOperation> {
    const operation = this.operation(id, { requestId });
    requestId = operation.requestId;
    if (operation.error?.includes('COMFY_PREFLIGHT_CLEANUP_FAILED:')) throw new Error('COMFY_RUNTIME_CLEANUP_REQUIRED');
    const legacyGitFailure =
      /spawn git(?:\.exe)? ENOENT/i.test(operation.error ?? '') &&
      operation.plan.commands.some((step) => step.label === 'bootstrap:comfy-clone' && step.args[0] === 'clone');
    const bootstrapFailure =
      operation.progress === 'bootstrap:python-venv' &&
      operation.error?.startsWith('COMFY_COMMAND_FAILED:bootstrap:python-venv:');
    if (!operation.error?.startsWith('COMFY_EXISTING_RUNTIME_INCOMPATIBLE:') && !legacyGitFailure && !bootstrapFailure)
      return this.recoverInstallation(id, requestId, sourceOverrides);
    const key = `recovery:${id}`;
    const pending = this.requesting.get(key);
    if (pending) return pending.promise;
    const recover = (async () => {
      if (
        operation.state !== 'failed' ||
        !operation.approval ||
        !operation.installRequest ||
        operation.installRequest.profileId ||
        operation.plan.repair
      )
        throw new Error('COMFY_RUNTIME_REPLAN_NOT_ALLOWED');
      this.assertRecoveryBudget(operation);
      const scope = clone(this.operationScopes.get(id));
      const assertScope = (): void => {
        if (
          this.cancelledConversations.has(operation.conversationId) ||
          this.operation(id, { requestId }).state !== 'failed'
        )
          throw new Error('COMFY_INSTALL_CANCELLED');
        if (!sameSelection(this.scope(requestId), scope)) throw new Error('COMFY_SELECTION_CHANGED');
      };
      assertScope();
      const installRequest = { ...operation.installRequest, ...(sourceOverrides ? { sourceOverrides } : {}) };
      const plan = await this.resolveInstallPlan(
        requestId,
        installRequest,
        operation.error?.startsWith('COMFY_EXISTING_RUNTIME_INCOMPATIBLE:')
          ? { excludedEnvironmentRoots: [operation.plan.environment.root] }
          : undefined
      );
      // Runtime isolation may change packages and paths, never the chosen model artifacts or workflow.
      const models = (value: ComfyInstallPlan) =>
        JSON.stringify(
          value.components
            .filter((c) => c.role !== 'runtime-wheel')
            .map((c) => [c.role, c.name, c.version, c.precision, c.sha256, c.sizeBytes])
            .sort()
        );
      if (
        models(plan) !== models(operation.plan) ||
        plan.family !== operation.plan.family ||
        JSON.stringify(plan.workflow) !== JSON.stringify(operation.plan.workflow)
      )
        throw new Error('COMFY_RUNTIME_REPLAN_RECIPE_CHANGED');
      if (
        plan.environment.root === operation.plan.environment.root &&
        plan.environment.python === operation.plan.environment.python
      ) {
        assertScope();
        if (legacyGitFailure) return this.recoverInstallation(id, requestId, sourceOverrides);
        throw new Error('COMFY_RUNTIME_REPLAN_UNCHANGED');
      }
      this.options.checkPlan?.(plan);
      const report = await (this.options.probe ?? probeComfyEnvironment)({
        ...plan.environment,
        installDirectory: plan.targetRoot,
      });
      assertDetection(report, plan);
      assertScope();
      this.probes.set(id, hardware(report));
      this.failures.delete(id);
      this.updateOperation(id, {
        plan,
        installRequest,
        state: 'awaiting-consent',
        approval: undefined,
        error: undefined,
        recoveryAttempts: (operation.recoveryAttempts ?? 0) + 1,
        recoveryStageAttempts: this.nextRecoveryStageAttempts(operation),
      });
      return this.applyRequestApproval(this.operation(id, { requestId }));
    })();
    this.requesting.set(key, { inputKey: key, promise: recover });
    try {
      return await recover;
    } finally {
      this.requesting.delete(key);
    }
  }

  /** Resume the same approved plan after diagnosis; never manufacture consent. */
  recoverInstallation(
    id: string,
    requestId: string,
    sourceOverrides?: ComfyInstallIdentityRequest['sourceOverrides']
  ): ComfyOperation {
    const operation = this.operation(id, { requestId });
    requestId = operation.requestId;
    if (this.cancelledConversations.has(operation.conversationId)) throw new Error('COMFY_INSTALL_CANCELLED');
    if (operation.state === 'running' || operation.state === 'completed') return operation;
    if (!operation.approval) throw new Error('COMFY_USER_CONFIRMATION_REQUIRED');
    if (!['failed', 'paused'].includes(operation.state)) throw new Error('COMFY_RECOVERY_STATE_INVALID');
    if (
      /(?:HASH|CHECKSUM|INTEGRITY|DENIED|FORBIDDEN|APPROVAL|CONFIRMATION|DEVICE_CONDITIONS|DEVICE_INSUFFICIENT|HARDWARE_CHANGED|SELECTION_CHANGED|SCOPE|SOURCE_ACCESS|SOURCE_REJECTED)/i.test(
        operation.error ?? ''
      )
    )
      throw new Error('COMFY_RECOVERY_BLOCKED: resolve the reported requirement; do not bypass it');
    const plan = clone(operation.plan);
    let changedSources = false;
    for (const override of sourceOverrides ?? []) {
      const component = plan.components.find((item) => item.name === override.component);
      if (!component?.sha256 || !component.sizeBytes) throw new Error('COMFY_SOURCE_COMPONENT_UNKNOWN');
      if (!override.urls.length || override.urls.length > 4 || override.urls.some((url) => !isTrustedComfySource(url)))
        throw new Error('COMFY_SOURCE_CANDIDATE_NOT_TRUSTED');
      const urls = [
        ...new Set([...override.urls, ...(component.sourceUrls ?? []), ...(component.url ? [component.url] : [])]),
      ].slice(0, 4);
      changedSources ||= JSON.stringify(urls) !== JSON.stringify(component.sourceUrls ?? [component.url]);
      component.url = urls[0];
      component.sourceUrls = urls;
    }
    this.assertRecoveryBudget(operation);
    if (!changedSources && (this.failures.get(id)?.count ?? 0) >= 2) throw new Error('COMFY_REPEATED_ERROR_REPLAN');
    if (!sameSelection(this.scope(requestId), this.operationScopes.get(id))) throw new Error('COMFY_SELECTION_CHANGED');
    this.updateOperation(id, {
      plan,
      state: 'authorized',
      recoveryAttempts: (operation.recoveryAttempts ?? 0) + 1,
      recoveryStageAttempts: this.nextRecoveryStageAttempts(operation),
      error: undefined,
    });
    if (changedSources) this.failures.delete(id);
    return this.start(id, requestId);
  }
  private recoveryStage(operation: ComfyOperation): string {
    return operation.progress?.split(/:\d+\//)[0] || 'execution';
  }
  private assertRecoveryBudget(operation: ComfyOperation): void {
    if (
      (operation.recoveryAttempts ?? 0) >= 10 ||
      (operation.recoveryStageAttempts?.[this.recoveryStage(operation)] ?? 0) >= 2
    )
      throw new Error('COMFY_REPEATED_ERROR_REPLAN');
  }
  private nextRecoveryStageAttempts(operation: ComfyOperation): Record<string, number> {
    const key = this.recoveryStage(operation);
    return { ...operation.recoveryStageAttempts, [key]: (operation.recoveryStageAttempts?.[key] ?? 0) + 1 };
  }
  authorize(id: string, conversationId: string, approval?: ComfyOperation['approval']): ComfyOperation {
    const operation = this.operation(id, { conversationId });
    this.scope(operation.requestId);
    if ((this.failures.get(id)?.count ?? 0) >= 2) throw new Error('COMFY_REPEATED_ERROR_REPLAN');
    if (operation.conversationId !== conversationId) throw new Error('COMFY_CONVERSATION_MISMATCH');
    if (!['awaiting-consent', 'authorized', 'paused', 'failed'].includes(operation.state))
      throw new Error('COMFY_OPERATION_NOT_AUTHORIZABLE');
    this.updateOperation(id, {
      state: 'authorized',
      error: undefined,
      approval: approval ?? { mode: 'manual', source: 'ui', checkedAt: new Date().toISOString() },
    });
    console.info('[comfy] installation authorized', {
      operationId: id,
      family: operation.plan.family,
      source: approval?.source ?? 'ui',
      runtimeMode: approval?.runtimeMode,
    });
    return this.operation(id, { conversationId });
  }
  private schedule(task: () => Promise<void>): void {
    if (this.closing) throw new Error('COMFY_SERVICE_STOPPING');
    if (this.validating) throw new Error('COMFY_RUNTIME_BUSY');
    const pending = this.tail.then(task);
    this.tail = pending.catch((): void => undefined);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch((error) => console.error('[comfy]', error));
  }
  start(id: string, requestId: string): ComfyOperation {
    const operation = this.operation(id, { requestId });
    requestId = operation.requestId;
    const scope = clone(this.scope(requestId));
    if (operation.requestId !== requestId) throw new Error('COMFY_REQUEST_MISMATCH');
    if (['running', 'completed'].includes(operation.state)) return operation;
    if (operation.state !== 'authorized') throw new Error('COMFY_USER_CONFIRMATION_REQUIRED');
    if (!sameSelection(scope, this.operationScopes.get(id))) throw new Error('COMFY_SELECTION_CHANGED');
    if (this.closing) throw new Error('COMFY_SERVICE_STOPPING');
    if (this.validating) throw new Error('COMFY_RUNTIME_BUSY');
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.updateOperation(id, { state: 'running', progress: 'queued' });
    this.schedule(async () => {
      try {
        if (controller.signal.aborted) return;
        if (!sameSelection(this.scope(requestId), scope)) throw new Error('COMFY_SELECTION_CHANGED');
        const report = await (this.options.probe ?? probeComfyEnvironment)({
          ...operation.plan.environment,
          installDirectory: operation.plan.targetRoot,
        });
        assertDetection(report, operation.plan);
        if (hardware(report) !== this.probes.get(id)) throw new Error('COMFY_HARDWARE_CHANGED_REPLAN');
        const profile = await this.options.install(clone(operation.plan), controller.signal, (progress) =>
          this.updateOperation(id, { progress })
        );
        if (controller.signal.aborted) return;
        const verified = comfyProfileSchema.parse(profile);
        if (
          verified.state !== 'verified' ||
          !verified.validation?.fingerprint ||
          !verified.validation.promptId ||
          !verified.validation.artifacts?.length ||
          verified.id !== operation.plan.id ||
          verified.family !== operation.plan.family
        )
          throw new Error('COMFY_INSTALL_NOT_VERIFIED');
        this.catalog.set(verified.id, verified);
        const current = this.scope(requestId);
        if (sameSelection(current, scope)) this.bindings.set(requestId, { ...current, profileId: verified.id });
        this.updateOperation(id, { state: 'completed', profileId: verified.id, progress: 'verified' });
        this.prepareWorkflows(verified.id);
      } catch (error) {
        if (!controller.signal.aborted) {
          const failure = message(error),
            previous = this.failures.get(id);
          this.failures.set(id, { error: failure, count: previous?.error === failure ? previous.count + 1 : 1 });
          this.updateOperation(id, {
            state: 'failed',
            error: failure,
            diagnosis: diagnosis(error),
            diagnosticLogPath: diagnosticLogPath(error),
            ...(error &&
            typeof error === 'object' &&
            'snapshotDirectory' in error &&
            typeof error.snapshotDirectory === 'string'
              ? { snapshotDirectory: error.snapshotDirectory }
              : {}),
          });
          if (this.supportsAutomaticRuntimeReplan(this.savedOperation(id), failure)) {
            try {
              await this.recoverOrReplanInstallation(id, requestId);
            } catch (replanError) {
              const current = this.operations.get(id);
              if (current?.state === 'failed')
                this.updateOperation(id, {
                  error: `${failure}; COMFY_AUTOMATIC_RUNTIME_REPLAN_FAILED:${message(replanError)}`,
                });
            }
          }
        }
      } finally {
        if (this.controllers.get(id) === controller) this.controllers.delete(id);
      }
    });
    return this.operation(id, { requestId });
  }
  cancelOperation(id: string, scope: ComfyResourceScope): ComfyOperation {
    const operation = this.operation(id, scope);
    if (!['completed', 'cancelled'].includes(operation.state)) {
      this.controllers.get(id)?.abort();
      this.updateOperation(id, { state: 'cancelled' });
    }
    return this.operation(id, scope);
  }
  /** Materialize lightweight graphs using the existing weights; downloads remain Agent-led. */
  prepareWorkflows(profileId: string): ComfyPreparedWorkflows {
    const anchor = this.profile(profileId);
    let prepared: ComfyPreparedWorkflows;
    try {
      prepared = this.options.prepareWorkflows?.(clone(anchor), this.profiles()) ?? {
        profiles: [],
        pending: [],
        matchedCandidateIds: [],
      };
    } catch (error) {
      this.workflowPreparations.set(profileId, [
        {
          modelSetId: getComfyModelSetId(anchor),
          profileId,
          workflowId: profileId,
          tasks: [],
          reason: message(error),
          additionalBytes: 0,
        },
      ]);
      return { profiles: [], pending: [], matchedCandidateIds: [], unmatchedReason: message(error) };
    }
    this.workflowPreparations.set(
      profileId,
      prepared.pending.map((item) => ({
        modelSetId: getComfyModelSetId(anchor),
        profileId,
        workflowId: item.workflowId,
        tasks: item.metadata.tasks,
        reason: item.reason,
        additionalBytes: item.additionalBytes,
      }))
    );
    for (const profile of prepared.profiles) {
      if (!this.catalog.has(profile.id)) this.catalog.set(profile.id, clone(profile));
    }
    for (const profile of prepared.reusedProfiles ?? []) {
      const current = this.profile(profile.id);
      if (
        ![...this.jobs.values()].some(
          (job) => job.profileId === current.id && ['queued', 'running'].includes(job.status)
        )
      )
        this.catalog.set(profile.id, clone(profile));
    }
    if (prepared.profiles.length || prepared.reusedProfiles?.length) this.flush();
    return prepared;
  }
  resolveWorkflow(requestId: string, input: unknown) {
    const scope = this.scope(requestId);
    if (scope.source !== 'local' || scope.intent !== 'generate' || !scope.profileId)
      throw new Error('COMFY_GENERATION_INTENT_REQUIRED');
    return this.resolveProfileWorkflow(
      this.profile(scope.profileId),
      input,
      scope.modelConstraint?.workflowMode ?? scope.workflowMode ?? 'auto',
      scope.modelConstraint?.fixedWorkflowId ?? scope.fixedWorkflowId
    );
  }
  private resolveProfileWorkflow(
    anchor: ComfyProfile,
    input: unknown,
    mode: 'auto' | 'fixed',
    fixedWorkflowId?: string
  ) {
    const parsed = comfyGenerationInputSchema.parse(input);
    const constraints = comfyFamilyInputIssues(anchor.family, parsed);
    const match = matchComfyWorkflows(anchor, this.profiles(), parsed, mode, fixedWorkflowId);
    return {
      ...match,
      modelSetId: getComfyModelSetId(anchor),
      preparation: this.workflowPreparations.get(anchor.id) ?? [],
      ...(match.selectedProfileId
        ? { profile: clone(this.profile(match.selectedProfileId)) }
        : {
            action: constraints.includes('COMFY_OMNI_REFERENCE_REQUIRED') ? 'prepare-reference' : 'prepare-workflow',
            originalInput: parsed,
            selectedModel: clone(anchor),
            ...(constraints.includes('COMFY_OMNI_REFERENCE_REQUIRED')
              ? {
                  nextAction: {
                    type: 'prepare-reference-and-continue',
                    requiresUserUpload: false,
                    constraints,
                    instruction:
                      'FastH3-Omni requires a real image or video reference. For an original text-only creative request, generate a suitable intermediate reference image with an available image tool/model under current authorization, inspect and save it, then resolve again with that image and reference-to-video requirements. Keep the selected Omni model/precision and requested output parameters. State that the reference is generated. Do not use the smoke-test image, fabricate a user attachment, or substitute a different final video model. If the user requires a specific person, original asset or supplied reference, reuse the actual attachment or request only that missing source. If no suitable image tool/model is available, diagnose or prepare one within the user constraints; report a concrete blocker only after checking available routes.',
                  },
                }
              : {}),
          }),
    };
  }
  generate(
    requestId: string,
    profileId: string,
    input: unknown,
    attempt?: GenerationAttemptRequest
  ): ComfyGenerationJob {
    const scope = this.scope(requestId);
    if (scope.intent !== 'generate') throw new Error('COMFY_GENERATION_INTENT_REQUIRED');
    if (scope.source !== 'local' || !scope.profileId) throw new Error('COMFY_SELECTION_CHANGED');
    const anchor = this.profile(scope.profileId);
    const requested = this.profile(profileId);
    if (!attempt && !scope.workflowMode && !scope.modelConstraint && scope.profileId !== profileId)
      throw new Error('COMFY_SELECTION_CHANGED');
    if (anchor.id !== requested.id) assertRepairModel(anchor, requested);
    if (scope.family !== requested.family) throw new Error('COMFY_FAMILY_MISMATCH');
    const parsed = validateComfyGenerationInputForFamily(anchor.family, input);
    const requestAttempt = attempt ? generationAttemptRequestSchema.parse(attempt) : undefined;
    if (requestAttempt) {
      const prior = [...this.jobs.values()].find(
        (job) => job.requestId === requestId && job.identity?.attemptId === requestAttempt.attemptId
      );
      if (prior) {
        if (
          prior.identity!.taskId !== requestAttempt.taskId ||
          JSON.stringify(prior.submittedInput ?? prior.input) !== JSON.stringify(parsed)
        )
          throw new Error('COMFY_ATTEMPT_CONFLICT');
        return this.job(prior.id, { requestId });
      }
      const previous = [...this.jobs.values()]
        .filter((job) => job.requestId === requestId && job.identity?.taskId === requestAttempt.taskId)
        .at(-1);
      if (previous) {
        if (previous.submissionUncertain || ['queued', 'running'].includes(previous.status))
          throw new Error(`COMFY_TASK_ACTIVE:${previous.id}`);
        if (previous.status !== 'failed' || requestAttempt.predecessorAttemptId !== previous.identity!.attemptId)
          throw new Error('COMFY_ATTEMPT_PREDECESSOR_REQUIRED');
        assertRepairModel(previous.profile, requested);
      } else if (requestAttempt.predecessorAttemptId) throw new Error('COMFY_ATTEMPT_PREDECESSOR_NOT_FOUND');
    }
    const previous = [...this.jobs.values()].find(
      (job) =>
        job.requestId === requestId &&
        !requestAttempt &&
        (['queued', 'running'].includes(job.status) || (job.status === 'failed' && job.submissionUncertain)) &&
        JSON.stringify(job.submittedInput ?? job.input) === JSON.stringify(parsed)
    );
    if (previous) {
      if (previous.status === 'failed' && previous.submissionUncertain)
        throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN');
      return this.job(previous.id, { requestId });
    }
    // Legacy callers retain the existing saved-failure recovery path.
    const repaired = requestAttempt?.predecessorAttemptId ? inspectComfyWorkflow(requested, parsed) : undefined;
    const route = repaired
      ? {
          selectedProfileId:
            repaired.reasons.length || repaired.status === 'needs-preparation' ? undefined : requested.id,
          candidates: [repaired],
        }
      : parsed.requirements || requestAttempt || unsupportedComfyInputs(requested, parsed).length
        ? this.resolveWorkflow(requestId, parsed)
        : undefined;
    if (route && !route.selectedProfileId)
      throw new Error(`COMFY_WORKFLOW_PREPARATION_REQUIRED:${JSON.stringify(route)}`);
    profileId = route?.selectedProfileId ?? profileId;
    const profile = clone(this.profile(profileId));
    if (scope.workflowMode === 'fixed' || scope.modelConstraint?.workflowMode === 'fixed') {
      const fixed =
        scope.modelConstraint?.fixedWorkflowId ?? scope.fixedWorkflowId ?? anchor.workflowMetadata?.id ?? anchor.id;
      if (profile.id !== anchor.id || (profile.workflowMetadata?.id ?? profile.id) !== fixed)
        throw new Error('COMFY_WORKFLOW_FIXED');
    }
    // A discovered installation is validated with the user's real request, without
    // turning generation into a download/repair or submitting a second smoke job.
    if (profile.state !== 'verified' || !profile.validation?.fingerprint)
      return this.verify(requestId, profileId, parsed, 'generation', undefined, requestAttempt);
    if ([...this.jobs.values()].filter((job) => ['queued', 'running'].includes(job.status)).length >= 200)
      throw new Error('COMFY_JOB_LIMIT');
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const job: SavedJob = {
      id,
      requestId,
      profileId,
      profile,
      input: parsed,
      identity: requestAttempt
        ? buildAttemptIdentity(
            profile,
            parsed,
            requestAttempt,
            scope.modelConstraint?.selectionRevision ?? scope.selectionRevision ?? 0
          )
        : undefined,
      submittedInput: clone(parsed),
      selectionAtSubmission: clone(scope),
      templateSnapshot: clone(this.scope(requestId).templateSnapshot) as TemplateSnapshot | undefined,
      kind: profile.kind,
      status: 'queued',
      progress: 0,
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    this.flush();
    this.runJob(id);
    return this.job(id, { requestId });
  }
  private updateJob(id: string, update: Partial<SavedJob>): void {
    const value = this.jobs.get(id)!;
    this.jobs.set(id, { ...value, ...update, updatedAt: new Date().toISOString() });
    this.flush();
  }
  private recoveredJob(value: SavedJob): string | undefined {
    if (value.status !== 'failed' || value.submissionUncertain || value.observationOnly) return undefined;
    const jobs = [...this.jobs.values()];
    const later = jobs.slice(jobs.findIndex((job) => job.id === value.id) + 1);
    const successful = (job: SavedJob): boolean =>
      job.requestId === value.requestId &&
      (!value.identity || job.identity?.taskId === value.identity.taskId) &&
      job.status === 'succeeded' &&
      !job.submissionUncertain &&
      !job.observationOnly &&
      job.artifacts.length > 0;
    const adopted = later.find((job) => {
      const receipt = this.repairAdoptions.get(job.id);
      if (
        !receipt ||
        !job.verify ||
        !successful(job) ||
        !value.selectionAtSubmission ||
        !job.selectionAtSubmission ||
        receipt.updatedAt !== job.updatedAt ||
        receipt.selection.requestId !== value.requestId ||
        !sameSelection(receipt.selection, value.selectionAtSubmission) ||
        !sameSelection(receipt.selection, job.selectionAtSubmission) ||
        !receipt.failedJobs.some((failed) => failed.id === value.id && failed.updatedAt === value.updatedAt)
      )
        return false;
      try {
        assertRepairModel(value.profile, job.profile);
        return true;
      } catch {
        return false;
      }
    })?.id;
    if (value.verify && value.validationMode !== 'generation') {
      const completed = new Set(
        [...this.operations.values()]
          .filter((operation) => operation.requestId === value.requestId && operation.state === 'completed')
          .map((operation) => operation.validationJobId)
      );
      return (
        later.find(
          (job) =>
            completed.has(job.id) &&
            successful(job) &&
            value.selectionAtSubmission &&
            sameSelection(job.selectionAtSubmission, value.selectionAtSubmission)
        )?.id ?? adopted
      );
    }
    return (
      later.find((job) => {
        if (
          !successful(job) ||
          JSON.stringify(job.submittedInput ?? job.input) !== JSON.stringify(value.submittedInput ?? value.input)
        )
          return false;
        // A revalidation can fulfill the requested output only under the exact original selection and profile.
        if (
          job.verify &&
          job.validationMode !== 'generation' &&
          (job.profileId !== value.profileId ||
            !value.selectionAtSubmission ||
            !job.selectionAtSubmission ||
            !sameSelection(job.selectionAtSubmission, value.selectionAtSubmission))
        )
          return false;
        // A validated workflow repair may change the profile ID, but not the selected model or precision.
        try {
          assertRepairModel(value.profile, job.profile);
          return true;
        } catch {
          return false;
        }
      })?.id ?? adopted
    );
  }
  job(id: string, scope: ComfyResourceScope): ComfyGenerationJob {
    let value = this.jobs.get(id);
    if (!value) throw new Error('COMFY_JOB_NOT_FOUND');
    this.assertResourceScope(value.requestId, this.bindings.get(value.requestId)?.conversationId ?? '', scope);
    if (
      !this.closing &&
      !this.validating &&
      value.status === 'running' &&
      value.promptId &&
      (value.submissionUncertain || value.reconnectAfter !== undefined) &&
      !this.controllers.has(id) &&
      (value.reconnectAfter ?? 0) <= Date.now()
    ) {
      this.updateJob(id, { status: 'queued' });
      this.runJob(id);
      value = this.jobs.get(id)!;
    }
    const {
      requestId: _requestId,
      profile: _profile,
      input: _input,
      submittedInput: _submittedInput,
      verify: _verify,
      validationMode: _validationMode,
      selectionAtSubmission: _selectionAtSubmission,
      oomRetryCount: _oomRetryCount,
      reconnectAfter: _reconnectAfter,
      recoveredBy: _recoveredBy,
      agentObservedUpdate: _agentObservedUpdate,
      ...job
    } = value;
    const recoveredBy = this.recoveredJob(value);
    const repairContext =
      value.status === 'failed' &&
      !value.submissionUncertain &&
      !value.observationOnly &&
      comfyWorkflowRepairReason(value)
        ? { originalInput: value.submittedInput ?? value.input, profile: value.profile }
        : {};
    return clone({ ...job, ...repairContext, ...(recoveredBy ? { recoveredBy } : {}) });
  }
  acknowledgeJob(id: string, scope: ComfyResourceScope, updatedAt: string): boolean {
    this.job(id, scope);
    const value = this.jobs.get(id)!;
    if (
      value.submissionUncertain ||
      !['succeeded', 'failed', 'cancelled'].includes(value.status) ||
      value.updatedAt !== updatedAt
    )
      return false;
    if (value.agentObservedUpdate !== updatedAt) {
      this.jobs.set(id, { ...value, agentObservedUpdate: updatedAt });
      this.flush();
    }
    return true;
  }
  verify(
    requestId: string,
    profileId: string,
    input: unknown,
    validationMode: 'smoke' | 'generation' = 'smoke',
    installationIntent?: 'install' | 'install-other',
    attempt?: GenerationAttemptRequest
  ): ComfyGenerationJob {
    this.scope(requestId);
    const profile = clone(this.profile(profileId));
    if (installationIntent)
      requestId = this.installationScope(requestId, profile.family, installationIntent, profile.kind);
    const scope = this.scope(requestId);
    if (scope.source !== 'local' || scope.family !== profile.family) throw new Error('COMFY_FAMILY_MISMATCH');
    const parsed = validateComfyGenerationInputForFamily(profile.family, input);
    if (attempt && validationMode === 'smoke' && scope.intent === 'generate' && !installationIntent)
      return this.generate(requestId, profileId, parsed, attempt);
    const prior = [...this.jobs.values()].find(
      (job) =>
        !attempt &&
        job.verify &&
        job.requestId === requestId &&
        job.profileId === profileId &&
        (['queued', 'running'].includes(job.status) || (job.status === 'failed' && job.submissionUncertain)) &&
        recipe(job.profile) === recipe(profile) &&
        JSON.stringify(job.input) === JSON.stringify(parsed)
    );
    if (prior) {
      if (prior.status === 'failed' && prior.submissionUncertain) throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN');
      return this.job(prior.id, { requestId });
    }
    if ([...this.jobs.values()].filter((job) => ['queued', 'running'].includes(job.status)).length >= 200)
      throw new Error('COMFY_JOB_LIMIT');
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    this.jobs.set(id, {
      id,
      requestId,
      profileId,
      profile: { ...profile, validation: undefined },
      input: parsed,
      identity: attempt
        ? buildAttemptIdentity(
            profile,
            parsed,
            attempt,
            scope.modelConstraint?.selectionRevision ?? scope.selectionRevision ?? 0
          )
        : undefined,
      verify: true,
      validationMode,
      selectionAtSubmission: clone(scope),
      submittedInput: clone(parsed),
      templateSnapshot: clone(scope.templateSnapshot) as TemplateSnapshot | undefined,
      kind: profile.kind,
      status: 'queued',
      progress: 0,
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    });
    this.flush();
    this.runJob(id);
    return this.job(id, { requestId });
  }
  private runJob(id: string): void {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.schedule(async () => {
      const value = clone(this.jobs.get(id)!);
      if (controller.signal.aborted || value.status !== 'queued') {
        this.controllers.delete(id);
        return;
      }
      this.updateJob(id, { status: 'running' });
      let generationSettled = false;
      try {
        // Diagnose the actual requested inputs before starting or validating a runtime.
        // Keep this inside the saved job so the Agent receives the failure and can repair it.
        if (!value.promptId) assertComfyReferenceBindings(value.profile, value.input);
        if (value.verify && !value.promptId) {
          const checked = await this.options.engine.validate(value.profile, controller.signal);
          value.profile = {
            ...value.profile,
            state: 'loadable',
            validation: {
              fingerprint: checked.fingerprint,
              checkedAt: new Date().toISOString(),
              ...('runtime' in checked ? { runtime: checked.runtime } : {}),
            },
          };
          this.catalog.set(value.profileId, clone(value.profile));
          this.updateJob(id, { profile: value.profile });
        }
        if (value.identity && !value.snapshot && !value.promptId) {
          const captured = await captureGenerationSnapshot(
            value.profile,
            value.input,
            value.identity,
            path.join(path.dirname(this.options.filename), 'comfy-task-inputs', value.requestId),
            value.profile.validation!.fingerprint,
            controller.signal
          );
          value.input = captured.input;
          value.snapshot = captured.snapshot;
          value.executionWorkflow = { path: captured.workflowPath, sha256: value.identity.workflowHash };
          this.updateJob(id, {
            input: value.input,
            snapshot: value.snapshot,
            executionWorkflow: value.executionWorkflow,
          });
        }
        const progress = (progress: number): void => this.updateJob(id, { progress });
        const coordinator = this.options.runtimeCoordinator ?? sharedComfyRuntimeCoordinator;
        const runtimeResource = this.options.engine.runtimeResourceKey
          ? await this.options.engine.runtimeResourceKey(value.profile)
          : value.profile.environment.baseUrl;
        const runtimeSignature = comfyRuntimeSignature(value.profile);
        const cleanup = async (reason: ComfyCleanupReason, context?: unknown): Promise<void> => {
          if (!this.options.engine.clearMemory) return;
          const binding = context as { kind?: string; profile?: ComfyProfile } | undefined;
          const cleanupSignal = new AbortController().signal;
          if (
            !binding ||
            (binding.kind === 'comfy' && binding.profile?.environment.baseUrl === value.profile.environment.baseUrl)
          )
            await this.options.engine.clearMemory(binding?.profile ?? value.profile, reason, cleanupSignal);
          else
            await clearBoundComfyRuntime(context, reason, cleanupSignal, () =>
              this.options.engine.clearMemory!(value.profile, reason, cleanupSignal)
            );
        };
        const coordinated = <T>(task: () => Promise<T>): Promise<T> =>
          !this.options.engine.runtimeResourceKey && !this.options.runtimeCoordinator
            ? task()
            : coordinator.run(runtimeResource, runtimeSignature, task, cleanup, controller.signal, {
                taskId: id,
                recover: Boolean(value.promptId),
                isUncertain: () => {
                  const current = this.jobs.get(id);
                  return Boolean(current?.submissionPending || current?.submissionUncertain);
                },
                context: {
                  kind: 'comfy',
                  profile: value.profile,
                  outputRoot: path.join(path.dirname(this.options.filename), 'comfy-runtime-output'),
                },
              });
        const execute = async () => {
          let result;
          try {
            result = value.promptId
              ? await this.options.engine.resume!(value.profile, value.promptId!, controller.signal, progress)
              : await this.options.engine.generate(
                  value.profile,
                  value.input,
                  controller.signal,
                  progress,
                  (promptId) =>
                    this.updateJob(id, {
                      promptId,
                      submissionPending: false,
                      submissionUncertain: false,
                      error: undefined,
                    }),
                  (promptId) => this.updateJob(id, { promptId, submissionPending: true }),
                  value.executionWorkflow
                );
          } catch (error) {
            const currentJob = this.jobs.get(id)!;
            // OOM diagnostics only come from a rejected submission or a terminal execution error;
            // both are known outcomes, even when Comfy already assigned a prompt ID.
            const isTerminalOom = diagnosis(error)?.category === 'OOM';
            if (!isTerminalOom || controller.signal.aborted || (currentJob.oomRetryCount ?? 0) >= 1) throw error;

            // Persist the retry reservation before clearing memory. A restart cannot grant another retry.
            this.updateJob(id, {
              oomRetryCount: (currentJob.oomRetryCount ?? 0) + 1,
              promptId: undefined,
              submissionPending: false,
              submissionUncertain: false,
            });
            if (!this.options.engine.clearMemory) throw error;
            try {
              await this.options.engine.clearMemory(value.profile, 'oom', controller.signal);
            } catch (clearError) {
              const failure = Object.assign(
                new Error(`COMFY_MEMORY_CLEAR_UNCONFIRMED:${message(clearError)}`, { cause: error }),
                { diagnosis: diagnosis(error) }
              );
              throw failure;
            }
            if (controller.signal.aborted) throw error;
            // Keep the exact original profile/input. OOM never silently reduces quality or changes offload.
            this.updateJob(id, { progress: 0 });
            result = await this.options.engine.generate(
              value.profile,
              value.input,
              controller.signal,
              progress,
              (promptId) =>
                this.updateJob(id, {
                  promptId,
                  submissionPending: false,
                  submissionUncertain: false,
                  error: undefined,
                }),
              (promptId) => this.updateJob(id, { promptId, submissionPending: true }),
              value.executionWorkflow
            );
          }
          this.updateJob(id, { submissionPending: false, submissionUncertain: false });
          return result;
        };
        const result = await coordinated(async () => {
          try {
            return await execute();
          } catch (error) {
            const current = this.jobs.get(id)!;
            const terminal = Boolean(diagnosis(error)) || remoteTerminal(error);
            this.updateJob(id, {
              submissionPending: terminal ? false : current.submissionPending,
              submissionUncertain:
                current.status !== 'cancelled' && !terminal && Boolean(current.promptId || current.submissionPending),
            });
            throw error;
          }
        });
        generationSettled = true;
        if (!controller.signal.aborted) {
          if (!result.artifacts.some((artifact) => artifact.mimeType.startsWith(`${value.profile.kind}/`)))
            throw new Error('COMFY_SMOKE_OUTPUT_MISSING');
          // Prior profile verification cannot certify a later output. Every job
          // must decode and satisfy its requested media constraints before success.
          for (const artifact of result.artifacts.filter((artifact) =>
            artifact.mimeType.startsWith(`${value.profile.kind}/`)
          ))
            await (this.options.verifyArtifact ?? verifyComfySmokeArtifact)(
              artifact,
              value.profile.kind,
              controller.signal,
              {
                profile: value.profile,
                input: value.input,
                mode: value.verify ? (value.validationMode ?? 'smoke') : 'generation',
              }
            );
          if (value.profile.workflowMetadata) {
            value.profile.workflowSha256 ??=
              value.identity?.workflowHash ??
              crypto.createHash('sha256').update(fs.readFileSync(value.profile.workflowPath)).digest('hex');
            value.profile.workflowMetadata = {
              ...value.profile.workflowMetadata,
              preparation: 'ready',
              evidence: [
                ...(value.profile.workflowMetadata.evidence ?? []).filter((entry) => entry.kind !== 'execution'),
                {
                  kind: 'execution',
                  workflowHash: value.profile.workflowSha256,
                  checkedAt: new Date().toISOString(),
                  inputRoles: value.input.references?.flatMap((ref) => (ref.role ? [ref.role] : [])),
                  referenceCount: value.input.references?.length ?? value.input.imagePaths?.length ?? 0,
                  environmentFingerprint: value.profile.validation?.fingerprint,
                },
              ],
            };
            this.updateJob(id, { profile: value.profile });
          }
          if (value.verify) {
            const fingerprint = await this.options.engine.snapshotFingerprint(value.profile);
            if (fingerprint !== value.profile.validation?.fingerprint) throw new Error('COMFY_PROFILE_CHANGED');
            this.catalog.set(value.profileId, {
              ...value.profile,
              state: 'verified',
              validation: {
                ...value.profile.validation!,
                fingerprint,
                checkedAt: new Date().toISOString(),
                promptId: result.promptId,
                artifacts: result.artifacts.map((artifact) => artifact.path),
              },
            });
          }
          this.updateJob(id, {
            status: 'succeeded',
            progress: 100,
            promptId: result.promptId,
            artifacts: result.artifacts,
            submissionPending: false,
            submissionUncertain: false,
            error: undefined,
            reconnectAfter: undefined,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const currentJob = this.jobs.get(id)!;
          if (
            currentJob.promptId &&
            /COMFY_HISTORY_(?:UNAVAILABLE|TIMEOUT)|COMFY_RESUME_SERVER_UNAVAILABLE|COMFY_OUTPUT_(?:RETRIEVAL_FAILED|DOWNLOAD_HTTP)/.test(
              message(error)
            )
          ) {
            // Keep the existing prompt active: losing monitoring is not a terminal model outcome.
            this.updateJob(id, {
              status: 'running',
              submissionUncertain: !remoteTerminal(error),
              error: `COMFY_MONITORING_INTERRUPTED:${message(error)}`,
              diagnosticLogPath: diagnosticLogPath(error),
              reconnectAfter: Date.now() + 30_000,
            });
            return;
          }
          const terminalDiagnosis = diagnosis(error);
          const terminal = generationSettled || Boolean(terminalDiagnosis) || remoteTerminal(error);
          this.updateJob(id, {
            status: 'failed',
            error: message(error),
            diagnosis: terminalDiagnosis,
            diagnosticLogPath: diagnosticLogPath(error),
            submissionPending: terminal ? false : currentJob.submissionPending,
            submissionUncertain:
              !terminal &&
              Boolean(
                currentJob.submissionUncertain ||
                currentJob.submissionPending ||
                currentJob.promptId ||
                /COMFY_SUBMISSION_STATE_UNKNOWN/.test(message(error))
              ),
          });
          if (value.verify || /COMFY_PROFILE_CHANGED|COMFY_.*MISMATCH|COMFY_MISSING_MODEL/.test(message(error))) {
            const current = this.catalog.get(value.profileId);
            if (current && recipe(current) === recipe(value.profile)) {
              current.state = 'invalid';
              current.validation = { fingerprint: '', checkedAt: new Date().toISOString(), error: message(error) };
              this.flush();
            }
          }
        }
      } finally {
        this.controllers.delete(id);
      }
    });
  }
  recoverJobs(): void {
    for (const job of this.jobs.values())
      if (job.status === 'queued' && !this.controllers.has(job.id)) this.runJob(job.id);
  }
  async cancelJob(id: string, scope: ComfyResourceScope): Promise<ComfyGenerationJob> {
    const value = this.jobs.get(id);
    if (!value) throw new Error('COMFY_JOB_NOT_FOUND');
    this.job(id, scope);
    if (['succeeded', 'failed', 'cancelled'].includes(value.status) && !value.submissionUncertain)
      return this.job(id, scope);
    if (value.submissionPending && !value.promptId) {
      this.updateJob(id, { error: 'COMFY_CANCEL_UNCONFIRMED:COMFY_SUBMISSION_PENDING', submissionUncertain: true });
      throw new Error('COMFY_SUBMISSION_PENDING');
    }
    if (value.promptId) {
      try {
        await this.options.engine.cancel(value.profile, value.promptId, value.submissionPending);
      } catch (error) {
        this.updateJob(id, { error: `COMFY_CANCEL_UNCONFIRMED:${message(error)}` });
        throw error;
      }
    }
    this.updateJob(id, { status: 'cancelled', submissionPending: false, submissionUncertain: false });
    this.controllers.get(id)?.abort();
    if (this.options.engine.runtimeResourceKey)
      await (this.options.runtimeCoordinator ?? sharedComfyRuntimeCoordinator).confirmSettled(
        await this.options.engine.runtimeResourceKey(value.profile),
        id
      );
    return this.job(id, scope);
  }
  async cancelConversation(conversationId: string): Promise<void> {
    this.cancelledConversations.add(conversationId);
    this.flush();
    const requests = new Set(
      [...this.bindings.values()]
        .filter((scope) => scope.conversationId === conversationId)
        .map((scope) => scope.requestId)
    );
    for (const operation of this.operations.values())
      if (requests.has(operation.requestId)) this.cancelOperation(operation.id, { conversationId });
    const cancellations = [...this.jobs.values()]
      .filter((job) => requests.has(job.requestId))
      .map((job) => this.cancelJob(job.id, { conversationId }));
    const results = await Promise.allSettled(cancellations);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  runtimeBusy(root: string, baseUrl: string): boolean {
    const same = (environment: ComfyProfile['environment']): boolean =>
      path.resolve(environment.root).toLowerCase() === path.resolve(root).toLowerCase() ||
      environment.baseUrl === baseUrl;
    return (
      this.validating ||
      [...this.jobs.values()].some(
        (job) => ['queued', 'running'].includes(job.status) && same(job.profile.environment)
      ) ||
      [...this.operations.values()].some(
        (operation) => operation.state === 'running' && same(operation.plan.environment)
      )
    );
  }
  async idle(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
  /** Fail closed for submitted work whose remote completion is not confirmed. */
  updateIdle(): boolean {
    return (
      this.activityKnown &&
      !this.closing &&
      !this.validating &&
      !this.refreshing &&
      !this.pending.size &&
      !this.controllers.size &&
      !this.requesting.size &&
      ![...this.preparations.values()].some((value) => value.status === 'detecting') &&
      ![...this.operations.values()].some((value) => ['authorized', 'running'].includes(value.state)) &&
      ![...this.jobs.values()].some(
        (value) => ['queued', 'running'].includes(value.status) || value.submissionPending || value.submissionUncertain
      )
    );
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.requesting.values()].map((request) => request.promise));
    if (this.refreshing) await this.refreshing;
    await this.idle();
    await this.options.engine.stopOwned();
  }
}
