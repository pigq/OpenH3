import { registerProductTool } from './toolAliases';
import { h3AgentSnapshot, h3GenerationSpecSchema, type H3Job } from '@/common/chat/document/h3Job';
import {
  comfyGenerationInputSchema,
  comfyFamilySchema,
  comfyInstallPlanSchema,
  comfyProfileSchema,
  type ComfyGenerationJob,
  type ComfyOperation,
} from '@/common/chat/document/creation/comfy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_VIDEO_MEDIA_NAME } from './constants';

const envValue = (canonical: string, legacy: string): string | undefined =>
  process.env[canonical] ?? process.env[legacy];
const port = () => Number(envValue('OPENH3_MEDIA_PORT', 'AIONUI_MEDIA_PORT') ?? 33002);
class MediaServiceError extends Error {
  constructor(
    message: string,
    readonly details?: { diagnosis?: unknown }
  ) {
    super(message);
  }
}
function formatServiceError(prefix: string, error: unknown): string {
  if (error instanceof MediaServiceError)
    return `${prefix}: ${JSON.stringify({ error: error.message, diagnosis: error.details?.diagnosis })}`;
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
async function call(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(path === '/api/comfy/operations' ? 300_000 : 45_000),
  });
  const data = await response.json();
  if (!response.ok) {
    if (path === '/api/h3/status' && response.status === 503 && data?.install) return data;
    const payload = data as { error?: string; diagnosis?: unknown };
    throw new MediaServiceError(payload.error ?? `MEDIA_SERVICE_HTTP_${response.status}`, {
      diagnosis: payload.diagnosis,
    });
  }
  if (data && typeof data.id === 'string' && Array.isArray(data.artifacts) && data.spec)
    return h3AgentSnapshot(data as H3Job);
  return data;
}

function creationRequestId(): string {
  const requestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID');
  if (!requestId?.trim()) throw new Error('CREATION_REQUEST_CONTEXT_MISSING');
  return requestId;
}

function jsonRequest(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function toolError(prefix: string, error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: formatServiceError(prefix, error) }] };
}

async function guardLegacyH3Submission(): Promise<void> {
  const requestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID');
  if (!requestId?.trim()) return;
  const result = (await call(`/api/comfy/profiles?${new URLSearchParams({ requestId })}`)) as { selection?: unknown };
  if (result.selection) {
    throw new Error(
      'COMFY_REGISTERED_PROFILE_REQUIRED: use comfyui-local and openh3_comfy_install/openh3_comfy_generate for the current selection; historical H3 tools are for earlier jobs'
    );
  }
  throw new Error('COMFY_SELECTION_CONTEXT_MISSING: inspect the current creation selection before submitting');
}

async function main() {
  const server = new McpServer(
    { name: BUILTIN_VIDEO_MEDIA_NAME, version: '1.0.0' },
    {
      instructions:
        'Use comfyui-local for local H3, FastH3-Omni, Qwen-Edit, Z-Image, FLUX 3 Image Klein, MOSS-Image-Base, MOSS-Image-SFT and Krea 2. Model-card installation metadata is submitted by the application: when an operationId is present, explain or inspect that operation without submitting another. For an unsubmitted installation request, call openh3_comfy_install with action=request, family, intent and optional profileId. The media service owns probing, pinned component selection, domestic-first downloads, installation and smoke verification; do not rebuild a plan or require environment tools before this call. Full-auto starts directly; other modes confirm once in the UI. Do not request extra chat confirmation or self-authorize. Generate with the selected registered profile; the service validates an unverified profile using the requested generation, without installing it. Pass ordered image/video/audio references from attachment paths for FastH3-Omni. Expand FLUX requests into full scene captions. Keep family and variant identities distinct. Incomplete probes, unavailable tools and gated sources are different failures. The client monitors background operations and outputs. End the turn after submission; do not repeatedly poll or resubmit. Legacy plans and H3 tools remain for existing clients and jobs.',
    }
  );
  const spec = {
    kind: z.enum(['probe', 'extract-frame', 'extract-audio', 'transcode']),
    sourcePath: z.string().min(1),
    outputPath: z.string().min(1).optional(),
    startSeconds: z.number().nonnegative().optional(),
    endSeconds: z.number().positive().optional(),
  };
  registerProductTool(
    server,
    'openh3_comfy_environment',
    'Inspect the actual local OS, hardware, Python, accelerator, kernels, network, and selected ComfyUI environment before planning installation or repair. Optional root/python/baseUrl select the runtime; pass exact immutable model or workflow URLs as sources to test reachability, HTTP Range support, and content length without downloading. Failed or incomplete probes require diagnosis; they do not prove unsupported hardware. This tool does not install or download anything.',
    {
      root: comfyProfileSchema.shape.environment.shape.root.optional(),
      python: z.string().min(1).optional(),
      baseUrl: comfyProfileSchema.shape.environment.shape.baseUrl.optional(),
      sources: z.array(z.string().url()).max(12).optional(),
    },
    async (input) => {
      try {
        const query = new URLSearchParams({ requestId: creationRequestId() });
        for (const [key, value] of Object.entries(input)) {
          if (value === undefined) continue;
          if (key === 'sources' && Array.isArray(value)) {
            for (const source of value) query.append('source', source);
          } else query.set(key, String(value));
        }
        return toolResult(await call(`/api/comfy/environment?${query}`));
      } catch (error) {
        return toolError('ComfyUI environment inspection failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_profiles',
    'List registered local profiles and the authoritative current session selection; register a discovered pinned component set; or revalidate with a required representative smokeInput. Revalidation submits a background validation job and returns comfyJobId, job, and validation:true; the UI monitors it. Registration never proves verification. Prefer an existing compatible verified profile and keep a component set atomic. No repeated full scans on the normal generation path.',
    {
      action: z.enum(['list', 'register', 'revalidate']),
      profile: comfyProfileSchema.optional(),
      profileId: z.string().min(1).optional(),
      smokeInput: comfyGenerationInputSchema.optional(),
    },
    async ({ action, profile, profileId, smokeInput }) => {
      try {
        if (action === 'list') {
          const optionalRequestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID')?.trim();
          const query = optionalRequestId ? `?${new URLSearchParams({ requestId: optionalRequestId })}` : '';
          return toolResult(await call(`/api/comfy/profiles${query}`));
        }
        const requestId = creationRequestId();
        if (action === 'register') {
          if (!profile) throw new Error('COMFY_PROFILE_REQUIRED');
          const { validation: _validation, ...candidate } = profile;
          return toolResult(
            await call(
              '/api/comfy/profiles',
              jsonRequest({ action, profile: { ...candidate, state: 'downloaded' }, requestId })
            )
          );
        }
        if (!profileId) throw new Error('COMFY_PROFILE_REQUIRED');
        return toolResult(await call('/api/comfy/profiles', jsonRequest({ action, profileId, smokeInput, requestId })));
      } catch (error) {
        return toolError('ComfyUI profile operation failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_install',
    'Prepare or manage a local ComfyUI installation/repair operation. For new model-card requests use action=request with family, intent (install, repair, or install-other), and optional profileId. The media service automatically probes this machine, selects one compatible pinned component set, prefers verified domestic sources, creates the plan, verifies downloads and runs a representative smoke test. Do not provide a hand-written plan or ask for a separate confirmation. The response distinguishes COMFY_TOOL_NOT_READY, COMFY_DETECTION_INCOMPLETE and COMFY_DEVICE_CONDITIONS_INSUFFICIENT. A complete plan on action=request or action=plan remains accepted for older clients. Full automatic approval starts directly; other modes require one UI confirmation. start is only for recovery of a previously authorized operation; status/cancel require the same operationId and request context. End your turn after request/start.',
    {
      action: z.enum(['request', 'plan', 'start', 'status', 'cancel']),
      plan: comfyInstallPlanSchema.optional(),
      family: comfyFamilySchema.optional(),
      intent: z.enum(['install', 'repair', 'install-other']).optional(),
      profileId: z.string().min(1).optional(),
      operationId: z.string().min(1).optional(),
    },
    async ({ action, plan, family, intent, profileId, operationId }) => {
      try {
        const requestId = creationRequestId();
        let operation: ComfyOperation;
        if (action === 'request' || action === 'plan') {
          if (action === 'plan' && !plan) throw new Error('COMFY_INSTALL_PLAN_REQUIRED');
          const install = plan
            ? { action: 'request' as const, plan }
            : family && intent
              ? { action: 'request' as const, family, intent, ...(profileId ? { profileId } : {}) }
              : (() => {
                  throw new Error('COMFY_INSTALL_REQUEST_REQUIRED: provide family and intent');
                })();
          operation = (await call(
            '/api/comfy/operations',
            jsonRequest(plan ? { plan, requestId } : { install, requestId })
          )) as ComfyOperation;
        } else {
          if (!operationId) throw new Error('COMFY_OPERATION_REQUIRED');
          const endpoint = `/api/comfy/operations/${encodeURIComponent(operationId)}`;
          operation = (await call(
            action === 'status' ? `${endpoint}?${new URLSearchParams({ requestId })}` : `${endpoint}/${action}`,
            action === 'status' ? undefined : jsonRequest({ requestId })
          )) as ComfyOperation;
        }
        return toolResult({ comfyOperationId: operation.id, operation });
      } catch (error) {
        return toolError('ComfyUI installation operation failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_generate',
    'Generate an image or video through the currently selected registered local ComfyUI profile. Downloaded/discovered profiles are validated using this generation; only validated output establishes verification. Pass profileId and input only; no install plan or repeated environment scan. FastH3-Omni requires at least one image or video: input.references is an ordered array of {type:image|video|audio,path:absolutePath}, preserved from chat attachments. Do not combine references with imagePaths. Maximum 9 images, 3 videos, 3 audio, 12 total; video soundtracks also consume audio/total slots. Reference clips must be 2-15 seconds, at most 15 seconds per modality. Prompt labels follow the official node: pictures, paired video soundtrack/video, then standalone audio. The service checks selection, family, state, media and bindings. Preserve the chosen model, source and parameters. Returns comfyJobId for the client to monitor; end your turn after submission.',
    { profileId: z.string().min(1), input: comfyGenerationInputSchema },
    async ({ profileId, input }) => {
      try {
        const job = (await call(
          '/api/comfy/jobs',
          jsonRequest({ profileId, input, requestId: creationRequestId() })
        )) as ComfyGenerationJob;
        return toolResult({ comfyJobId: job.id, job });
      } catch (error) {
        return toolError('ComfyUI generation failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_job_status',
    'Get one snapshot of an existing local ComfyUI image/video job and its output artifacts. Use the saved jobId; a disconnection does not imply the job stopped. The UI monitors ongoing jobs, so do not poll repeatedly or automatically submit a replacement.',
    { jobId: z.string().min(1) },
    async ({ jobId }) => {
      try {
        const job = (await call(
          `/api/comfy/jobs/${encodeURIComponent(jobId)}?${new URLSearchParams({ requestId: creationRequestId() })}`
        )) as ComfyGenerationJob;
        return toolResult({ comfyJobId: job.id, job });
      } catch (error) {
        return toolError('ComfyUI job query failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_cancel_job',
    'Cancel an existing local ComfyUI image/video job when the user requests cancellation. Do not resubmit it automatically or interrupt unrelated jobs.',
    { jobId: z.string().min(1) },
    async ({ jobId }) => {
      try {
        const job = (await call(
          `/api/comfy/jobs/${encodeURIComponent(jobId)}/cancel`,
          jsonRequest({ requestId: creationRequestId() })
        )) as ComfyGenerationJob;
        return toolResult({ comfyJobId: job.id, job });
      } catch (error) {
        return toolError('ComfyUI job cancellation failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_h3_install_video_model',
    'Prepare an installation card after the user chooses to install local MiniMax H3. request preserves the generation spec and returns creationOperationId. The user accepts terms/hardware in the existing installer UI; never accept on their behalf. start requires that saved UI confirmation and the same operationId. The background service installs then continues this original request automatically. End your turn after either action.',
    {
      action: z.enum(['request', 'start']),
      spec: h3GenerationSpecSchema.optional(),
      operationId: z.string().uuid().optional(),
    },
    async ({ action, spec, operationId }) => {
      try {
        await guardLegacyH3Submission();
        if (envValue('OPENH3_CREATION_SOURCE', 'AIONUI_CREATION_SOURCE') === 'cloud')
          throw new Error('CREATION_LOCAL_MODEL_NOT_SELECTED');
        if (envValue('OPENH3_CREATION_KIND', 'AIONUI_CREATION_KIND') === 'image')
          throw new Error('CREATION_VIDEO_NOT_SELECTED');
        const requestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID');
        if (!requestId) throw new Error('CREATION_REQUEST_CONTEXT_MISSING');
        if (action === 'request' && !spec) throw new Error('CREATION_GENERATION_SPEC_REQUIRED');
        if (action === 'start' && !operationId) throw new Error('CREATION_OPERATION_REQUIRED');
        const operation = (await call(
          action === 'request' ? '/api/creation/operations' : `/api/creation/operations/${operationId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action === 'request' ? { requestId, spec } : { requestId }),
          }
        )) as { id: string; state: string; jobId?: string };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                creationOperationId: operation.id,
                state: operation.state,
                jobId: operation.jobId,
                stopPolling: true,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: formatServiceError('H3 installation request failed', error) }],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_video_process',
    'Process a local video according to the user request. Use probe to inspect/decode, extract-frame for a still image, extract-audio for an audio track, or transcode for a new video copy. Never overwrite the source file.',
    spec,
    async (input) => {
      try {
        const result = await call('/api/media-jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: formatServiceError('Video processing failed', error),
            },
          ],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_video_job_status',
    'Query the status and progress of a previously created video processing job.',
    { jobId: z.string().min(1) },
    async ({ jobId }) => {
      try {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(await call(`/api/media-jobs/${encodeURIComponent(jobId)}`)) },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: formatServiceError('Video job query failed', error),
            },
          ],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_h3_generate_video',
    'Generate a short video with the local MiniMax H3 runtime. Leave mode as auto: no references routes to text-to-video; one image routes to first-frame video; two images route to first-and-last-frame video; three or more images, or any video/audio reference, routes to multimodal Ref2VA. The tool queues a job and returns its id; end your turn after submission. The UI monitors the job independently; do not poll in a loop or automatically resubmit failures.',
    {
      prompt: z.string().min(1).max(20_000),
      durationSeconds: z.number().min(4).max(15).optional(),
      megapixels: z.number().positive().max(2).optional(),
      seed: z.number().int().nonnegative().optional(),
      mode: z.enum(['auto', 't2v', 'fl2v', 'ref2va']).optional(),
      references: z
        .array(
          z
            .object({
              type: z.enum(['image', 'video', 'audio']).describe('The local reference media type.'),
              path: z
                .string()
                .min(1)
                .describe('Absolute local path supplied by the user or current conversation context.'),
            })
            .strict()
        )
        .max(12)
        .optional(),
    },
    async (input) => {
      try {
        await guardLegacyH3Submission();
        if (envValue('OPENH3_CREATION_SOURCE', 'AIONUI_CREATION_SOURCE') === 'cloud')
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'The user selected cloud video generation. No cloud video API is configured. Ask the user to configure one or explicitly select local MiniMax H3; do not silently use local generation.',
              },
            ],
          };
        if (envValue('OPENH3_CREATION_KIND', 'AIONUI_CREATION_KIND') === 'image')
          throw new Error('CREATION_VIDEO_NOT_SELECTED');
        const result = await call('/api/h3/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: formatServiceError('H3 generation failed', error),
            },
          ],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_h3_runtime_status',
    'Inspect whether the local offline MiniMax H3 runtime, model assets, and pinned ComfyUI nodes are ready before generating.',
    {},
    async () => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await call('/api/h3/status')) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: formatServiceError('H3 runtime status failed', error),
            },
          ],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_h3_queue_status',
    'Inspect the local ComfyUI queue before starting or diagnosing a long H3 generation. This is read-only.',
    {},
    async () => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await call('/api/h3/queue')) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: formatServiceError('H3 queue query failed', error) }],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_h3_free_memory',
    'Ask the local ComfyUI runtime to release cached model memory before a new H3 job. It never interrupts a running job.',
    { unloadModels: z.boolean().optional() },
    async ({ unloadModels }) => {
      try {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                await call('/api/h3/free-memory', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ unloadModels: unloadModels === true }),
                })
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: formatServiceError('H3 memory release failed', error) }],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_h3_acceleration_status',
    'Inspect the optional H3 acceleration backend. The product safely falls back to dense attention when Triton or compatible Python development files are unavailable.',
    {},
    async () => {
      try {
        const status = await call('/api/h3/status');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify((status as { acceleration?: unknown }).acceleration ?? { backend: 'unknown' }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: formatServiceError('H3 acceleration status failed', error) }],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_h3_job_status',
    'Query a local MiniMax H3 generation job and its output resources. activity describes backend node execution, not overall completion. progress is not an overall percentage for running jobs. Report activity.value/max only as current-node progress; without activity say overall progress is unknown. An unchanged timestamp cannot prove the task is advancing or stuck. Cancel ends generation, not resumable pause. Respect stopPolling and nextAction: end your turn after this snapshot. Never automatically retry or submit a replacement for failed or remoteUncertain jobs.',
    { jobId: z.string().min(1) },
    async ({ jobId }) => {
      try {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(await call(`/api/h3/jobs/${encodeURIComponent(jobId)}`)) },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: formatServiceError('H3 job query failed', error),
            },
          ],
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_h3_cancel_job',
    'Cancel a local H3 job or confirm remote termination for a failed remoteUncertain job. A cancellation acknowledgement alone does not prove termination. Do not loop on this tool.',
    { jobId: z.string().min(1) },
    async ({ jobId }) => {
      try {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                await call(`/api/h3/jobs/${encodeURIComponent(jobId)}?action=cancel`, { method: 'POST' })
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: formatServiceError('H3 job cancellation failed', error),
            },
          ],
        };
      }
    }
  );
  await server.connect(new StdioServerTransport());
}
main().catch((error) => {
  console.error('[VideoMediaMCP] Fatal error:', error);
  process.exit(1);
});
