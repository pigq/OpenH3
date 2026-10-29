import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { templateSnapshotSchema, type TemplateSnapshot } from '@/common/contentCatalog/snapshot';
import {
  comfyFamilySchema,
  comfyInstallPlanSchema,
  comfyProfileSchema,
  comfyFamilyKind,
  validateComfyGenerationInputForFamily,
  comfyInstallRequestSchema,
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
} from '@/common/chat/document/creation/comfy';
import { probeComfyEnvironment, type ComfyEnvironmentReport } from './discovery/environment';
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
  family: comfyFamilySchema.optional(),
  intent: z.enum(['generate', 'install', 'repair', 'install-other']).default('generate'),
  source: z.enum(['local', 'cloud']).optional(),
  kind: z.enum(['image', 'video']).optional(),
  templateSnapshot: templateSnapshotSchema.optional(),
});
export type ComfySelection = z.infer<typeof bindingSchema>;
export type ComfyResourceScope = { requestId?: string; conversationId?: string };
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
  checkPlan?: (plan: ComfyInstallPlan) => void;
  /**
   * Build an immutable plan from a model-card identity after probing this
   * machine. The callback runs in the media service process so the model
   * cannot inject paths, commands, or unverified sources into an install.
   */
  preparePlan?: (
    requestId: string,
    request: ComfyInstallIdentityRequest,
    profiles: ComfyProfile[]
  ) => ComfyInstallPlan | Promise<ComfyInstallPlan>;
  /** Incrementally inspect known roots and instances; discovery never grants verification. */
  discover?: (profiles: ComfyProfile[]) => Promise<ComfyProfile[]>;
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
  if (profile.kind !== comfyFamilyKind(profile.family)) throw new Error('COMFY_FAMILY_KIND_MISMATCH');
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
  private operations = new Map<string, ComfyOperation>();
  private preparations = new Map<string, ComfyInstallPreparation>();
  private jobs = new Map<string, SavedJob>();
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
  constructor(private options: ComfyServiceOptions) {
    fs.mkdirSync(path.dirname(options.filename), { recursive: true });
    if (!fs.existsSync(options.filename)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(options.filename, 'utf8')) as {
        profiles: unknown[];
        bindings: unknown[];
        operations: ComfyOperation[];
        preparations?: ComfyInstallPreparation[];
        jobs: SavedJob[];
        probes?: Array<[string, string]>;
        operationScopes?: Array<[string, ComfySelection]>;
        failures?: Array<[string, { error: string; count: number }]>;
        cancelledConversations?: string[];
      };
      for (const value of saved.profiles) {
        const profile = comfyProfileSchema.parse(value);
        this.catalog.set(profile.id, profile);
      }
      for (const value of saved.bindings) {
        const scope = bindingSchema.parse(value);
        this.bindings.set(scope.requestId, scope);
      }
      for (const value of saved.operations) {
        uuid.parse(value.id);
        comfyInstallPlanSchema.parse(value.plan);
        this.operations.set(value.id, { ...value, state: value.state === 'running' ? 'paused' : value.state });
      }
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
      this.probes = new Map(saved.probes ?? []);
      this.cancelledConversations = new Set(saved.cancelledConversations ?? []);
      this.operationScopes = new Map(saved.operationScopes ?? []);
      this.failures = new Map(saved.failures ?? []);
    } catch (error) {
      // Keep the original manifest intact: corrupt consent must never start an operation.
      fs.copyFileSync(options.filename, `${options.filename}.corrupt-${Date.now()}`, fs.constants.COPYFILE_EXCL);
      this.catalog.clear();
      this.bindings.clear();
      this.operations.clear();
      this.preparations.clear();
      this.jobs.clear();
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
            operations: [...this.operations.values()],
            preparations: [...this.preparations.values()],
            jobs: [...this.jobs.values()],
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
    return scope;
  }
  bind(input: unknown): void {
    const value = bindingSchema.parse(input),
      prior = this.bindings.get(value.requestId);
    if (prior && prior.conversationId !== value.conversationId) throw new Error('COMFY_CONVERSATION_MISMATCH');
    if (this.cancelledConversations.has(value.conversationId)) throw new Error('COMFY_CONVERSATION_UNAVAILABLE');
    const profile = value.profileId ? this.catalog.get(value.profileId) : undefined;
    if (value.profileId && !profile) throw new Error('COMFY_PROFILE_NOT_FOUND');
    if (profile && value.family && profile.family !== value.family) throw new Error('COMFY_FAMILY_MISMATCH');
    this.bindings.set(value.requestId, {
      ...value,
      templateSnapshot: value.templateSnapshot ?? prior?.templateSnapshot,
      family: value.family ?? profile?.family,
      source: value.source ?? (value.family || profile ? 'local' : prior?.source),
      kind: value.kind ?? profile?.kind ?? (value.family ? comfyFamilyKind(value.family) : prior?.kind),
    });
    this.flush();
  }
  selection(requestId: string): ComfySelection {
    return clone(this.scope(requestId));
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
    const parsed = comfyProfileSchema.parse(input),
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
    this.flush();
    return clone(profile);
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
    if (this.options.discover && !this.closing) {
      try {
        const discovered = await this.options.discover(this.profiles());
        for (const profile of discovered) {
          try {
            this.register(profile);
          } catch (error) {
            // One changed or incomplete installation must not hide other environments.
            console.warn('[comfy] profile discovery rejected', { profileId: profile.id, error: message(error) });
          }
        }
      } catch (error) {
        console.warn('[comfy] profile discovery failed', { error: message(error) });
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
    return this.profiles();
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
    if (identity) this.assertInstallIdentity(requestId, identity);
    const inputKey = JSON.stringify(identity ? [identity.family, identity.intent, identity.profileId] : installRequest);
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
            saved.profileId !== identity.profileId
          )
            throw new Error('COMFY_INSTALL_REQUEST_ID_CONFLICT');
          return this.applyRequestApproval(previous);
        }
      }
      if (identity) {
        this.preparations.set(requestId, {
          requestId,
          conversationId: scope.conversationId,
          family: identity.family,
          intent: identity.intent,
          status: 'detecting',
          updatedAt: new Date().toISOString(),
        });
        this.flush();
      }
      try {
        const plan = await this.resolveInstallPlan(requestId, installRequest);
        if (JSON.stringify(this.scope(requestId)) !== JSON.stringify(scope)) throw new Error('COMFY_SELECTION_CHANGED');
        return await this.requestPlan(requestId, plan, identity);
      } catch (error) {
        const preparation = this.preparations.get(requestId);
        if (preparation) {
          this.preparations.set(requestId, {
            ...preparation,
            status: 'failed',
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
  private async resolveInstallPlan(requestId: string, request: ComfyInstallRequest): Promise<ComfyInstallPlan> {
    if (request.action === 'plan' || 'plan' in request) {
      if ('requestId' in request && request.requestId && request.requestId !== requestId)
        throw new Error('COMFY_REQUEST_MISMATCH');
      return request.plan;
    }
    this.assertInstallIdentity(requestId, request);
    if (!this.options.preparePlan) throw new Error('COMFY_INSTALL_PLANNER_UNAVAILABLE');
    const plan = comfyInstallPlanSchema.parse(await this.options.preparePlan(requestId, request, this.profiles()));
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
    const report = await (this.options.probe ?? probeComfyEnvironment)(plan.environment);
    assertDetection(report, plan);
    if (JSON.stringify(this.scope(requestId)) !== JSON.stringify(scope)) throw new Error('COMFY_SELECTION_CHANGED');
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
    if (JSON.stringify(this.scope(operation.requestId)) !== JSON.stringify(this.operationScopes.get(operation.id)))
      throw new Error('COMFY_SELECTION_CHANGED');
    this.authorize(operation.id, operation.conversationId, approval);
    return this.start(operation.id, operation.requestId);
  }
  private assertResourceScope(requestId: string, conversationId: string, scope: ComfyResourceScope): void {
    if (!scope?.requestId && !scope?.conversationId) throw new Error('COMFY_REQUEST_REQUIRED');
    if (scope.requestId) {
      uuid.parse(scope.requestId);
      if (scope.requestId !== requestId) throw new Error('COMFY_REQUEST_MISMATCH');
    }
    if (scope.conversationId && scope.conversationId !== conversationId) throw new Error('COMFY_CONVERSATION_MISMATCH');
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
    this.operations.set(id, { ...this.savedOperation(id), ...update, updatedAt: new Date().toISOString() });
    this.flush();
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
    const scope = clone(this.scope(requestId));
    if (operation.requestId !== requestId) throw new Error('COMFY_REQUEST_MISMATCH');
    if (['running', 'completed'].includes(operation.state)) return operation;
    if (operation.state !== 'authorized') throw new Error('COMFY_USER_CONFIRMATION_REQUIRED');
    if (JSON.stringify(scope) !== JSON.stringify(this.operationScopes.get(id)))
      throw new Error('COMFY_SELECTION_CHANGED');
    if (this.closing) throw new Error('COMFY_SERVICE_STOPPING');
    if (this.validating) throw new Error('COMFY_RUNTIME_BUSY');
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.updateOperation(id, { state: 'running', progress: 'queued' });
    this.schedule(async () => {
      try {
        if (controller.signal.aborted) return;
        if (JSON.stringify(this.scope(requestId)) !== JSON.stringify(scope)) throw new Error('COMFY_SELECTION_CHANGED');
        const report = await (this.options.probe ?? probeComfyEnvironment)(operation.plan.environment);
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
        if (JSON.stringify(current) === JSON.stringify(scope))
          this.bindings.set(requestId, { ...current, profileId: verified.id });
        this.updateOperation(id, { state: 'completed', profileId: verified.id, progress: 'verified' });
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
        }
      } finally {
        this.controllers.delete(id);
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
  generate(requestId: string, profileId: string, input: unknown): ComfyGenerationJob {
    const scope = this.scope(requestId),
      profile = clone(this.profile(profileId));
    if (scope.intent !== 'generate') throw new Error('COMFY_GENERATION_INTENT_REQUIRED');
    if (scope.source !== 'local' || scope.profileId !== profileId) throw new Error('COMFY_SELECTION_CHANGED');
    if (scope.family !== profile.family) throw new Error('COMFY_FAMILY_MISMATCH');
    const parsed = validateComfyGenerationInputForFamily(profile.family, input);
    const previous = [...this.jobs.values()].find(
      (job) =>
        job.requestId === requestId &&
        job.profileId === profileId &&
        (['queued', 'running'].includes(job.status) || (job.status === 'failed' && job.submissionUncertain)) &&
        JSON.stringify(job.submittedInput ?? job.input) === JSON.stringify(parsed)
    );
    if (previous) {
      if (previous.status === 'failed' && previous.submissionUncertain)
        throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN');
      return this.job(previous.id, { requestId });
    }
    // A discovered installation is validated with the user's real request, without
    // turning generation into a download/repair or submitting a second smoke job.
    if (profile.state !== 'verified' || !profile.validation?.fingerprint)
      return this.verify(requestId, profileId, parsed, 'generation');
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
      submittedInput: clone(parsed),
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
      oomRetryCount: _oomRetryCount,
      reconnectAfter: _reconnectAfter,
      ...job
    } = value;
    return clone(job);
  }
  verify(
    requestId: string,
    profileId: string,
    input: unknown,
    validationMode: 'smoke' | 'generation' = 'smoke'
  ): ComfyGenerationJob {
    const scope = this.scope(requestId),
      profile = clone(this.profile(profileId));
    if (scope.source !== 'local' || scope.family !== profile.family) throw new Error('COMFY_FAMILY_MISMATCH');
    const parsed = validateComfyGenerationInputForFamily(profile.family, input);
    const prior = [...this.jobs.values()].find(
      (job) =>
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
      verify: true,
      validationMode,
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
                  (promptId) => this.updateJob(id, { promptId, submissionPending: true })
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
              (promptId) => this.updateJob(id, { promptId, submissionPending: true })
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
          if (value.verify || value.profile.family === 'fasth3-omni') {
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
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.requesting.values()].map((request) => request.promise));
    if (this.refreshing) await this.refreshing;
    await this.idle();
    await this.options.engine.stopOwned();
  }
}
