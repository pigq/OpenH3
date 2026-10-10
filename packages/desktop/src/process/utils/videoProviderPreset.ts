import type { CreateProviderRequest } from '@/common/types/provider/providerApi';

export const VIDEO_PROVIDER_ID = 'realseek-video-default';
export const DEFAULT_VIDEO_GATEWAY_URL = process.env.OPENH3_GATEWAY_URL?.trim().replace(/\/+$/, '') || '';

/** Public gateway defaults contain no shared credential. */
export function videoProviderPreset(gatewayUrl = DEFAULT_VIDEO_GATEWAY_URL): CreateProviderRequest {
  return {
    id: VIDEO_PROVIDER_ID,
    platform: 'openai',
    name: 'OpenH3 GPT-6 Astra',
    base_url: `${gatewayUrl.replace(/\/+$/, '')}/v1`,
    api_key: '',
    models: ['gpt-6-astra'],
    model_settings: { 'gpt-6-astra': { openai_api_mode: 'responses' } },
    enabled: true,
  };
}

export async function provisionVideoProvider(
  request: <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<T>,
  gatewayUrl = DEFAULT_VIDEO_GATEWAY_URL
): Promise<void> {
  if (!gatewayUrl.trim()) return;
  const providers = await request<Array<{ id: string }>>('GET', '/api/providers');
  // Never replace an existing user's provider or model selection.
  if (providers.length) return;
  await request('POST', '/api/providers', videoProviderPreset(gatewayUrl));
  await request('PUT', '/api/assistants/bare:632f31d2', {
    defaults: {
      model: { mode: 'fixed', value: `${VIDEO_PROVIDER_ID}:gpt-6-astra` },
      thought_level: { mode: 'fixed', value: 'low' },
    },
  });
}
