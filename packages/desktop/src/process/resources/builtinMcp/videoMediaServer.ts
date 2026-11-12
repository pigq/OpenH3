import { registerProductTool } from './toolAliases';
import { generationAttemptRequestSchema } from '@/common/chat/document/creation/workflows/contracts';
import { registerResearchTools } from './research/register';
import { h3AgentSnapshot, h3GenerationSpecSchema, type H3Job } from '@/common/chat/document/h3Job';
import {
  comfyGenerationInputSchema,
  comfyModelFamilySchema,
  comfyInstallPlanSchema,
  comfyProfileSchema,
  comfyWorkflowRepairReason,
  type ComfyGenerationJob,
  type ComfyOperation,
} from '@/common/chat/document/creation/comfy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_VIDEO_MEDIA_NAME } from './constants';
import { cloudVideoInputSchema, type CloudVideoJob } from '@/common/chat/document/creation/cloudVideo';
import type { CreationOperation } from '@/common/chat/document/creation/operation';

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
  const timeout = AbortSignal.timeout(path === '/api/comfy/operations' ? 300_000 : 45_000);
  const response = await fetch(`http://127.0.0.1:${port()}${path}`, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
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

const statusWaitSchema = z
  .number()
  .int()
  .min(0)
  .max(30_000)
  .default(0)
  .describe(
    'Wait up to this many milliseconds for a terminal result. Use 30000 while the job is active; 0 reads one snapshot.'
  );

function waitForStatusCheck(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Wait only on existing scoped status reads; cancellation never interrupts the underlying generation. */
async function waitForJob(path: string, waitMs: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (!waitMs) return call(path, { signal });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('MEDIA_STATUS_WAIT_EXPIRED')), waitMs);
  const waiting = AbortSignal.any([signal, deadline.signal]);
  let latest: unknown;
  let interval = 1000;
  try {
    while (true) {
      waiting.throwIfAborted();
      latest = await call(path, { signal: waiting });
      const job = latest as { status: string; submissionUncertain?: boolean; remoteUncertain?: boolean };
      if (!['queued', 'running'].includes(job.status) || job.submissionUncertain || job.remoteUncertain) return latest;
      await waitForStatusCheck(interval, waiting);
      interval = Math.min(interval * 2, 5000);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.signal.aborted && latest !== undefined) return latest;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function acknowledgeComfyResult(
  job: ComfyGenerationJob,
  scope: ReturnType<typeof comfyScope>,
  signal: AbortSignal
): Promise<{ acknowledged: boolean; error?: string } | undefined> {
  signal.throwIfAborted();
  if (!['succeeded', 'failed', 'cancelled'].includes(job.status) || job.submissionUncertain || !job.updatedAt)
    return undefined;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('COMFY_ACKNOWLEDGEMENT_TIMEOUT')), 5000);
  try {
    return (await call(`/api/comfy/jobs/${encodeURIComponent(job.id)}/acknowledge`, {
      ...jsonRequest({ ...scope, updatedAt: job.updatedAt }),
      signal: AbortSignal.any([signal, deadline.signal]),
    })) as { acknowledged: boolean };
  } catch (error) {
    signal.throwIfAborted();
    return { acknowledged: false, error: formatServiceError('Terminal observation acknowledgement failed', error) };
  } finally {
    clearTimeout(timer);
  }
}

async function acknowledgeComfyOperation(
  operation: ComfyOperation,
  scope: ReturnType<typeof comfyScope>,
  signal: AbortSignal
): Promise<{ acknowledged: boolean; error?: string } | undefined> {
  signal.throwIfAborted();
  if (!['completed', 'failed', 'cancelled'].includes(operation.state) || !operation.updatedAt) return undefined;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('COMFY_ACKNOWLEDGEMENT_TIMEOUT')), 5000);
  try {
    return (await call(`/api/comfy/operations/${encodeURIComponent(operation.id)}/acknowledge`, {
      ...jsonRequest({ ...scope, updatedAt: operation.updatedAt }),
      signal: AbortSignal.any([signal, deadline.signal]),
    })) as { acknowledged: boolean };
  } catch (error) {
    signal.throwIfAborted();
    return { acknowledged: false, error: formatServiceError('Terminal operation acknowledgement failed', error) };
  } finally {
    clearTimeout(timer);
  }
}

function creationRequestId(): string {
  const requestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID');
  if (!requestId?.trim()) throw new Error('CREATION_REQUEST_CONTEXT_MISSING');
  return requestId;
}
function comfyScope(): { requestId?: string; conversationId?: string } {
  const requestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID');
  if (requestId?.trim()) return { requestId };
  const conversationId = envValue('OPENH3_CONVERSATION_ID', 'AIONUI_CONVERSATION_ID');
  if (!conversationId?.trim()) throw new Error('COMFY_CONVERSATION_CONTEXT_MISSING');
  return { conversationId };
}

function jsonRequest(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** A completed observation does not complete the user's generation or repair goal. */
function comfyJobResult(result: { comfyJobId: string; job: ComfyGenerationJob; [key: string]: unknown }) {
  const { job } = result;
  const terminal = !['queued', 'running'].includes(job.status);
  const workflowRepair = comfyWorkflowRepairReason(job);
  const nextAction = job.submissionUncertain
    ? {
        type: 'recover-existing-job',
        instruction:
          'Recover this existing submission and prompt identity before further generation. Do not resubmit; a monitoring failure does not prove GPU work stopped.',
      }
    : !terminal
      ? {
          type: 'monitor-same-job',
          tool: 'openh3_comfy_job_status',
          waitMs: 30000,
          instruction:
            'Keep the Agent turn active and monitor this same job ID until a terminal result. A bounded wait expiring or a UI card appearing is not completion.',
        }
      : job.status === 'succeeded'
        ? {
            type: 'inspect-result-and-continue',
            instruction:
              'Inspect the actual artifacts against the requested media and constraints, show the result in this conversation and continue remaining authorized work before the final answer.',
          }
        : job.status === 'cancelled'
          ? { type: 'respect-cancellation', instruction: 'Respect the cancellation. Do not resubmit automatically.' }
          : workflowRepair
            ? {
                type: 'repair-workflow-and-continue',
                reason: workflowRepair,
                instruction:
                  'The selected workflow lacks or has not verified the required input route; its default graph is not the model capability ceiling. Continue the original user goal in this conversation under current authorization. Inspect this job snapshot and original inputs, the selected profile, actual runtime/node schemas and supported upstream workflows. Reuse a suitable existing variant or add the missing dependencies, nodes and connected conditioning route; preserve the selected model weights/precision, original references in order and requested output constraints. A LoadImage node alone is not reference conditioning, and structural control is not evidence of identity-preserving editing. Register the repaired profile variant, revalidate it with the original input, monitor the same validation job, then adopt-repair in this conversation after success and inspect/show the actual result. Do not require a model-card visit or repeat an unchanged submission. automaticRetryAllowed=false prohibits blind replay, not diagnosed repair. If the native adapter cannot express supported video/audio inputs, use an evidenced compatible workflow through general execution tools and openh3_comfy_observe_prompt to retain monitoring and results; never discard inputs or invent native bindings. Only report a blocker after checking supported routes, with the concrete missing capability; do not claim an unsupported capability was repaired.',
              }
            : {
                type: 'diagnose-and-continue',
                instruction:
                  'This attempt is terminal; the user goal remains active. Inspect this job diagnosis and diagnosticLogPath, the actual selected runtime root and interpreter, and relevant startup logs. For an H3 acceleration failure inspect openh3_h3_acceleration_status and the actual dependency or kernel failure; a dense backend report does not prove this selected workflow supports dense attention. Continue permitted repair under current authorization, preserve the chosen model and original parameters, validate the repaired route, then resume the original goal. Do not repeat an unchanged submission or end the goal merely because this attempt failed. Recover active or uncertain GPU work first.',
              };
  return toolResult({
    ...result,
    terminal,
    stopPolling: terminal || job.submissionUncertain === true,
    automaticRetryAllowed: false,
    nextAction: { ...nextAction, jobId: job.id, sameGoal: job.status !== 'cancelled' },
  });
}

function legacyInstallationResult(operation: CreationOperation) {
  const active = ['authorized', 'installing', 'cancelling'].includes(operation.state);
  const nextAction =
    operation.state === 'awaiting-consent'
      ? {
          type: 'await-user-consent',
          instruction: 'Wait for the existing installation card confirmation. Never accept terms on the user’s behalf.',
        }
      : operation.state === 'submitted' && operation.jobId
        ? { type: 'monitor-same-job', tool: 'openh3_h3_job_status', jobId: operation.jobId, waitMs: 30000 }
        : active
          ? {
              type: 'monitor-same-operation',
              tool: 'openh3_h3_install_video_model',
              action: 'status',
              operationId: operation.id,
              instruction:
                'Remain engaged and inspect this same operation with bounded spaced checks. Do not start another installation or report queued work as complete.',
            }
          : operation.state === 'cancelled'
            ? { type: 'respect-cancellation', instruction: 'Respect cancellation; do not start a replacement.' }
            : {
                type: 'diagnose-and-continue',
                instruction:
                  'Inspect this saved operation and its actual runtime logs, then continue permitted repair of the same goal. Do not repeat the unchanged failed action or compete with active or uncertain work.',
              };
  return toolResult({
    creationOperationId: operation.id,
    state: operation.state,
    jobId: operation.jobId,
    ...(operation.error ? { error: operation.error } : {}),
    stopPolling: !active,
    automaticRetryAllowed: false,
    nextAction,
  });
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
        'For local model installation tasks, a card supplies the user target, curated knowledge and acceptance criteria. The Agent owns the plan and execution, just as for a direct chat installation. Inspect existing profiles/environment and read openh3_comfy_model_guide for the selected family. Use command, file and web tools to reuse, install or repair according to actual evidence. openh3_comfy_install is an optional fixed-recipe executor, never a prerequisite or the only permitted path. Inspect saved operations before working; do not start competing processes while managed state is active or unknown. After a confirmed terminal installer failure, continue the goal using permitted general tools. Register a real component set as downloaded, then use openh3_comfy_profiles revalidate for representative generation. Validation results return to this conversation. After success call openh3_comfy_installation_complete to expose the verified model in the application. Guide recipes are knowledge, not proof of compatibility. Preserve selected family and explicit profile/precision choice, current approvals, source access, hashes, original parameters and other environments. Generate through the selected registered profile. Keep ordered media references for FastH3-Omni and full scene captions for FLUX. Even for a single output, keep working after submission: retain the job ID, monitor the same job to its terminal result with status waitMs=30000, inspect outputs and continue all authorized work before the final answer. Revalidation follows the same rule. UI cards and application callbacks supplement monitoring; queued/running states are not completed delivery. A bounded wait expiring means continue monitoring the same ID. Diagnose failures and continue permitted repair under the current approval mode. Never resubmit to monitor progress or claim submission or downloaded files as verified success.',
    }
  );
  registerResearchTools(server);
  registerProductTool(
    server,
    'openh3_comfy_observe_prompt',
    'Attach an ALREADY SUBMITTED local ComfyUI prompt to this chat. Use immediately after a direct HTTP /prompt fallback, including when profile inventory is unavailable. Supply the real promptId, loopback baseUrl and image/video kind. Never submit another prompt. The application persists read-only monitoring, retrieves/decodes outputs and shows the usual result card in this conversation; it does not install, interrupt or verify any model profile. Returns comfyJobId and job; retain the real comfyJobId. Keep working, even for a single output: monitor the same job with openh3_comfy_job_status waitMs=30000 until a terminal result, inspect outputs, and continue authorized work before the final answer. If the bounded wait returns queued/running, call status again with the same ID. The UI card is not completed delivery. If handoff fails, monitor the same prompt through /history/{promptId}, retrieve outputs via /view, save them locally and return actual output links before continuing remaining work. Never resubmit to monitor progress or repair a missing result card.',
    { promptId: z.string().uuid(), baseUrl: z.string().url(), kind: z.enum(['image', 'video']) },
    async (input) => {
      try {
        return comfyJobResult(
          (await call('/api/comfy/observe-prompt', jsonRequest({ ...input, ...comfyScope() }))) as {
            comfyJobId: string;
            job: ComfyGenerationJob;
          }
        );
      } catch (error) {
        return toolError('ComfyUI prompt observation failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_model_guide',
    'Read curated installation knowledge without starting an installer or selecting a recipe. First returns candidate summaries, reference paths and available private bootstrap tools; provide candidateId for its exact components and matching workflow. Inspect the actual machine and choose/adapt installation with command/file/web tools. Catalog pins are provenance, not a requirement to replace a compatible existing environment. Without a card binding, provide family explicitly.',
    { family: comfyModelFamilySchema.optional(), candidateId: z.string().min(1).optional() },
    async ({ family, candidateId }) => {
      try {
        const selectedFamily = envValue('OPENH3_CREATION_FAMILY', 'AIONUI_CREATION_FAMILY');
        const query = new URLSearchParams({ family: comfyModelFamilySchema.parse(family ?? selectedFamily) });
        if (candidateId) query.set('candidateId', candidateId);
        return toolResult(await call(`/api/comfy/model-guide?${query}`));
      } catch (error) {
        return toolError('Model installation guide unavailable', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_installation_complete',
    'Finish an Agent-led model installation or model-card repair using a real successful validation job from openh3_comfy_profiles revalidate. A model-card repair may register and validate a workflow/runtime variant under a new profile ID; completion preserves the original model components and precision, requires the unchanged request selection, and activates the validated variant. Requires the same request/family, unchanged verified profile fingerprint, and no competing active managed installation. Records a completed receipt with the application Use model action. Plain chats use their conversation context; a model-card request is not required. Generation workflow repairs use profiles action=adopt-repair instead. Files, registration or an Agent success claim cannot replace real generation validation.',
    { jobId: z.string().min(1) },
    async ({ jobId }) => {
      try {
        const operation = (await call(
          '/api/comfy/agent-installation-complete',
          jsonRequest({ ...comfyScope(), jobId })
        )) as ComfyOperation;
        return toolResult({ comfyOperationId: operation.id, operation });
      } catch (error) {
        return toolError('Model installation completion rejected', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_sources',
    'Find byte-identical sources for a selected model component. Checks ModelScope, hf-mirror and Hugging Face metadata, pins revisions, and compares catalog size and SHA-256. Optional repositories come from web search (owner/name). Returns verified candidates and per-provider diagnostics, not installation success. Use returned URLs as sourceOverrides on request/recover.',
    {
      component: z.string().min(1),
      repositories: z
        .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
        .max(4)
        .optional(),
    },
    async ({ component, repositories }) => {
      try {
        return toolResult(
          await call('/api/comfy/sources', jsonRequest({ requestId: creationRequestId(), component, repositories }))
        );
      } catch (error) {
        return toolError('Model source discovery failed', error);
      }
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
    'openh3_cloud_video_generate',
    'Generate a cloud video using the connection selected in the client. Provide prompt, optional duration/width/height/seed, and ordered absolute imagePaths. H3 supports text, first frame or first+last frame (at most two images); deployed H3 does not support Ref2VA, video or audio inputs. H3 defaults to 4.4 seconds and 24fps; explicit sizes require short side 768 and multiples of 32. OpenAI video supports at most one image and seconds/size; omit seed/aspectRatio. Never install or start local ComfyUI for a cloud selection. Returns cloudVideoJobId and job; retain the real job ID and submissionId. Keep working, even for a single output: monitor the same job with openh3_cloud_video_status waitMs=30000 until a terminal result, inspect outputs, and continue authorized work before the final answer. If the bounded wait returns queued/running, call status again with the same ID. At terminal failure stop repeated polling, diagnose and continue permitted repair; an uncertain submission requires recovering its original identity before further generation. Never resubmit to monitor progress or automatically retry unchanged failures.',
    {
      input: cloudVideoInputSchema,
      submissionId: z
        .string()
        .uuid()
        .describe(
          'A new UUID for each user-requested generation. Reuse this exact UUID when recovering a lost response. Never create a replacement UUID to retry automatically.'
        ),
    },
    async ({ input, submissionId }) => {
      try {
        if (
          envValue('OPENH3_CREATION_SOURCE', 'AIONUI_CREATION_SOURCE') !== 'cloud' ||
          envValue('OPENH3_CREATION_KIND', 'AIONUI_CREATION_KIND') !== 'video'
        )
          throw new Error('CLOUD_VIDEO_NOT_SELECTED');
        const job = (await call(
          '/api/cloud-video/jobs',
          jsonRequest({ requestId: creationRequestId(), submissionId, input })
        )) as CloudVideoJob;
        return toolResult({
          cloudVideoJobId: job.id,
          job,
          stopPolling: job.status !== 'queued' && job.status !== 'running',
          automaticRetryAllowed: false,
        });
      } catch (error) {
        return toolError('Cloud video generation failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_cloud_video_status',
    'Read an existing cloud video job using its saved jobId. Set waitMs=30000 to wait up to 30 seconds with spaced read-only checks, returning early for a terminal result or uncertain submission; waitMs=0 returns one snapshot. Keep monitoring the same job while queued/running, even for a single output. A wait timeout is not completion: call status again, inspect outputs at the terminal result, and continue authorized work before the final answer. Cancelling this status wait stops observation only. stopPolling ends repeated status checks for a terminal job, not the original goal: diagnose failed jobs and continue permitted repair. Recover uncertain submissions using their original identity before further generation. Never resubmit to monitor progress or automatically retry unchanged failures.',
    { jobId: z.string().uuid(), waitMs: statusWaitSchema },
    async ({ jobId, waitMs }, { signal }) => {
      try {
        const job = (await waitForJob(
          `/api/cloud-video/jobs/${encodeURIComponent(jobId)}?${new URLSearchParams({ requestId: creationRequestId() })}`,
          waitMs,
          signal
        )) as CloudVideoJob;
        return toolResult({
          cloudVideoJobId: jobId,
          job,
          stopPolling: job.status !== 'queued' && job.status !== 'running',
          automaticRetryAllowed: false,
        });
      } catch (error) {
        return toolError('Cloud video query failed', error);
      }
    }
  );
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
        const query = new URLSearchParams();
        const optionalRequestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID');
        if (optionalRequestId) query.set('requestId', optionalRequestId);
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
    'List registered/discovered profiles, inventory completeness and per-path diagnostics with the authoritative session selection. An incomplete path must not hide other models; inspect diagnostics rather than assuming no models exist. Register a pinned component set for any local image or video model, including custom families outside the bundled cards. Use its real stable lowercase family slug, display name and explicit kind; never relabel a custom model as a built-in family. Ordinary chats use their conversation context without requiring a model-card request. Registration adds the entry to the model selector; verify the returned inventory before reporting configuration complete. Revalidate with a representative smokeInput. Revalidation returns comfyJobId, job and validation:true. Keep working and monitor revalidation with openh3_comfy_job_status waitMs=30000 until a terminal result; inspect actual output before completion/adoption, and diagnose failures to continue permitted repair. A queued validation or UI card is not completion. Registration never proves verification. For a newly user-requested installation target in this chat, pass installationIntent=install or install-other on register and revalidate; the service derives a linked installation scope, preserves the previous generation selection and returns validation to this conversation. No fixed installer is required. Call openh3_comfy_installation_complete with the successful validation job. For a generation workflow repair, register a new variant with actual nodes, bindings and revisions; revalidate it with the original inputs, then use action=adopt-repair with profileId and that successful jobId to activate it in the same conversation. Adoption preserves the selected model components and precision. Keep component sets atomic. No repeated full scans on normal generation.',
    {
      action: z.enum(['list', 'register', 'revalidate', 'adopt-repair']),
      profile: comfyProfileSchema.optional(),
      profileId: z.string().min(1).optional(),
      smokeInput: comfyGenerationInputSchema.optional(),
      jobId: z.string().uuid().optional(),
      installationIntent: z.enum(['install', 'install-other']).optional(),
      attempt: generationAttemptRequestSchema.optional(),
    },
    async ({ action, profile, profileId, smokeInput, jobId, installationIntent, attempt }) => {
      try {
        if (action === 'list') {
          const optionalRequestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID')?.trim();
          const query = new URLSearchParams({
            inventory: '1',
            ...(optionalRequestId ? { requestId: optionalRequestId } : {}),
          });
          return toolResult(await call(`/api/comfy/profiles?${query}`));
        }
        const scope = comfyScope();
        if (action === 'register') {
          if (!profile) throw new Error('COMFY_PROFILE_REQUIRED');
          const { validation: _validation, ...candidate } = profile;
          return toolResult(
            await call(
              '/api/comfy/profiles',
              jsonRequest({ action, profile: { ...candidate, state: 'downloaded' }, ...scope, installationIntent })
            )
          );
        }
        if (!profileId) throw new Error('COMFY_PROFILE_REQUIRED');
        const result = await call(
          '/api/comfy/profiles',
          jsonRequest({
            action,
            profileId,
            smokeInput,
            jobId,
            ...scope,
            installationIntent,
            ...(attempt ? { attempt } : {}),
          })
        );
        return action === 'revalidate'
          ? comfyJobResult(result as { comfyJobId: string; job: ComfyGenerationJob })
          : toolResult(result);
      } catch (error) {
        return toolError('ComfyUI profile operation failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_install',
    'Optionally execute or manage a fixed-recipe local ComfyUI installation/repair. This tool is not required before using command/file/web tools. Prefer inspecting actual installed environments with model-guide knowledge first. The Agent owns conversation, diagnosis and recovery; this tool performs detection, pinned planning, verified downloads and representative validation. request accepts family, intent (install, repair, install-other), optional profileId, and sourceOverrides for exact component filenames with candidate HTTPS file URLs. Use sourceOverrides only after source failure; the planner accepts Hugging Face, hf-mirror, and ModelScope hosts, probes the exact files, and the downloader still verifies pinned size and SHA-256. status without operationId inspects preparations and operations for this bound request; use it after ambiguous submission errors before any retry. status with operationId inspects that operation. For safe COMFY_EXISTING_RUNTIME_INCOMPATIBLE, bootstrap:python-venv and legacy missing-Git failures, automatic session approval replans runtime and continues on the same operation. With manual approval, recover replans only the runtime, preserves model/workflow identity, and obtains fresh approval under the session policy. Windows includes private Git and a complete Python with venv/pip; do not require a system Git installation. Otherwise recover resumes the same failed/paused authorized plan after diagnosis and a relevant permitted repair, with at most two persisted recovery attempts per failed stage (ten overall) and an earlier stop for repeated identical errors. It cannot grant consent or bypass integrity, source, hardware or selection restrictions. start supports an already authorized operation; cancel requires user cancellation. A generation conversation can request intent=repair for its selected profile directly; the application creates a linked repair scope without changing its generation intent. For a newly user-requested model, request its actual family with intent=install or install-other; the application derives a separate linked installation in this same conversation and preserves the earlier generation selection. Do not send the user back to a model card. Missing supported nodes or reference workflows should be repaired with general tools and a validated workflow variant, rather than repeating a fixed recipe that lacks the required capability. Full-auto starts directly; other modes use one UI confirmation. Remain engaged and use status on the same operation with bounded spaced checks; inspect terminal results and continue diagnosis or verified completion. Existing application continuation is a fallback if the session is interrupted, not an instruction to end early. Complete plans remain accepted for legacy clients.',
    {
      action: z.enum(['request', 'plan', 'start', 'recover', 'status', 'cancel']),
      plan: comfyInstallPlanSchema.optional(),
      family: comfyModelFamilySchema.optional(),
      kind: z.enum(['image', 'video']).optional().describe('Required for a custom model without a registered profile.'),
      intent: z.enum(['install', 'repair', 'install-other']).optional(),
      profileId: z.string().min(1).optional(),
      sourceOverrides: z
        .array(z.object({ component: z.string().min(1), urls: z.array(z.string().url()).min(1).max(4) }))
        .max(64)
        .optional(),
      operationId: z.string().min(1).optional(),
    },
    async ({ action, plan, family, kind, intent, profileId, sourceOverrides, operationId }, { signal }) => {
      try {
        const scope = comfyScope();
        let operation: ComfyOperation;
        if (action === 'status' && !operationId) {
          return toolResult(await call(`/api/comfy/activity?${new URLSearchParams(scope)}`));
        }
        if (action === 'request' || action === 'plan') {
          if (action === 'plan' && !plan) throw new Error('COMFY_INSTALL_PLAN_REQUIRED');
          const install = plan
            ? { action: 'request' as const, plan }
            : family && intent
              ? {
                  action: 'request' as const,
                  family,
                  ...(kind ? { kind } : {}),
                  intent,
                  ...(profileId ? { profileId } : {}),
                  ...(sourceOverrides?.length ? { sourceOverrides } : {}),
                }
              : (() => {
                  throw new Error('COMFY_INSTALL_REQUEST_REQUIRED: provide family and intent');
                })();
          operation = (await call(
            '/api/comfy/operations',
            jsonRequest(plan ? { plan, ...scope } : { install, ...scope })
          )) as ComfyOperation;
        } else {
          if (!operationId) throw new Error('COMFY_OPERATION_REQUIRED');
          const endpoint = `/api/comfy/operations/${encodeURIComponent(operationId)}`;
          operation = (await call(
            action === 'status' ? `${endpoint}?${new URLSearchParams(scope)}` : `${endpoint}/${action}`,
            action === 'status'
              ? { signal }
              : jsonRequest({ ...scope, ...(action === 'recover' ? { sourceOverrides } : {}) })
          )) as ComfyOperation;
        }
        const acknowledgement =
          action === 'status' && operationId ? await acknowledgeComfyOperation(operation, scope, signal) : undefined;
        const result = { comfyOperationId: operation.id, operation, ...(acknowledgement ? { acknowledgement } : {}) };
        if (operation.state === 'failed')
          return {
            isError: true,
            ...toolResult({
              ...result,
              nextAction: {
                type: 'diagnose-and-continue',
                sameGoal: true,
                retryUnchangedPlan: false,
                instruction:
                  'This managed execution is terminal and failed; the user installation goal remains active. Inspect its plan environment, diagnosis and snapshot logs. Check this session capability registry for actual command/file/web tools if needed, inspect the real running ComfyUI root and interpreter, then perform a permitted repair or continue through general tools. Calling request again returns this saved operation; it does not repair or replan it. Do not submit a competing installer while any related work is active or uncertain, change the chosen model, bypass permissions or integrity, or claim completion without real generation validation.',
              },
            }),
          };
        return toolResult(result);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          ...toolResult({
            error: {
              code: detail.match(/\b(?:COMFY|NETWORK|H3|CREATION|MEDIA)_[A-Z_]+\b/)?.[0] ?? 'COMFY_INSTALL_FAILED',
              details: detail,
              diagnosis: error instanceof MediaServiceError ? error.details?.diagnosis : undefined,
              hint: 'Inspect status and the failed step first. Recover the saved operation after a relevant repair, or after confirming terminal state continue the same goal with permitted general tools when the fixed executor cannot handle that step. Never compete with active or unknown work, fabricate validation, or bypass integrity, permissions or hardware requirements.',
            },
          }),
        };
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_generate',
    'Generate through a compatible workflow of the selected local model and precision. In ordinary conversations, choose a registered profile matching the user goal; no model-card binding is required. Resolve the intended task and reference roles before submission with openh3_comfy_resolve_workflow. Pass the resolved profileId, semantic input.requirements/references, and a stable attempt object. Automatic mode selects within the same model; fixed mode keeps the exact chosen route. Downloaded routes validate with this real user generation. A missing capability requires preparation before GPU submission; keep working in this conversation. No install plan or repeated environment scan. FastH3-Omni requires at least one image or video: input.references is an ordered array of {type:image|video|audio,path:absolutePath}, from actual attachments or explicitly identified generated intermediate assets. For original text-only creative scenes, prepare a suitable image with an available image tool and continue; do not default to asking for an upload. Specific supplied subjects still need their real source. Do not combine references with imagePaths. Maximum 9 images, 3 videos, 3 audio, 12 total; video soundtracks also consume audio/total slots. Reference clips must be 2-15 seconds, at most 15 seconds per modality. Prompt labels follow the official node: pictures, paired video soundtrack/video, then standalone audio. The service checks selection, family, state, media and bindings. Preserve the chosen model, source and parameters. Returns comfyJobId and job; retain the real comfyJobId. Keep working, even for a single output: monitor the same job with openh3_comfy_job_status waitMs=30000 until a terminal result, inspect outputs, and continue authorized work before the final answer. If the bounded wait returns queued/running, call status again with the same ID. On failure inspect diagnostics and perform permitted repair under the current approval mode. The UI card is not completed delivery. Never resubmit to monitor progress or after an uncertain response; recover the existing job.',
    {
      profileId: z.string().min(1),
      input: comfyGenerationInputSchema,
      attempt: generationAttemptRequestSchema
        .optional()
        .describe(
          'Use a stable taskId for the user output and attemptId for this submission. Reuse both after a lost response. A repair uses a new attemptId and predecessorAttemptId only after confirmed failure. New output uses a new taskId.'
        ),
    },
    async ({ profileId, input, attempt }) => {
      try {
        const job = (await call(
          '/api/comfy/jobs',
          jsonRequest({ profileId, input, ...(attempt ? { attempt } : {}), ...comfyScope() })
        )) as ComfyGenerationJob;
        return comfyJobResult({ comfyJobId: job.id, job });
      } catch (error) {
        if (error instanceof Error && error.message.includes('COMFY_OMNI_REFERENCE_REQUIRED')) {
          return toolResult(
            await call('/api/comfy/workflows/resolve', jsonRequest({ ...comfyScope(), profileId, input }))
          );
        }
        return toolError('ComfyUI generation failed', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_resolve_workflow',
    'Resolve a workflow within the selected model and precision before generation. In ordinary conversations pass the chosen profileId; without it the tool returns model choices. A model-card session retains its authoritative user selection. Provide the intended task in input.requirements and explicit reference roles (edit-source, identity, style, structure, first-frame, last-frame, mask, reference). resolve is read-only. action=prepare-reference returns instructions to create a real intermediate image for an original text-only Omni goal; follow nextAction without changing the final model. prepare writes vetted lightweight workflow variants using existing weights and nodes; it does not download weights or start a runtime. During installation call prepare with the installed profileId. Missing routes include concrete constraints: use the model guide and general tools to prepare supported dependencies/graphs, register the variant, resolve again, then submit the original goal. A plain image-to-image workflow does not establish identity preservation. Do not switch models, discard references or resubmit active/uncertain tasks.',
    {
      action: z.enum(['resolve', 'prepare']).default('resolve'),
      input: comfyGenerationInputSchema.optional(),
      profileId: z.string().optional(),
    },
    async ({ action, input, profileId }) => {
      try {
        if (action === 'resolve' && !input) throw new Error('COMFY_GENERATION_INPUT_REQUIRED');
        if (action === 'prepare' && !profileId) throw new Error('COMFY_PROFILE_REQUIRED');
        return toolResult(
          await call(
            `/api/comfy/workflows/${action}`,
            jsonRequest({
              ...comfyScope(),
              ...(profileId ? { profileId } : {}),
              ...(action === 'resolve' ? { input } : {}),
            })
          )
        );
      } catch (error) {
        return toolError('ComfyUI workflow preparation required', error);
      }
    }
  );
  registerProductTool(
    server,
    'openh3_comfy_job_status',
    'Read an existing local ComfyUI generation, revalidation or observed external prompt using its saved jobId. Set waitMs=30000 to wait up to 30 seconds with spaced read-only checks, returning early for a terminal result or uncertain submission; waitMs=0 returns one snapshot. Keep monitoring the same job while queued/running, even for a single output. A wait timeout is not completion: call status again, inspect outputs at the terminal result, and continue authorized work before the final answer. Diagnose failures and continue permitted repair under the current approval mode. Cancelling this status wait stops observation only. A disconnection does not imply the job stopped; recover the existing job. Never resubmit to monitor progress or after an uncertain response.',
    { jobId: z.string().min(1), waitMs: statusWaitSchema },
    async ({ jobId, waitMs }, { signal }) => {
      try {
        const scope = comfyScope();
        const job = (await waitForJob(
          `/api/comfy/jobs/${encodeURIComponent(jobId)}?${new URLSearchParams(scope)}`,
          waitMs,
          signal
        )) as ComfyGenerationJob;
        const acknowledgement = await acknowledgeComfyResult(job, scope, signal);
        return comfyJobResult({ comfyJobId: job.id, job, ...(acknowledgement ? { acknowledgement } : {}) });
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
          jsonRequest(comfyScope())
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
    'Prepare or inspect the legacy local MiniMax H3 installation. request preserves the generation spec and returns creationOperationId. The user accepts terms/hardware in the existing installer UI; never accept on their behalf. start requires that saved UI confirmation and the same operationId. status reads that existing operation within this same request without starting work. Await user input only for the existing consent card; otherwise remain engaged, inspect the same operation with bounded spaced status checks, diagnose terminal failures and continue permitted repair. Once submitted, retain jobId and monitor that same job with openh3_h3_job_status waitMs=30000 until terminal output, inspect it and finish remaining authorized work. Application continuation is a fallback for interruption, not completed delivery.',
    {
      action: z.enum(['request', 'start', 'status']),
      spec: h3GenerationSpecSchema.optional(),
      operationId: z.string().uuid().optional(),
    },
    async ({ action, spec, operationId }) => {
      try {
        if (action === 'status') {
          if (!operationId) throw new Error('CREATION_OPERATION_REQUIRED');
          const requestId = creationRequestId();
          const operation = (await call(
            `/api/creation/operations/${encodeURIComponent(operationId)}?${new URLSearchParams({ requestId })}`
          )) as CreationOperation;
          if (operation.requestId !== requestId) throw new Error('CREATION_REQUEST_MISMATCH');
          return legacyInstallationResult(operation);
        }
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
        )) as CreationOperation;
        return legacyInstallationResult(operation);
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
    'Generate a short video with the local MiniMax H3 runtime. Leave mode as auto: no references routes to text-to-video; one image routes to first-frame video; two images route to first-and-last-frame video; three or more images, or any video/audio reference, routes to multimodal Ref2VA. The tool queues a job and returns its id; retain that real job ID. Keep working, even for a single output: monitor the same job with openh3_h3_job_status waitMs=30000 until a terminal result, inspect outputs, and continue authorized work before the final answer. If the bounded wait returns queued/running, call status again with the same ID. stopPolling and nextAction distinguish ongoing work from terminal or remoteUncertain jobs: diagnose a failure and continue permitted repair, or recover an uncertain existing prompt before further generation. Never resubmit to monitor progress or automatically retry unchanged failures.',
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
    'Read-only inspection of the H3 acceleration backend and runtime readiness, error and installation paths. A reported dense backend does not prove the selected workflow can execute without acceleration; inspect its actual node/kernel requirements and failure logs. Diagnose missing dependencies or ACCELERATION_INSTALL_FAILED, continue permitted repair under current authorization and validate the same selected workflow before another submission. This tool does not install, start, cancel or generate anything.',
    {},
    async () => {
      try {
        const status = (await call('/api/h3/status')) as {
          acceleration?: Record<string, unknown>;
          ready?: boolean;
          error?: string;
          readiness?: unknown;
          install?: unknown;
        };
        return toolResult({
          ...(status.acceleration ?? { backend: 'unknown' }),
          ...(typeof status.ready === 'boolean' ? { runtimeReady: status.ready } : {}),
          ...(status.error ? { runtimeError: status.error } : {}),
          ...(status.readiness !== undefined ? { readiness: status.readiness } : {}),
          ...(status.install !== undefined ? { install: status.install } : {}),
        });
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
    'Query one snapshot of a local MiniMax H3 generation job and its output resources. activity describes backend node execution, not overall completion. progress is not an overall percentage for running jobs. Report activity.value/max only as current-node progress; without activity say overall progress is unknown. An unchanged timestamp cannot prove the task is advancing or stuck. Cancel ends generation, not resumable pause. Set waitMs=30000 to wait up to 30 seconds with spaced read-only checks, returning early for a terminal result or uncertain submission; waitMs=0 returns one snapshot. Keep monitoring the same job while queued/running, even for a single output. A wait timeout is not completion: call status again, inspect outputs at the terminal result, and continue authorized work before the final answer. Cancelling this status wait stops observation only. Respect stopPolling and nextAction: stop repeated status checks on terminal or remoteUncertain jobs, diagnose failures and continue permitted repair, and recover uncertain existing prompts before further generation. Never resubmit to monitor progress or automatically retry unchanged failures.',
    { jobId: z.string().min(1), waitMs: statusWaitSchema },
    async ({ jobId, waitMs }, { signal }) => {
      try {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(await waitForJob(`/api/h3/jobs/${encodeURIComponent(jobId)}`, waitMs, signal)),
            },
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
