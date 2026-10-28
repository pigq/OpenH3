import type { CreateProviderRequest } from '@/common/types/provider/providerApi';

export const VIDEO_PROVIDER_ID = 'realseek-video-default';
export const DEFAULT_VIDEO_GATEWAY_URL = process.env.OPENH3_GATEWAY_URL?.trim().replace(/\/+$/, '') || '';

type VideoProviderDefaults = { model: string; apiKey: string; thoughtLevel: string };

// Credentials are injected only into explicitly opted-in distribution builds.
const DISTRIBUTION_DEFAULTS: VideoProviderDefaults = {
  model: process.env.OPENH3_DEFAULT_MODEL?.trim() || 'gpt-6-astra',
  apiKey: process.env.OPENH3_DEFAULT_API_KEY?.trim() || '',
  thoughtLevel: process.env.OPENH3_DEFAULT_THOUGHT_LEVEL?.trim() || 'low',
};

/** Build the initial provider without duplicating a caller-supplied /v1 suffix. */
export function videoProviderPreset(
  gatewayUrl = DEFAULT_VIDEO_GATEWAY_URL,
  defaults = DISTRIBUTION_DEFAULTS
): CreateProviderRequest {
  const baseUrl = gatewayUrl.trim().replace(/\/+$/, '');
  return {
    id: VIDEO_PROVIDER_ID,
    platform: 'openai',
    name: `OpenH3 ${defaults.model}`,
    base_url: baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`,
    api_key: defaults.apiKey,
    models: [defaults.model],
    model_settings: { [defaults.model]: { openai_api_mode: 'responses' } },
    enabled: true,
  };
}

export async function provisionVideoProvider(
  request: <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<T>,
  gatewayUrl = DEFAULT_VIDEO_GATEWAY_URL,
  defaults = DISTRIBUTION_DEFAULTS
): Promise<void> {
  if (!gatewayUrl.trim()) return;
  const providers = await request<Array<{ id: string }>>('GET', '/api/providers');
  // Never replace an existing user's provider or model selection.
  if (providers.length) return;
  await request('POST', '/api/providers', videoProviderPreset(gatewayUrl, defaults));
  await request('PUT', '/api/assistants/bare:632f31d2', {
    defaults: {
      model: { mode: 'fixed', value: `${VIDEO_PROVIDER_ID}:${defaults.model}` },
      thought_level: { mode: 'fixed', value: defaults.thoughtLevel },
    },
  });
}
