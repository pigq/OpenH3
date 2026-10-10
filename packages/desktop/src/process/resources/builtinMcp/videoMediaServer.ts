import { h3AgentSnapshot, type H3Job } from '@/common/chat/document/h3Job';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_VIDEO_MEDIA_NAME } from './constants';

const port = () => Number(process.env.AIONUI_MEDIA_PORT ?? 33002);
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
  const response = await fetch(`http://127.0.0.1:${port()}${path}`, { ...init, signal: AbortSignal.timeout(45_000) });
  const data = await response.json();
  if (!response.ok) {
    const payload = data as { error?: string; diagnosis?: unknown };
    throw new MediaServiceError(payload.error ?? `MEDIA_SERVICE_HTTP_${response.status}`, {
      diagnosis: payload.diagnosis,
    });
  }
  if (data && typeof data.id === 'string' && Array.isArray(data.artifacts) && data.spec)
    return h3AgentSnapshot(data as H3Job);
  return data;
}

async function main() {
  const server = new McpServer(
    { name: BUILTIN_VIDEO_MEDIA_NAME, version: '1.0.0' },
    {
      instructions:
        'The client automatically displays completed H3 videos as a playable result card at the end of your reply. Summarize the result in plain language; do not output HTML video tags or duplicate playback links.',
    }
  );
  const spec = {
    kind: z.enum(['probe', 'extract-frame', 'extract-audio', 'transcode']),
    sourcePath: z.string().min(1),
    outputPath: z.string().min(1).optional(),
    startSeconds: z.number().nonnegative().optional(),
    endSeconds: z.number().positive().optional(),
  };
  server.tool(
    'aionui_video_process',
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
  server.tool(
    'aionui_video_job_status',
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
  server.tool(
    'aionui_h3_generate_video',
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
  server.tool(
    'aionui_h3_runtime_status',
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
  server.tool(
    'aionui_h3_queue_status',
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
  server.tool(
    'aionui_h3_free_memory',
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
  server.tool(
    'aionui_h3_acceleration_status',
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
  server.tool(
    'aionui_h3_job_status',
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
  server.tool(
    'aionui_h3_cancel_job',
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
