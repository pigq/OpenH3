import { expect, it, vi } from 'vitest';
import { provisionVideoProvider, videoProviderPreset } from '@/process/utils/videoProviderPreset';

it('provisions the Responses gateway with no client-side credential for a new user', async () => {
  const request = vi.fn().mockResolvedValueOnce([]).mockResolvedValue({});
  await provisionVideoProvider(request, 'https://openh3.example.workers.dev');
  expect(request).toHaveBeenNthCalledWith(
    2,
    'POST',
    '/api/providers',
    expect.objectContaining({
      base_url: 'https://openh3.example.workers.dev/v1',
      api_key: '',
      models: ['gpt-6-astra'],
      model_settings: { 'gpt-6-astra': { openai_api_mode: 'responses' } },
    })
  );
  expect(request).toHaveBeenNthCalledWith(
    3,
    'PUT',
    '/api/assistants/bare:632f31d2',
    expect.objectContaining({
      defaults: expect.objectContaining({ thought_level: { mode: 'fixed', value: 'low' } }),
    })
  );
  expect(videoProviderPreset('https://openh3.example.workers.dev').api_key).toBe('');
});

it('does not overwrite a configured user', async () => {
  const request = vi.fn().mockResolvedValue([{ id: 'user-provider' }]);
  await provisionVideoProvider(request, 'https://openh3.example.workers.dev');
  expect(request).toHaveBeenCalledTimes(1);
});

it('does not create duplicates when provider discovery fails', async () => {
  const request = vi.fn().mockRejectedValue(new Error('offline'));
  await expect(provisionVideoProvider(request, 'https://openh3.example.workers.dev')).rejects.toThrow('offline');
  expect(request).toHaveBeenCalledTimes(1);
});

it('does not submit a provider until a gateway endpoint is configured', async () => {
  const request = vi.fn();
  await provisionVideoProvider(request);
  expect(request).not.toHaveBeenCalled();
});
