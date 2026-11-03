import { describe, expect, it, vi } from 'vitest';
import { buildVideoForm, createVideoAdapter } from '@/process/services/media/cloud/videoAdapters';
import type { CloudVideoConnection } from '@/common/chat/document/creation/cloudVideo';

const h3: CloudVideoConnection = {
  id: 'h3',
  name: 'H3',
  protocol: 'vllm-h3',
  baseUrl: 'http://server:8091/v1',
  model: '',
  apiKey: '',
  loraPath: '/models/minimax_h3_fl2v_turbo_8step_v1.0_768p_bf16.safetensors',
};
const load = async () => new Blob(['image'], { type: 'image/png' });
describe('cloud video protocol adapters', () => {
  it('derives portrait dimensions from the requested H3 aspect ratio', async () => {
    const form = await buildVideoForm(h3, { prompt: 'portrait', aspectRatio: '9:16' }, load);
    expect(form.get('width')).toBe('768');
    expect(form.get('height')).toBe('1344');
  });
  it('maps H3 text generation to the pinned deployment recipe', async () => {
    const form = await buildVideoForm(h3, { prompt: '<scene> fox', duration: 4.4 }, load);
    expect(form.get('prompt')).toBe('<scene> fox');
    expect(form.get('num_inference_steps')).toBe('9');
    expect(form.get('flow_shift')).toBe('6');
    expect(form.get('fps')).toBe('24');
    expect(form.get('aspect_ratio')).toBe('16:9');
    expect(JSON.parse(String(form.get('extra_params')))).toEqual({ task: 't2va', duration: 4.4, audio_flow_shift: 3 });
    expect(JSON.parse(String(form.get('lora')))).toMatchObject({ path: h3.loraPath, scale: 1 });
    expect(form.has('model')).toBe(false);
  });
  it('preserves first/last frame order and allows server-derived image dimensions', async () => {
    const loader = vi.fn(load);
    const form = await buildVideoForm(h3, { prompt: 'move', imagePaths: ['/first.png', '/last.png'] }, loader);
    expect(loader.mock.calls.map((call) => call[0])).toEqual(['/first.png', '/last.png']);
    expect(form.getAll('input_references')).toHaveLength(2);
    expect(form.has('input_reference')).toBe(false);
    expect(form.has('width')).toBe(false);
    expect(JSON.parse(String(form.get('extra_params')))).toMatchObject({ task: 'fl2va', frame_indices: [0, -1] });
  });
  it('sends only OpenAI video fields for a compatible third party', async () => {
    const form = await buildVideoForm(
      { ...h3, protocol: 'openai-video', model: 'vendor-video' },
      {
        prompt: 'ocean',
        duration: 8,
        width: 1280,
        height: 720,
        imagePaths: ['/first.png'],
      },
      load
    );
    expect([...form.keys()].toSorted()).toEqual(['input_reference', 'model', 'prompt', 'seconds', 'size']);
    expect(form.get('seconds')).toBe('8');
    expect(form.get('size')).toBe('1280x720');
  });
  it.each([{ imagePaths: ['/a', '/b', '/c'] }, { width: 1280, height: 720 }, { duration: 16 }, { width: 1344 }])(
    'rejects unsupported H3 input before network calls: %j',
    async (input) => {
      await expect(buildVideoForm(h3, { prompt: 'test', ...input }, load)).rejects.toThrow();
    }
  );
  it('does not retry submissions or follow authenticated redirects', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const adapter = createVideoAdapter({ ...h3, apiKey: 'private-key' }, fetcher);
    await expect(adapter.submit({ prompt: 'test' })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('http://server:8091/v1/videos');
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer private-key' },
    });
  });
});
