import { registerProductTool } from './toolAliases';
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for image generation.
 * Runs as a standalone stdio process spawned by the MCP client.
 * Reads provider config from environment variables.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME } from './constants';
import { executeImageGeneration } from '@/common/chat/imageGenCore';
import type { TProviderWithModel } from '@/common/config/storage';
import {
  comfyGenerationInputSchema,
  type ComfyGenerationJob,
  type ComfyProfile,
} from '@/common/chat/document/creation/comfy';
import path from 'node:path';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';

type CreationSelection = {
  profileId?: string;
  family?: string;
  intent: string;
  source?: 'local' | 'cloud';
  kind?: 'image' | 'video';
  templateSnapshot?: TemplateSnapshot;
};

async function comfyRequest(endpoint: string, body?: unknown): Promise<unknown> {
  const response = await fetch(
    `http://127.0.0.1:${Number(process.env.OPENH3_MEDIA_PORT ?? process.env.AIONUI_MEDIA_PORT ?? 33002)}${endpoint}`,
    {
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(45_000),
    }
  );
  const data = await response.json();
  if (!response.ok) throw new Error((data as { error?: string }).error ?? `MEDIA_SERVICE_HTTP_${response.status}`);
  return data;
}

function envValue(canonical: string, legacy: string): string | undefined {
  return process.env[canonical] ?? process.env[legacy];
}

async function localImageGeneration(
  prompt: string,
  imageUris: string[] | undefined,
  requestId: string,
  profiles: ComfyProfile[],
  selection: CreationSelection
) {
  if (!selection.profileId) throw new Error('COMFY_SELECTED_PROFILE_REQUIRED');
  const profile = profiles.find((candidate) => candidate.id === selection.profileId);
  if (!profile || profile.kind !== 'image') throw new Error('CREATION_IMAGE_NOT_SELECTED');
  if (imageUris?.some((uri) => /^https?:\/\//i.test(uri))) throw new Error('COMFY_LOCAL_IMAGE_PATH_REQUIRED');
  const input = comfyGenerationInputSchema.parse({
    prompt,
    ...(imageUris?.length ? { imagePaths: imageUris.map((uri) => path.resolve(uri)) } : {}),
  });
  const job = (await comfyRequest('/api/comfy/jobs', {
    profileId: profile.id,
    input,
    requestId,
  })) as ComfyGenerationJob;
  return { content: [{ type: 'text' as const, text: JSON.stringify({ comfyJobId: job.id, job }) }] };
}

// Read provider config from environment variables
function getProviderFromEnv(): TProviderWithModel | null {
  const platform = envValue('OPENH3_IMG_PLATFORM', 'AIONUI_IMG_PLATFORM');
  const base_url = envValue('OPENH3_IMG_BASE_URL', 'AIONUI_IMG_BASE_URL');
  const api_key = envValue('OPENH3_IMG_API_KEY', 'AIONUI_IMG_API_KEY');
  const model = envValue('OPENH3_IMG_MODEL', 'AIONUI_IMG_MODEL');

  if (!platform || !model) {
    return null;
  }

  return {
    id: BUILTIN_IMAGE_GEN_ID,
    name: BUILTIN_IMAGE_GEN_NAME,
    platform,
    base_url: base_url || '',
    api_key: api_key || '',
    use_model: model,
  };
}

async function main() {
  const server = new McpServer({
    name: BUILTIN_IMAGE_GEN_NAME,
    version: '1.0.0',
  });

  const registerImageGenerationTool = (name: string) =>
    registerProductTool(
      server,
      name,
      'Generate or edit images using the user-selected source and model. For a local creation session, use its currently selected registered ComfyUI image profile and the comfyui-local skill; the backend validates that profile before queueing a generic ComfyUI job and returning comfyJobId. Local inputs must be local image paths. For cloud sessions, use the configured provider. Pass all user-provided image inputs. Never silently switch source/model or install a missing local profile; prepare installation separately through openh3_comfy_install and UI consent. The client monitors queued local jobs; end your turn after submission.',
      {
        prompt: z
          .string()
          .describe(
            'The generation description or image-edit instruction. Preserve the requested local model and source image roles.'
          ),
        image_uris: z
          .array(z.string())
          .optional()
          .describe(
            'Optional: Array of paths to existing local image files or HTTP/HTTPS URLs to edit/modify. Examples: ["test.jpg", "https://example.com/img.png"]. For single image, use array format: ["test.jpg"]. Relative paths are resolved against the current working directory.'
          ),
      },
      async ({ prompt, image_uris }) => {
        const requestId = envValue('OPENH3_CREATION_REQUEST_ID', 'AIONUI_CREATION_REQUEST_ID');
        let resolvedCloudSelection = false;
        let templateSnapshot: TemplateSnapshot | undefined;
        if (requestId?.trim()) {
          try {
            const result = (await comfyRequest(`/api/comfy/profiles?${new URLSearchParams({ requestId })}`)) as {
              profiles: ComfyProfile[];
              selection?: CreationSelection;
            };
            const selection = result.selection;
            if (!selection) throw new Error('COMFY_SELECTION_CONTEXT_MISSING');
            if (selection.kind === 'video' || selection.family === 'h3') throw new Error('CREATION_IMAGE_NOT_SELECTED');
            if (selection.intent !== 'generate') throw new Error('CREATION_GENERATION_NOT_SELECTED');
            if (selection.source === 'local' || selection.family || selection.profileId) {
              return await localImageGeneration(prompt, image_uris, requestId, result.profiles, selection);
            }
            if (selection.source !== 'cloud') throw new Error('COMFY_SELECTION_CONTEXT_MISSING');
            templateSnapshot = selection.templateSnapshot;
            resolvedCloudSelection = true;
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Local image generation failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        }
        if (!resolvedCloudSelection && envValue('OPENH3_CREATION_KIND', 'AIONUI_CREATION_KIND') === 'video')
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: 'The user selected video generation. Ask before switching to an image.' },
            ],
          };
        if (!resolvedCloudSelection && envValue('OPENH3_CREATION_SOURCE', 'AIONUI_CREATION_SOURCE') === 'local') {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'CREATION_REQUEST_CONTEXT_MISSING: local generation requires a bound creation session and selected registered ComfyUI profile. Use the comfyui-local skill to prepare or select that profile.',
              },
            ],
          };
        }
        const provider = getProviderFromEnv();
        if (!provider) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: Image generation model not configured. Please select an image generation model in Settings > Tools.',
              },
            ],
            isError: true,
          };
        }

        const proxy = envValue('OPENH3_IMG_PROXY', 'AIONUI_IMG_PROXY') || undefined;
        // Trusted workspace root: the MCP server inherits the agent process cwd,
        // which the backend sets to the conversation workspace. Never accept a
        // workspace path from the model (path traversal boundary).
        const workspaceDir = process.cwd();

        const result = await executeImageGeneration(
          { prompt, image_uris, ...(templateSnapshot ? { templateSnapshot } : {}) },
          provider,
          workspaceDir,
          proxy
        );

        if (!result.success) {
          return {
            content: [{ type: 'text' as const, text: result.text }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: result.text }],
        };
      }
    );

  registerImageGenerationTool('openh3_image_generation');

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[ImageGenMCP] Fatal error:', error);
  process.exit(1);
});
