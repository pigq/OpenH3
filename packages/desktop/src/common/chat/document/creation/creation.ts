import {
  BUILTIN_IMAGE_GEN_NAME,
  BUILTIN_VIDEO_MEDIA_NAME,
  isBuiltinImageGenerationName,
  isBuiltinVideoMediaName,
  type ISessionMcpServer,
  type TProviderWithModel,
} from '@/common/config/storage';
import type { ComfyFamily, ComfyIntent, ComfyProfile } from './comfy';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';

export type CreationKind = 'image' | 'video';
export type CreationSource = 'local' | 'cloud';
export type CreationModelState =
  | 'downloaded'
  | 'loadable'
  | 'verified'
  | 'invalid'
  | 'installed'
  | 'not-installed'
  | 'no-workflow'
  | 'configured'
  | 'not-configured'
  | 'unavailable'
  | 'checking'
  | 'unsupported';
export type CreationSelection = {
  kind: CreationKind;
  source: CreationSource;
  modelIds: Partial<Record<`${CreationSource}-${CreationKind}`, string>>;
};
export type CreationModel = {
  id: string;
  name: string;
  kind: CreationKind;
  source: CreationSource;
  state: CreationModelState;
  available: boolean;
  provider?: TProviderWithModel;
  presetId?: string;
  profileId?: string;
  family?: ComfyFamily;
  intent?: ComfyIntent;
};
export type LocalCreationInventory = {
  h3: { installed: boolean; runtimeRunning: boolean; missingWorkflows: string[] };
  models: Array<{ id: string; name: string }>;
  profiles?: ComfyProfile[];
};
export type CreationRequest = Pick<
  CreationModel,
  'id' | 'name' | 'kind' | 'source' | 'state' | 'profileId' | 'family' | 'intent'
> & { templateSnapshot?: TemplateSnapshot };

/** Attach explicit user choices to the first turn without exposing credentials. */
export function creationMessage(input: string, summary: string): string {
  return `${input}\n\n${summary}`;
}

/** Copy only session transports; never update global model or MCP settings. */
export function creationSessionServers(
  servers: ISessionMcpServer[],
  request: CreationRequest,
  provider?: TProviderWithModel,
  requestId?: string
): ISessionMcpServer[] {
  return servers.map((server) => {
    if (
      (!isBuiltinVideoMediaName(server.name) && !isBuiltinImageGenerationName(server.name)) ||
      server.transport.type !== 'stdio'
    )
      return server;
    const env = {
      ...server.transport.env,
      OPENH3_CREATION_KIND: request.kind,
      OPENH3_CREATION_SOURCE: request.source,
      OPENH3_CREATION_MODEL: request.id,
      OPENH3_CREATION_INTENT: request.intent ?? 'generate',
      ...(request.family ? { OPENH3_CREATION_FAMILY: request.family } : {}),
      ...(request.profileId ? { OPENH3_CREATION_PROFILE: request.profileId } : {}),
      ...(requestId ? { OPENH3_CREATION_REQUEST_ID: requestId } : {}),
      // Older bundled MCP processes only understand these names.
      AIONUI_CREATION_KIND: request.kind,
      AIONUI_CREATION_SOURCE: request.source,
      AIONUI_CREATION_MODEL: request.id,
      AIONUI_CREATION_INTENT: request.intent ?? 'generate',
      ...(request.family ? { AIONUI_CREATION_FAMILY: request.family } : {}),
      ...(request.profileId ? { AIONUI_CREATION_PROFILE: request.profileId } : {}),
      ...(requestId ? { AIONUI_CREATION_REQUEST_ID: requestId } : {}),
    };
    return {
      ...server,
      name: isBuiltinImageGenerationName(server.name) ? BUILTIN_IMAGE_GEN_NAME : BUILTIN_VIDEO_MEDIA_NAME,
      transport: {
        ...server.transport,
        env:
          isBuiltinImageGenerationName(server.name) && provider
            ? {
                ...env,
                OPENH3_IMG_PROVIDER_ID: provider.id,
                OPENH3_IMG_PLATFORM: provider.platform,
                OPENH3_IMG_BASE_URL: provider.base_url,
                OPENH3_IMG_API_KEY: provider.api_key,
                OPENH3_IMG_MODEL: provider.use_model ?? '',
                AIONUI_IMG_PROVIDER_ID: provider.id,
                AIONUI_IMG_PLATFORM: provider.platform,
                AIONUI_IMG_BASE_URL: provider.base_url,
                AIONUI_IMG_API_KEY: provider.api_key,
                AIONUI_IMG_MODEL: provider.use_model ?? '',
              }
            : env,
      },
    };
  });
}
