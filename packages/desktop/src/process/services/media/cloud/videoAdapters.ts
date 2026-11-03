import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  cloudVideoInputSchema,
  H3_CLOUD_LORA_PATH,
  type CloudVideoConnection,
  type CloudVideoInput,
  type VideoAdapter,
  type RemoteVideoJob,
} from '@/common/chat/document/creation/cloudVideo';
import { decodeImageDataUrl, imageBytesToDataUrl } from '@/common/chat/document/creation/imagesApi';

const remoteSchema = z.object({
  id: z.string().min(1).max(500),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed']),
  progress: z.number().finite().min(0).max(100).optional(),
  error: z.object({ message: z.string().optional() }).nullable().optional(),
});
const H3_SIZES = {
  '21:9': [1792, 768],
  '16:9': [1344, 768],
  '4:3': [1024, 768],
  '1:1': [768, 768],
  '3:4': [768, 1024],
  '9:16': [768, 1344],
} as const;
type H3AspectRatio = keyof typeof H3_SIZES;
function closestAspectRatio(width: number, height: number): H3AspectRatio {
  const distance = (value: string): number => {
    const [w, h] = value.split(':').map(Number);
    return Math.abs(w / h - width / height);
  };
  return (Object.keys(H3_SIZES) as H3AspectRatio[]).reduce(
    (best, ratio) => (distance(ratio) < distance(best) ? ratio : best),
    '16:9'
  );
}

/** Validate model capabilities before uploading any reference or submitting work. */
export function validateVideoInput(connection: CloudVideoConnection, raw: CloudVideoInput) {
  const input = cloudVideoInputSchema.parse(raw);
  if ((input.width === undefined) !== (input.height === undefined)) throw new Error('CLOUD_VIDEO_SIZE_PAIR_REQUIRED');
  if (connection.protocol === 'vllm-h3') {
    const duration = input.duration ?? 4.4;
    if (duration < 4 || duration > 15) throw new Error('CLOUD_VIDEO_H3_DURATION_4_15');
    if (
      input.width &&
      input.height &&
      (input.width % 32 || input.height % 32 || Math.min(input.width, input.height) !== 768)
    )
      throw new Error('CLOUD_VIDEO_H3_SIZE_INVALID');
  } else {
    if (!connection.model) throw new Error('CLOUD_VIDEO_MODEL_REQUIRED');
    if (input.imagePaths.length > 1) throw new Error('CLOUD_VIDEO_SINGLE_REFERENCE_ONLY');
    if (input.seed !== undefined || input.aspectRatio !== undefined)
      throw new Error('CLOUD_VIDEO_PARAMETER_UNSUPPORTED');
  }
  return input;
}

async function loadImage(filename: string): Promise<Blob> {
  if (!path.isAbsolute(filename)) throw new Error('CLOUD_VIDEO_ABSOLUTE_REFERENCE_REQUIRED');
  if ((await fs.stat(filename)).size > 20 * 1024 * 1024) throw new Error('CLOUD_VIDEO_REFERENCE_TOO_LARGE');
  const image = decodeImageDataUrl(imageBytesToDataUrl(new Uint8Array(await fs.readFile(filename))));
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)) throw new Error('CLOUD_VIDEO_REFERENCE_FORMAT');
  return new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mime });
}

/** Translate the shared request into one platform's form fields. */
export async function buildVideoForm(
  connection: CloudVideoConnection,
  raw: CloudVideoInput,
  readImage = loadImage
): Promise<FormData> {
  const input = validateVideoInput(connection, raw);
  const form = new FormData();
  form.set('prompt', input.prompt);
  if (connection.model) form.set('model', connection.model);
  if (connection.protocol === 'vllm-h3') {
    const textOnly = input.imagePaths.length === 0;
    const aspectRatio =
      input.aspectRatio ?? (input.width && input.height ? closestAspectRatio(input.width, input.height) : '16:9');
    const [defaultWidth, defaultHeight] = H3_SIZES[aspectRatio];
    const width = input.width ?? (textOnly ? defaultWidth : undefined);
    const height = input.height ?? (textOnly ? defaultHeight : undefined);
    if (width && height) {
      form.set('width', String(width));
      form.set('height', String(height));
    }
    if (textOnly || input.aspectRatio || input.width) form.set('aspect_ratio', aspectRatio);
    form.set('fps', '24');
    form.set('num_inference_steps', '9');
    form.set('flow_shift', '6');
    if (input.seed !== undefined) form.set('seed', String(input.seed));
    form.set(
      'extra_params',
      JSON.stringify({
        task: textOnly ? 't2va' : 'fl2va',
        duration: input.duration ?? 4.4,
        audio_flow_shift: 3,
        ...(input.imagePaths.length === 2 ? { frame_indices: [0, -1] } : {}),
      })
    );
    form.set(
      'lora',
      JSON.stringify({ name: 'h3-turbo-8step', path: connection.loraPath ?? H3_CLOUD_LORA_PATH, scale: 1 })
    );
  } else {
    if (input.duration !== undefined) form.set('seconds', String(input.duration));
    if (input.width && input.height) form.set('size', `${input.width}x${input.height}`);
  }
  for (const filename of input.imagePaths) {
    const blob = await readImage(filename);
    form.append(input.imagePaths.length === 2 ? 'input_references' : 'input_reference', blob, path.basename(filename));
  }
  return form;
}

export class VideoHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 404 ? 'CLOUD_VIDEO_REMOTE_LOST' : `CLOUD_VIDEO_HTTP_${status}`);
  }
}

/** OpenAI-style job endpoints with isolated H3 extensions; no automatic POST retries. */
export function createVideoAdapter(connection: CloudVideoConnection, fetcher: typeof fetch = fetch): VideoAdapter {
  const base = connection.baseUrl.replace(/\/+$/, '');
  const request = async (suffix: string, body?: FormData): Promise<Response> => {
    const response = await fetcher(`${base}/videos${suffix}`, {
      method: body ? 'POST' : 'GET',
      ...(body ? { body } : {}),
      headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(suffix.endsWith('/content') ? 300_000 : 30_000),
    });
    if (!response.ok) throw new VideoHttpError(response.status);
    return response;
  };
  const parseRemote = (value: unknown): RemoteVideoJob => {
    const result = remoteSchema.parse(value);
    return { ...result, id: result.id!, status: result.status! };
  };
  return {
    submit: async (input) => parseRemote(await (await request('', await buildVideoForm(connection, input))).json()),
    retrieve: async (id) => parseRemote(await (await request(`/${encodeURIComponent(id)}`)).json()),
    download: (id) => request(`/${encodeURIComponent(id)}/content`),
  };
}
