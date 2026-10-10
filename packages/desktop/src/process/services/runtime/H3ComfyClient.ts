import fs from 'node:fs';
import path from 'node:path';
import {
  inferH3Mode,
  normalizeH3GenerationSpec,
  type H3Artifact,
  type H3Activity,
  type H3Monitor,
  type H3GenerationSpec,
  type H3NormalizedGenerationSpec,
  type H3Reference,
  type H3ResolvedMode,
} from '@/common/chat/document/h3Job';
import { resolveH3BundleRoot } from './h3BundlePath';
import { diagnoseComfyError } from './h3ComfyError';
import { validateComfyWorkflow, type ComfyRegistry } from './h3WorkflowPreflight';
import { H3ComfyEvents } from './h3ComfyEvents';

type FetchLike = typeof fetch;
type ApiWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown>; [key: string]: unknown }>;
type HistoryEntry = {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, Record<string, unknown>>;
};
const REFERENCE_EXTENSIONS: Record<H3Reference['type'], ReadonlySet<string>> = {
  image: new Set(['.png', '.jpg', '.jpeg', '.webp']),
  video: new Set(['.mp4', '.mov', '.webm', '.mkv']),
  audio: new Set(['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg']),
};

export type H3ComfyClientOptions = {
  baseUrl?: string;
  bundleRoot?: () => string;
  attentionBackend?: () => 'dense' | 'sla';
  workflowPath?: string;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  eventCheckIntervalMs?: number;
  maxWaitMs?: number;
  /** Silence threshold for a suspected stall; a live queued/running task retains its total budget. */
  maxIdleMs?: number;
  /** Runtime health probe cadence while waiting for execution events. */
  heartbeatIntervalMs?: number;
  /** Consecutive failed runtime probes before ending the job. */
  heartbeatFailureLimit?: number;
  cancelConfirmAttempts?: number;
  missingGraceMs?: number;
};

export type H3GenerationResult = { promptId: string; artifacts: H3Artifact[] };
export type H3PromptSubmitted = (promptId: string, pending?: boolean) => void;
export type H3Progress = (progress: number, activity?: H3Activity, monitor?: H3Monitor) => void;
export type H3MonitorContext = { startedAt?: string; activity?: H3Activity };

function mimeType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return extension === '.mp4' ? 'video/mp4' : extension === '.webm' ? 'video/webm' : 'application/octet-stream';
}

function cloneWorkflow(workflow: ApiWorkflow): ApiWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ApiWorkflow;
}

function defaultWorkflowPath(): string {
  const bundleRoot = resolveH3BundleRoot();
  return path.join(bundleRoot, 'workflows', 'lowvram', '01_reference_4step_sla_lowvram.api.json');
}

function imageWorkflowPath(): string {
  return path.join(resolveH3BundleRoot(), 'workflows', 'lowvram', '04_i2v_fl2v_4step_sla_lowvram.api.json');
}

function referenceWorkflowPath(): string {
  return path.join(resolveH3BundleRoot(), 'workflows', 'lowvram', '05_ref2va_4step_sla_lowvram.api.json');
}

function workflowPathForMode(mode: H3ResolvedMode, root?: string): string {
  if (root)
    return path.join(
      root,
      'workflows',
      'lowvram',
      mode === 't2v'
        ? '01_reference_4step_sla_lowvram.api.json'
        : mode === 'fl2v'
          ? '04_i2v_fl2v_4step_sla_lowvram.api.json'
          : '05_ref2va_4step_sla_lowvram.api.json'
    );
  return mode === 't2v' ? defaultWorkflowPath() : mode === 'fl2v' ? imageWorkflowPath() : referenceWorkflowPath();
}

function nextNodeId(workflow: ApiWorkflow): string {
  return String(Math.max(0, ...Object.keys(workflow).map(Number).filter(Number.isFinite)) + 1);
}

function addNode(workflow: ApiWorkflow, node: ApiWorkflow[string]): string {
  const id = nextNodeId(workflow);
  workflow[id] = node;
  return id;
}

function bindFl2vReferences(workflow: ApiWorkflow, references: H3Reference[]): void {
  const target = Object.values(workflow).find((node) => node.class_type === 'MiniMaxH3ImageToVideo');
  if (!target?.inputs) throw new Error('H3_FL2V_UNSUPPORTED_WORKFLOW');
  const loaders = Object.entries(workflow)
    .filter(([, node]) => node.class_type === 'LoadImage')
    .toSorted(([left], [right]) => Number(left) - Number(right));
  const loaderIds = references.map((reference, index) => {
    const existing = loaders[index];
    if (existing?.[1].inputs) {
      existing[1].inputs.image = path.basename(reference.path);
      return existing[0];
    }
    return addNode(workflow, { class_type: 'LoadImage', inputs: { image: path.basename(reference.path) } });
  });
  target.inputs.first_frame = [loaderIds[0], 0];
  if (loaderIds[1]) target.inputs.last_frame = [loaderIds[1], 0];
  else delete target.inputs.last_frame;
}

function bindRef2vaReferences(workflow: ApiWorkflow, references: H3Reference[]): void {
  const target = Object.values(workflow).find((node) => node.class_type === 'MiniMaxH3ReferenceToVideo');
  if (!target?.inputs) throw new Error('H3_REF2VA_UNSUPPORTED_WORKFLOW');
  for (const key of Object.keys(target.inputs)) {
    if (/^ref_(images|videos|video_audios|audios)\./.test(key)) delete target.inputs[key];
  }
  const reusableImageLoaders = Object.entries(workflow)
    .filter(([, node]) => node.class_type === 'LoadImage')
    .toSorted(([left], [right]) => Number(left) - Number(right));
  let imageIndex = 0;
  let videoIndex = 0;
  let audioIndex = 0;
  for (const reference of references) {
    const filename = path.basename(reference.path);
    if (reference.type === 'image') {
      const existing = reusableImageLoaders[imageIndex];
      const loaderId = existing?.[1].inputs
        ? ((existing[1].inputs.image = filename), existing[0])
        : addNode(workflow, { class_type: 'LoadImage', inputs: { image: filename } });
      target.inputs[`ref_images.ref_image_${imageIndex}`] = [loaderId, 0];
      imageIndex += 1;
      continue;
    }
    if (reference.type === 'video') {
      const loaderId = addNode(workflow, { class_type: 'LoadVideo', inputs: { file: filename } });
      const componentsId = addNode(workflow, { class_type: 'GetVideoComponents', inputs: { video: [loaderId, 0] } });
      target.inputs[`ref_videos.ref_video_${videoIndex}`] = [componentsId, 0];
      target.inputs[`ref_video_audios.ref_video_audio_${videoIndex}`] = [componentsId, 1];
      videoIndex += 1;
      continue;
    }
    const loaderId = addNode(workflow, { class_type: 'LoadAudio', inputs: { audio: filename } });
    target.inputs[`ref_audios.ref_audio_${audioIndex}`] = [loaderId, 0];
    audioIndex += 1;
  }
}

export function buildH3Workflow(
  template: ApiWorkflow,
  spec: H3GenerationSpec,
  attention: 'dense' | 'sla' = 'dense'
): ApiWorkflow {
  const normalized = normalizeH3GenerationSpec(spec);
  const mode = inferH3Mode(normalized);
  const workflow = cloneWorkflow(template);
  for (const node of Object.values(workflow)) {
    if (node.class_type === 'H3SLAAttention' && node.inputs) node.inputs.enabled = attention === 'sla';
  }
  const promptNode = Object.values(workflow).find((node) => node.class_type === 'PrimitiveStringMultiline');
  if (promptNode?.inputs) promptNode.inputs.value = normalized.prompt;
  else {
    const conditioning = Object.values(workflow).find((node) =>
      ['MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo'].includes(node.class_type ?? '')
    );
    if (conditioning?.inputs) conditioning.inputs.prompt = normalized.prompt;
  }
  const resolutionNode = Object.values(workflow).find((node) => node.class_type === 'ResolutionSelector');
  if (resolutionNode?.inputs && normalized.megapixels !== undefined)
    resolutionNode.inputs.megapixels = normalized.megapixels;
  const durationNode = Object.values(workflow).find((node) => node.class_type === 'PrimitiveFloat');
  if (durationNode?.inputs && normalized.durationSeconds !== undefined)
    durationNode.inputs.value = normalized.durationSeconds;
  const seedNode = Object.values(workflow).find((node) => node.class_type === 'RandomNoise');
  if (seedNode?.inputs && normalized.seed !== undefined) seedNode.inputs.noise_seed = normalized.seed;
  if (mode === 'fl2v') bindFl2vReferences(workflow, normalized.references);
  if (mode === 'ref2va') bindRef2vaReferences(workflow, normalized.references);
  return workflow;
}

export class H3ComfyClient {
  private readonly baseUrl: string;
  private readonly workflowPath: string;
  private readonly useModeWorkflow: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly pollIntervalMs: number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly eventCheckIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly maxIdleMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatFailureLimit: number;

  constructor(private readonly options: H3ComfyClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.AIONUI_H3_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
    const configuredWorkflow = options.workflowPath ?? process.env.AIONUI_H3_WORKFLOW;
    this.workflowPath = configuredWorkflow ?? defaultWorkflowPath();
    this.useModeWorkflow = !configuredWorkflow;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.sleep = options.sleep;
    this.eventCheckIntervalMs = options.eventCheckIntervalMs ?? 30000;
    this.maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
    this.maxIdleMs = options.maxIdleMs ?? 10 * 60 * 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.heartbeatFailureLimit = Math.max(1, Math.floor(options.heartbeatFailureLimit ?? 3));
    for (const value of [
      this.maxWaitMs,
      this.maxIdleMs,
      this.heartbeatFailureLimit,
      options.cancelConfirmAttempts ?? 4,
    ])
      if (!Number.isFinite(value) || value <= 0) throw new Error('H3_MONITOR_OPTIONS_INVALID');
    for (const value of [
      this.pollIntervalMs,
      this.eventCheckIntervalMs,
      this.heartbeatIntervalMs,
      options.missingGraceMs ?? 60_000,
    ])
      if (!Number.isFinite(value) || value < 0) throw new Error('H3_MONITOR_OPTIONS_INVALID');
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async systemStats(): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`H3_COMFY_HTTP_${response.status}`);
    return response.json();
  }

  async queueStatus(): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/queue`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`H3_COMFY_QUEUE_HTTP_${response.status}`);
    return response.json();
  }

  async freeMemory(unloadModels = false): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/free`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: unloadModels, free_memory: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`H3_COMFY_FREE_HTTP_${response.status}`);
  }

  async fetchArtifact(artifact: H3Artifact, signal?: AbortSignal): Promise<Response> {
    if (!artifact.filename || artifact.filename.includes('..') || /[\\/]/.test(artifact.filename))
      throw new Error('H3_ARTIFACT_FILENAME_INVALID');
    if (artifact.subfolder.includes('..') || path.isAbsolute(artifact.subfolder))
      throw new Error('H3_ARTIFACT_SUBFOLDER_INVALID');
    const query = new URLSearchParams({
      filename: artifact.filename,
      subfolder: artifact.subfolder,
      type: artifact.type,
    });
    const response = await this.fetchImpl(`${this.baseUrl}/view?${query.toString()}`, { signal });
    if (!response.ok) throw new Error(`H3_ARTIFACT_HTTP_${response.status}`);
    return response;
  }

  /** A successful POST only acknowledges dispatch. Observe the target leaving the queue. */
  async cancel(promptId: string, requireKnown = false): Promise<H3GenerationResult | void> {
    const signal = AbortSignal.timeout(30_000);
    const response = await this.fetchImpl(`${this.baseUrl}/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
      method: 'POST',
      signal,
    });
    if (!response.ok) throw new Error(`H3_COMFY_INTERRUPT_HTTP_${response.status}`);
    const payload = (await response.json()) as { cancelled?: boolean };
    if (typeof payload?.cancelled !== 'boolean') throw new Error('H3_COMFY_CANCEL_INVALID_RESPONSE');
    let absent = 0;
    for (let attempt = 0; attempt < (this.options.cancelConfirmAttempts ?? 4); attempt++) {
      const state = await this.probeHeartbeat(promptId, signal);
      const history = await this.readHistory(promptId, signal);
      if (state === 'absent') {
        if (history?.status?.completed && history.status.status_str !== 'error')
          return this.settledResult(promptId, history);
        if (requireKnown && !payload.cancelled && !history?.status) throw new Error('H3_SUBMISSION_STATE_UNKNOWN');
        if (++absent >= 2) return;
      } else absent = 0;
      await this.pause(Math.min(1000, this.pollIntervalMs), signal);
    }
    throw new Error('H3_COMFY_CANCEL_UNCONFIRMED');
  }

  async confirmStopped(promptId: string, requireKnown = false): Promise<H3GenerationResult | void> {
    const signal = AbortSignal.timeout(25_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      if ((await this.probeHeartbeat(promptId, signal)) !== 'absent') throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
      const history = await this.readHistory(promptId, signal);
      if (history?.status?.completed && history.status.status_str !== 'error')
        return this.settledResult(promptId, history);
      if (requireKnown && !history?.status) throw new Error('H3_SUBMISSION_STATE_UNKNOWN');
      if (!attempt) await this.pause(Math.min(1000, this.pollIntervalMs), signal);
    }
  }

  /** Used only for legacy jobs whose submission ID was never persisted. */
  async confirmIdle(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const queue = this.parseQueue(await this.queueStatus());
      if (queue.queue_running.length || queue.queue_pending.length) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
      if (!attempt) await this.pause(1000, AbortSignal.timeout(5000));
    }
  }

  async generate(
    spec: H3GenerationSpec,
    signal: AbortSignal,
    onProgress?: H3Progress,
    onSubmitted?: H3PromptSubmitted,
    context?: H3MonitorContext
  ): Promise<H3GenerationResult> {
    if (signal.aborted) throw new Error('H3_JOB_CANCELLED');
    const normalized = normalizeH3GenerationSpec(spec);
    const mode = inferH3Mode(normalized);
    const workflowPath = this.useModeWorkflow
      ? workflowPathForMode(mode, this.options.bundleRoot?.())
      : this.workflowPath;
    if (!fs.existsSync(workflowPath)) throw new Error('H3_WORKFLOW_NOT_FOUND');
    const template = JSON.parse(fs.readFileSync(workflowPath, 'utf8')) as ApiWorkflow;
    const uploadPrefix = crypto.randomUUID();
    const uploadedReferences = await Promise.all(
      normalized.references.map(
        async (reference, index): Promise<H3Reference> => ({
          ...reference,
          path: await this.uploadReference(
            reference,
            `${uploadPrefix}-${index}-${path.basename(reference.path)}`,
            signal
          ),
        })
      )
    );
    const submittedSpec: H3NormalizedGenerationSpec = { ...normalized, references: uploadedReferences };
    const workflow = buildH3Workflow(template, submittedSpec, this.options.attentionBackend?.() ?? 'dense');
    const registry: ComfyRegistry = {};
    for (const nodeType of new Set(Object.values(workflow).map((node) => node.class_type))) {
      if (!nodeType) throw new Error('H3_WORKFLOW_FORMAT_INVALID');
      const info = await this.fetchImpl(`${this.baseUrl}/object_info/${encodeURIComponent(nodeType)}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (!info.ok) throw new Error(`H3_COMFY_OBJECT_INFO_HTTP_${info.status}`);
      Object.assign(registry, await info.json());
    }
    validateComfyWorkflow(workflow, registry);
    if (signal.aborted) throw new Error('H3_JOB_CANCELLED');
    const clientId = crypto.randomUUID();
    const events = new H3ComfyEvents(
      this.baseUrl,
      clientId,
      signal,
      Object.fromEntries(Object.entries(workflow).map(([id, node]) => [id, node.class_type ?? '']))
    );
    try {
      await events.open();
      if (signal.aborted) throw new Error('H3_JOB_CANCELLED');
      const reservedPromptId = crypto.randomUUID();
      onSubmitted?.(reservedPromptId, true);
      const response = await this.fetchImpl(`${this.baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId, prompt_id: reservedPromptId }),
        signal: AbortSignal.timeout(30000),
      });
      const payload = (await response.json()) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
      if (!response.ok || !payload.prompt_id) {
        if (response.status >= 400 && response.status < 500) throw diagnoseComfyError(payload, true);
        if (response.ok && (payload.error || payload.node_errors)) throw diagnoseComfyError(payload, true);
        throw new Error(`H3_COMFY_PROMPT_HTTP_${response.status}`);
      }
      onSubmitted?.(payload.prompt_id, false);
      if (signal.aborted) throw new Error('H3_JOB_CANCELLED');
      onProgress?.(0, { phase: 'waiting', updatedAt: new Date().toISOString() });
      return await this.resume(payload.prompt_id, signal, onProgress, events, context);
    } finally {
      events.close();
    }
  }

  private async uploadReference(reference: H3Reference, uploadName: string, signal: AbortSignal): Promise<string> {
    if (!fs.existsSync(reference.path) || !fs.statSync(reference.path).isFile())
      throw new Error('H3_REFERENCE_FILE_NOT_FOUND');
    if (!REFERENCE_EXTENSIONS[reference.type].has(path.extname(reference.path).toLowerCase()))
      throw new Error('H3_REFERENCE_TYPE_MISMATCH');
    const bytes = fs.readFileSync(reference.path);
    const form = new FormData();
    form.append('image', new Blob([bytes]), uploadName);
    form.append('type', 'input');
    const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
    const response = await this.fetchImpl(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      signal: uploadSignal,
    });
    if (!response.ok) throw new Error(`H3_REFERENCE_UPLOAD_HTTP_${response.status}`);
    const payload = (await response.json()) as { name?: string };
    if (!payload.name || payload.name.includes('..') || /[\\/]/.test(payload.name))
      throw new Error('H3_REFERENCE_UPLOAD_INVALID_RESPONSE');
    return payload.name;
  }

  async resume(
    promptId: string,
    signal: AbortSignal,
    onProgress?: H3Progress,
    events?: H3ComfyEvents,
    context?: H3MonitorContext
  ): Promise<H3GenerationResult> {
    const history = await this.waitForHistory(promptId, signal, onProgress, events, context);
    const result = this.resultFromHistory(promptId, history);
    onProgress?.(1);
    return result;
  }

  private settledResult(promptId: string, history: HistoryEntry): H3GenerationResult | void {
    try {
      return this.resultFromHistory(promptId, history);
    } catch (error) {
      // A terminal history with no video (or interruption) still proves termination.
      if (error instanceof Error && ['H3_COMFY_NO_OUTPUT', 'H3_JOB_CANCELLED'].includes(error.message)) return;
      throw error;
    }
  }

  private resultFromHistory(promptId: string, history: HistoryEntry): H3GenerationResult {
    if (history.status?.messages?.some((item) => Array.isArray(item) && item[0] === 'execution_interrupted'))
      throw new Error('H3_JOB_CANCELLED');
    if (history.status?.status_str === 'error') throw diagnoseComfyError(history);
    const artifacts = Object.values(history.outputs ?? {}).flatMap((output) => {
      const candidates = [
        ...(Array.isArray(output.images) ? output.images : []),
        ...(Array.isArray(output.videos) ? output.videos : []),
        ...(Array.isArray(output.gifs) ? output.gifs : []),
      ] as Array<{ filename?: string; subfolder?: string; type?: string }>;
      return candidates
        .filter((item) => item.filename && (item.type === undefined || item.type === 'output'))
        .map((item) => ({
          filename: item.filename!,
          subfolder: item.subfolder ?? '',
          type: item.type ?? 'output',
          mimeType: mimeType(item.filename!),
        }));
    });
    if (!artifacts.length) throw new Error('H3_COMFY_NO_OUTPUT');
    return { promptId, artifacts };
  }

  private async waitForHistory(
    promptId: string,
    signal: AbortSignal,
    onProgress?: H3Progress,
    events?: H3ComfyEvents,
    context?: H3MonitorContext
  ): Promise<HistoryEntry> {
    let delay = this.pollIntervalMs;
    let activity: H3Activity = context?.activity ?? { phase: 'waiting', updatedAt: new Date().toISOString() };
    onProgress?.(0, activity);
    const persistedStart = Date.parse(context?.startedAt ?? '');
    const startedAt = Number.isFinite(persistedStart) ? Math.min(persistedStart, Date.now()) : Date.now();
    let lastActivityAt = Date.parse(activity.updatedAt) || startedAt;
    let lastHistoryFingerprint = 'null';
    let lastHeartbeatAt = Date.now();
    let heartbeatFailures = 0;
    let historyFailures = 0;
    let missingSince: number | undefined;
    let remoteState: H3Monitor['remoteState'];
    let monitor: H3Monitor = { state: 'connected', consecutiveFailures: 0 };
    while (true) {
      if (signal.aborted) throw new Error('H3_JOB_CANCELLED');
      // History wins over deadlines and queue races, but every request is bounded.
      let entry: HistoryEntry | undefined;
      try {
        entry = await this.readHistory(promptId, signal);
        historyFailures = 0;
      } catch (error) {
        if (signal.aborted) throw new Error('H3_JOB_CANCELLED', { cause: error });
        historyFailures++;
      }
      if (entry?.status?.completed || entry?.status?.status_str === 'error') return entry;
      if (Date.now() - startedAt >= this.maxWaitMs) throw new Error('H3_COMFY_HISTORY_TIMEOUT');
      const historyFingerprint = JSON.stringify(entry ?? null);
      if (entry && historyFingerprint !== lastHistoryFingerprint) {
        lastHistoryFingerprint = historyFingerprint;
        lastActivityAt = Date.now();
      }
      const idle = Date.now() - lastActivityAt >= this.maxIdleMs;
      if (Date.now() - lastHeartbeatAt >= this.heartbeatIntervalMs || (idle && !remoteState)) {
        lastHeartbeatAt = Date.now();
        try {
          remoteState = await this.probeHeartbeat(promptId, signal);
          heartbeatFailures = 0;
          missingSince = remoteState === 'absent' && !historyFailures ? (missingSince ?? Date.now()) : undefined;
          monitor = {
            state: historyFailures
              ? 'reconnecting'
              : remoteState === 'absent'
                ? 'missing'
                : idle && remoteState === 'running'
                  ? 'suspected-stall'
                  : 'connected',
            remoteState,
            lastHeartbeatAt: new Date().toISOString(),
            consecutiveFailures: historyFailures,
          };
        } catch (error) {
          if (signal.aborted) throw new Error('H3_JOB_CANCELLED', { cause: error });
          heartbeatFailures++;
          missingSince = undefined;
          monitor = { ...monitor, state: 'reconnecting', consecutiveFailures: heartbeatFailures };
        }
        // Reachability must never rewrite the execution activity timestamp.
        onProgress?.(0, undefined, monitor);
        if (heartbeatFailures >= this.heartbeatFailureLimit) throw new Error('H3_COMFY_HEARTBEAT_LOST');
        if (missingSince !== undefined && Date.now() - missingSince >= (this.options.missingGraceMs ?? 60_000))
          throw new Error('H3_COMFY_PROMPT_LOST');
      }
      if (historyFailures >= this.heartbeatFailureLimit) throw new Error('H3_COMFY_HISTORY_UNAVAILABLE');
      // History polling does not establish execution progress.
      if (events?.connected) {
        const deadline =
          Date.now() +
          Math.max(
            1,
            Math.min(
              this.eventCheckIntervalMs,
              this.heartbeatIntervalMs || 1,
              this.maxWaitMs - (Date.now() - startedAt)
            )
          );
        while (events.connected && Date.now() < deadline) {
          const event = await events.next(promptId, deadline - Date.now());
          if (!event) break;
          if (event.type === 'execution_error')
            throw diagnoseComfyError({ status: { messages: [['execution_error', event.data]] } });
          if (event.type === 'execution_interrupted') throw new Error('H3_JOB_CANCELLED');
          if (event.type === 'execution_success') break;
          const previousActivity = activity;
          if (event.type === 'executing') {
            const nodeId = typeof event.data.node === 'string' ? event.data.node : undefined;
            activity = {
              phase: nodeId ? 'executing' : 'finalizing',
              nodeId,
              nodeType: typeof event.data.node_type === 'string' ? event.data.node_type : undefined,
              updatedAt: new Date().toISOString(),
            };
            if (previousActivity.phase !== activity.phase || previousActivity.nodeId !== activity.nodeId) {
              lastActivityAt = Date.now();
              onProgress?.(0, activity);
            } else activity = previousActivity;
            continue;
          }
          const { value, max } = event.data;
          if (
            typeof value === 'number' &&
            typeof max === 'number' &&
            Number.isFinite(value) &&
            Number.isFinite(max) &&
            max > 0 &&
            value >= 0 &&
            value <= max
          ) {
            const nodeId = typeof event.data.node === 'string' ? event.data.node : activity.nodeId;
            activity = {
              phase: 'node-progress',
              nodeId,
              nodeType:
                typeof event.data.node_type === 'string'
                  ? event.data.node_type
                  : nodeId === activity.nodeId
                    ? activity.nodeType
                    : undefined,
              value,
              max,
              updatedAt: new Date().toISOString(),
            };
            // Node progress is local to the current ComfyUI node. Do not
            // present it as overall job progress; the UI can render value/max.
            if (
              previousActivity.nodeId !== activity.nodeId ||
              previousActivity.value !== activity.value ||
              previousActivity.max !== activity.max
            ) {
              lastActivityAt = Date.now();
              onProgress?.(0, activity);
            } else activity = previousActivity;
          }
        }
      } else {
        await this.pause(Math.max(0, Math.min(delay, this.maxWaitMs - (Date.now() - startedAt))), signal);
        delay = Math.min(30000, Math.max(1, delay * 2));
      }
    }
  }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('H3_JOB_CANCELLED');
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(new Error('H3_JOB_CANCELLED'));
      };
      signal.addEventListener('abort', abort, { once: true });
      const done = (): void => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      if (this.sleep)
        this.sleep(ms).then(done, (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        });
      else timer = setTimeout(done, ms);
    });
  }

  private parseQueue(payload: unknown): { queue_running: unknown[][]; queue_pending: unknown[][] } {
    const queue = payload as { queue_running?: unknown; queue_pending?: unknown } | null;
    if (
      !queue ||
      !Array.isArray(queue.queue_running) ||
      !Array.isArray(queue.queue_pending) ||
      ![...queue.queue_running, ...queue.queue_pending].every(
        (item) => Array.isArray(item) && typeof item[1] === 'string'
      )
    )
      throw new Error('H3_COMFY_QUEUE_INVALID_RESPONSE');
    return queue as { queue_running: unknown[][]; queue_pending: unknown[][] };
  }

  private async readHistory(promptId: string, signal: AbortSignal): Promise<HistoryEntry | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`H3_COMFY_HISTORY_HTTP_${response.status}`);
    }
    const payload = (await response.json()) as Record<string, HistoryEntry>;
    return payload?.[promptId];
  }

  private async probeHeartbeat(promptId: string, signal: AbortSignal): Promise<'running' | 'queued' | 'absent'> {
    const response = await this.fetchImpl(`${this.baseUrl}/queue`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`H3_COMFY_HEARTBEAT_QUEUE_HTTP_${response.status}`);
    }
    const queue = this.parseQueue(await response.json());
    if (queue.queue_running.some((item) => item[1] === promptId)) return 'running';
    if (queue.queue_pending.some((item) => item[1] === promptId)) return 'queued';
    return 'absent';
  }
}
