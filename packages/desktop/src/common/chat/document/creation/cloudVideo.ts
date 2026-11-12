import { z } from 'zod';

export const H3_CLOUD_BASE_URL = 'http://10.1.1.32:8091/v1';
export const H3_CLOUD_LORA_PATH =
  '/home/huhq/h3/models/lightx2v/minimax_h3_fl2v_turbo_8step_v1.0_768p_bf16.safetensors';
export const cloudVideoConnectionSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  protocol: z.enum(['vllm-h3', 'openai-video']),
  baseUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }),
  model: z.string().trim().max(500).default(''),
  apiKey: z.string().max(8000).optional(),
  loraPath: z.string().min(1).max(2000).optional(),
});
export type CloudVideoConnectionInput = z.input<typeof cloudVideoConnectionSchema>;
export type CloudVideoConnection = Omit<z.output<typeof cloudVideoConnectionSchema>, 'id' | 'apiKey'> & {
  id: string;
  apiKey: string;
};
export type PublicVideoConnection = Omit<CloudVideoConnection, 'apiKey'> & { hasApiKey: boolean };

export const cloudVideoInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(32000),
    duration: z.number().finite().positive().max(120).optional(),
    width: z.number().int().min(32).max(8192).optional(),
    height: z.number().int().min(32).max(8192).optional(),
    aspectRatio: z.enum(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']).optional(),
    seed: z.number().int().nonnegative().max(2147483647).optional(),
    imagePaths: z.array(z.string().min(1)).max(2).default([]),
  })
  .strict();
export type CloudVideoInput = z.input<typeof cloudVideoInputSchema>;
export type CloudVideoJob = {
  id: string;
  requestId: string;
  submissionId?: string;
  conversationId: string;
  connectionId: string;
  model: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  /** False when the provider does not expose a real percentage. Legacy jobs may omit it. */
  progressKnown?: boolean;
  stage?: 'submitting' | 'queued' | 'generating' | 'downloading' | 'completed' | 'failed';
  updatedAt?: string;
  lastCheckedAt?: string;
  downloadBytes?: number;
  downloadTotalBytes?: number;
  aspectRatio?: string;
  width?: number;
  height?: number;
  remoteId?: string;
  submissionUncertain?: boolean;
  error?: string;
  createdAt: string;
};
export type RemoteVideoJob = {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  progress?: number;
  error?: { message?: string } | null;
};
export type VideoAdapter = {
  submit: (input: CloudVideoInput) => Promise<RemoteVideoJob>;
  retrieve: (id: string) => Promise<RemoteVideoJob>;
  download: (id: string) => Promise<Response>;
};

/** Explicit capabilities for protocols whose video endpoints have been implemented. */
export const VIDEO_PROTOCOL_CAPABILITIES = {
  'vllm-h3': { maxImages: 2, audioOutput: true, cancel: false },
  'openai-video': { maxImages: 1, audioOutput: true, cancel: false },
} as const;
