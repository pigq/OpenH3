/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared image generation logic used by both:
 * - The built-in MCP server (imageGenServer.ts)
 * - The legacy Gemini-specific tool (img-gen.ts)
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'node:crypto';
import { templateSnapshotSchema, type TemplateSnapshot } from '@/common/contentCatalog/snapshot';
import { jsonrepair } from 'jsonrepair';
import type OpenAI from 'openai';
import { ClientFactory, type RotatingClient } from '@/common/api/ClientFactory';
import { OpenAIRotatingClient } from '@/common/api/OpenAIRotatingClient';
import {
  decodeImageDataUrl,
  imageBytesToDataUrl,
  imageUrlToDataUrl,
  imagesApiDataUrl,
} from './document/creation/imagesApi';
import { isImagesApiProvider } from '@/common/utils/imageModelAllowlist';
import type { TProviderWithModel } from '@/common/config/storage';
import type { UnifiedChatCompletionResponse } from '@/common/api/RotatingApiClient';
import { IMAGE_EXTENSIONS, MIME_TYPE_MAP, MIME_TO_EXT_MAP, DEFAULT_IMAGE_EXTENSION } from '@/common/config/constants';

const API_TIMEOUT_MS = 120000; // 2 minutes for image generation API calls

type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

// ===== Path Boundary Helpers =====

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/**
 * Resolve `candidate` against `workspaceDir` and verify the result stays inside
 * the workspace. A lexical containment check always applies; when the target
 * exists, it is additionally canonicalized with `realpath` so symlinks inside
 * the workspace cannot escape to arbitrary files outside it. Missing targets
 * resolve lexically — the caller's existence check reports "not found".
 */
const resolveSafePath = async (workspaceDir: string, candidate: string): Promise<string> => {
  const resolved = path.resolve(workspaceDir, candidate);
  if (!isWithin(workspaceDir, resolved)) {
    throw new Error(`Path traversal blocked: "${candidate}" resolves outside workspace`);
  }

  const realWorkspaceDir = await fs.promises.realpath(workspaceDir);
  let realTarget: string;
  try {
    realTarget = await fs.promises.realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolved;
    }
    throw error;
  }
  if (!isWithin(realWorkspaceDir, realTarget)) {
    throw new Error(`Path traversal blocked: "${candidate}" resolves outside workspace`);
  }
  return realTarget;
};

// ===== Utility Functions =====

export function safeJsonParse<T = unknown>(jsonString: string, fallbackValue: T): T {
  if (!jsonString || typeof jsonString !== 'string') {
    return fallbackValue;
  }

  try {
    return JSON.parse(jsonString) as T;
  } catch (_error) {
    try {
      const repairedJson = jsonrepair(jsonString);
      return JSON.parse(repairedJson) as T;
    } catch (_repairError) {
      console.warn('[ImageGen] JSON parse failed:', jsonString.substring(0, 50));
      return fallbackValue;
    }
  }
}

export function isImageFile(file_path: string): boolean {
  const ext = path.extname(file_path).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext as ImageExtension);
}

export function isHttpUrl(str: string): boolean {
  return str.startsWith('http://') || str.startsWith('https://');
}

export async function fileToBase64(file_path: string): Promise<string> {
  try {
    const fileBuffer = await fs.promises.readFile(file_path);
    return fileBuffer.toString('base64');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('ENOENT') || errorMessage.includes('no such file')) {
      throw new Error(`Image file not found: ${file_path}`, { cause: error });
    }
    throw new Error(`Failed to read image file: ${errorMessage}`, { cause: error });
  }
}

export function getImageMimeType(file_path: string): string {
  const ext = path.extname(file_path).toLowerCase();
  return MIME_TYPE_MAP[ext] || MIME_TYPE_MAP[DEFAULT_IMAGE_EXTENSION];
}

export function getFileExtensionFromDataUrl(dataUrl: string): string {
  const mimeTypeMatch = dataUrl.match(/^data:image\/([^;]+);base64,/);
  if (mimeTypeMatch && mimeTypeMatch[1]) {
    const mimeType = mimeTypeMatch[1].toLowerCase();
    return MIME_TO_EXT_MAP[mimeType] || DEFAULT_IMAGE_EXTENSION;
  }
  return DEFAULT_IMAGE_EXTENSION;
}

type ImageGenerationProvenance = {
  prompt: string;
  providerId: string;
  model: string;
  templateSnapshot: TemplateSnapshot;
};
export async function saveGeneratedImage(
  base64Data: string,
  workspaceDir: string,
  provenance?: ImageGenerationProvenance
): Promise<string> {
  const timestamp = Date.now();
  const decoded = decodeImageDataUrl(base64Data);
  const canonicalDataUrl = imageBytesToDataUrl(decoded.bytes, decoded.mime);
  const fileExtension = getFileExtensionFromDataUrl(canonicalDataUrl);
  const file_name = `img-${timestamp}${provenance ? `-${randomUUID()}` : ''}${fileExtension}`;
  const resolvedDir = path.resolve(workspaceDir);
  const file_path = path.join(resolvedDir, file_name);

  const imageBuffer = Buffer.from(decoded.bytes);

  try {
    await fs.promises.writeFile(file_path, imageBuffer);
    if (provenance) {
      const record = {
        schemaVersion: 1,
        status: 'succeeded',
        createdAt: new Date().toISOString(),
        prompt: provenance.prompt,
        providerId: provenance.providerId,
        model: provenance.model,
        templateSnapshot: templateSnapshotSchema.parse(provenance.templateSnapshot),
        artifact: { filename: file_name, sha256: createHash('sha256').update(imageBuffer).digest('hex') },
      };
      const temporary = `${file_path}.generation.json.tmp`;
      const handle = await fs.promises.open(temporary, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(JSON.stringify(record, null, 2));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.rename(temporary, `${file_path}.generation.json`);
      } finally {
        await fs.promises.unlink(temporary).catch(() => {});
      }
    }
    return file_path;
  } catch (error) {
    console.error('[ImageGen] Failed to save image file:', error);
    throw new Error(`Failed to save image: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

// ===== Image Content Processing =====

interface ImageContent {
  type: 'image_url';
  image_url: {
    url: string;
    detail: 'auto' | 'low' | 'high';
  };
}

export async function processImageUri(imageUri: string, workspaceDir: string): Promise<ImageContent | null> {
  if (isHttpUrl(imageUri)) {
    return {
      type: 'image_url',
      image_url: { url: imageUri, detail: 'auto' },
    };
  }

  let processedUri = imageUri;
  if (imageUri.startsWith('@')) {
    processedUri = imageUri.substring(1);
  }

  const fullPath = await resolveSafePath(workspaceDir, processedUri);

  try {
    await fs.promises.access(fullPath, fs.constants.F_OK);

    if (!isImageFile(fullPath)) {
      throw new Error(`File is not a supported image type: ${fullPath}`);
    }

    const base64Data = await fileToBase64(fullPath);
    const mimeType = getImageMimeType(fullPath);
    return {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64Data}`, detail: 'auto' },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (
      errorMessage.includes('Path traversal blocked') ||
      errorMessage.includes('Image file not found') ||
      errorMessage.includes('not a supported image type')
    ) {
      throw error;
    }

    const possiblePaths = [imageUri, path.resolve(workspaceDir, imageUri)].filter((p, i, arr) => arr.indexOf(p) === i);
    throw new Error(
      `Image file not found. Searched paths:\n${possiblePaths.map((p) => `- ${p}`).join('\n')}\n\nPlease ensure the image file exists and has a valid image extension (.jpg, .png, .gif, .webp, etc.)`,
      { cause: error }
    );
  }
}

// ===== Core Execution =====

export interface ImageGenParams {
  prompt: string;
  image_uris?: string[] | string;
  templateSnapshot?: TemplateSnapshot;
}

export interface ImageGenResult {
  success: boolean;
  text: string;
  imagePath?: string;
  relativeImagePath?: string;
  error?: string;
}

/**
 * Core image generation function shared between MCP server and Gemini tool.
 */
export async function executeImageGeneration(
  params: ImageGenParams,
  provider: TProviderWithModel,
  workspaceDir: string,
  proxy?: string,
  signal?: AbortSignal
): Promise<ImageGenResult> {
  if (signal?.aborted) {
    return { success: false, text: 'Image generation was cancelled.', error: 'cancelled' };
  }

  // Resolve and validate workspaceDir once to prevent path traversal
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  // fs.realpath would reject if the directory does not exist, but we should
  // fail fast so the caller gets a clear error rather than a cascade.
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolvedWorkspaceDir);
  } catch {
    return {
      success: false,
      text: `Workspace directory not found: ${resolvedWorkspaceDir}`,
      error: `Workspace directory not found: ${resolvedWorkspaceDir}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      success: false,
      text: `Workspace path is not a directory: ${resolvedWorkspaceDir}`,
      error: `Workspace path is not a directory: ${resolvedWorkspaceDir}`,
    };
  }

  try {
    const provenance: ImageGenerationProvenance | undefined = params.templateSnapshot
      ? {
          prompt: params.prompt,
          providerId: provider.id,
          model: provider.use_model ?? '',
          templateSnapshot: templateSnapshotSchema.parse(params.templateSnapshot) as TemplateSnapshot,
        }
      : undefined;
    // Parse image URIs
    let imageUris: string[] = [];
    if (params.image_uris) {
      if (typeof params.image_uris === 'string') {
        const parsed = safeJsonParse<string[]>(params.image_uris, null);
        imageUris = Array.isArray(parsed) ? parsed : [params.image_uris];
      } else if (Array.isArray(params.image_uris)) {
        imageUris = params.image_uris;
      }
    }

    const hasImages = imageUris.length > 0;
    let enhancedPrompt: string;
    if (hasImages) {
      enhancedPrompt = `Analyze/Edit image: ${params.prompt}`;
    } else {
      enhancedPrompt = `Generate image: ${params.prompt}`;
    }

    const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: enhancedPrompt }];

    // Process image URIs
    if (hasImages) {
      const imageResults = await Promise.allSettled(imageUris.map((uri) => processImageUri(uri, resolvedWorkspaceDir)));

      const successful: ImageContent[] = [];
      const errors: string[] = [];

      imageResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          successful.push(result.value);
        } else {
          const error = result.status === 'rejected' ? result.reason : 'Unknown error';
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`Image ${index + 1} (${imageUris[index]}): ${errorMessage}`);
        }
      });

      successful.forEach((imageContent) => contentParts.push(imageContent));

      if (successful.length === 0 || (errors.length > 0 && isImagesApiProvider(provider, provider.use_model))) {
        return {
          success: false,
          text: `Error: Failed to process any images. Errors:\n${errors.join('\n')}`,
          error: errors.join('\n'),
        };
      }
    }

    // Create client and call API
    const rotatingClient: RotatingClient = await ClientFactory.createRotatingClient(provider, {
      proxy,
      rotatingOptions: { maxRetries: 3, retryDelay: 1000 },
    });

    if (isImagesApiProvider(provider, provider.use_model)) {
      if (!(rotatingClient instanceof OpenAIRotatingClient))
        throw new Error('Images API requires an OpenAI-compatible provider.');
      const references = contentParts
        .filter((part): part is ImageContent => part.type === 'image_url')
        .map((part, index) => ({ uri: imageUris[index], url: part.image_url.url }));
      const dataUrl = await imagesApiDataUrl(rotatingClient, params.prompt, provider.use_model, references, signal);
      const imagePath = await saveGeneratedImage(dataUrl, resolvedWorkspaceDir, provenance);
      return {
        success: true,
        text: `Generated image saved to: ${imagePath}`,
        imagePath,
        relativeImagePath: path.relative(resolvedWorkspaceDir, imagePath),
      };
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'user', content: contentParts }];

    const completion: UnifiedChatCompletionResponse = await rotatingClient.createChatCompletion(
      { model: provider.use_model, messages: messages as any },
      { signal, timeout: API_TIMEOUT_MS }
    );

    const choice = completion.choices[0];
    if (!choice) {
      return { success: false, text: 'No response from image generation API', error: 'No response' };
    }

    const responseText = choice.message.content || 'Image generated successfully.';
    let images = choice.message.images;

    // Extract images from markdown in content if not in images field
    if ((!images || images.length === 0) && responseText) {
      const dataUrlRegex = /!\[[^\]]*\]\((data:image\/[^;]+;base64,[^)]+)\)/g;
      const dataUrlMatches = [...responseText.matchAll(dataUrlRegex)];
      if (dataUrlMatches.length > 0) {
        images = dataUrlMatches.map((match) => ({
          type: 'image_url' as const,
          image_url: { url: match[1] },
        }));
      } else {
        const file_pathRegex = /!\[[^\]]*\]\(([^)]+\.(?:jpg|jpeg|png|gif|webp|bmp|tiff|svg))\)/gi;
        const file_pathMatches = [...responseText.matchAll(file_pathRegex)];
        if (file_pathMatches.length > 0) {
          const processedImages: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
          for (const match of file_pathMatches) {
            const file_path = match[1];
            try {
              const fullPath = await resolveSafePath(resolvedWorkspaceDir, file_path);
              await fs.promises.access(fullPath);
              const base64Data = await fileToBase64(fullPath);
              const mimeType = getImageMimeType(fullPath);
              processedImages.push({
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Data}` },
              });
            } catch (_fileError) {
              console.warn(`[ImageGen] Could not load image file: ${file_path}`);
            }
          }
          if (processedImages.length > 0) {
            images = processedImages;
          }
        }
      }
    }

    if (!images || images.length === 0) {
      const warningMessage = `Image generation did not produce any images.\n\nModel response: ${responseText}\n\nTip: Make sure your image generation model supports this type of request. Current model: ${provider.use_model}`;
      return { success: false, text: warningMessage, error: 'No image returned' };
    }

    const firstImage = images[0];
    if (firstImage.type === 'image_url' && firstImage.image_url?.url) {
      const dataUrl = await imageUrlToDataUrl(firstImage.image_url.url, signal);
      const imagePath = await saveGeneratedImage(dataUrl, resolvedWorkspaceDir, provenance);
      const relativeImagePath = path.relative(resolvedWorkspaceDir, imagePath);

      // Strip any inline base64 data URLs from the human-readable text before
      // returning. The image is already saved to disk and referenced by path,
      // so re-emitting hundreds of MB of base64 in the MCP tool response just
      // forces the parent process to ship that payload through framed TCP again
      // (which is where the 2026-04-14 commit-charge blow-up happened).
      const cleanText = responseText.replace(
        /!\[[^\]]*\]\(data:image\/[^;]+;base64,[^)]+\)/g,
        '[embedded image extracted]'
      );

      return {
        success: true,
        text: `${cleanText}\n\nGenerated image saved to: ${imagePath}`,
        imagePath,
        relativeImagePath,
      };
    }

    return { success: true, text: responseText };
  } catch (error) {
    if (signal?.aborted) {
      return { success: false, text: 'Image generation was cancelled.', error: 'cancelled' };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ImageGen] API call failed:`, error);
    return { success: false, text: `Error generating image: ${errorMessage}`, error: errorMessage };
  }
}
