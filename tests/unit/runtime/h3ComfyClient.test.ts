import { describe, expect, it, vi } from 'vitest';
import { buildH3Workflow, H3ComfyClient } from '@/process/services/runtime/H3ComfyClient';
import { createH3Job, inferH3Mode } from '@/common/chat/document/h3Job';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('H3 watchdog reconciliation', () => {
  it('ignores duplicate node events rather than manufacturing fresh activity', async () => {
    let reads = 0;
    const updates = vi.fn();
    const event = { type: 'progress', data: { prompt_id: 'p', node: '7', value: 1, max: 4 } };
    const queue = [event, event, event, { type: 'execution_success', data: { prompt_id: 'p' } }];
    const events = {
      connected: true,
      next: async () => queue.shift(),
    } as unknown as import('@/process/services/runtime/h3ComfyEvents').H3ComfyEvents;
    const client = new H3ComfyClient({
      fetchImpl: (async () =>
        Response.json(
          ++reads === 1
            ? {}
            : { p: { status: { completed: true }, outputs: { out: { videos: [{ filename: 'done.mp4' }] } } } }
        )) as typeof fetch,
    });
    await client.resume('p', new AbortController().signal, updates, events);
    expect(updates.mock.calls.filter(([, activity]) => activity?.phase === 'node-progress')).toHaveLength(1);
  });

  it('releases a terminated prompt even when its successful history has no usable output', async () => {
    const client = new H3ComfyClient({
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (url) =>
        Response.json(
          String(url).endsWith('/cancel')
            ? { cancelled: false }
            : String(url).endsWith('/queue')
              ? { queue_running: [], queue_pending: [] }
              : { p: { status: { completed: true }, outputs: {} } }
        )) as typeof fetch,
    });
    await expect(client.cancel('p')).resolves.toBeUndefined();
  });

  it('bounds history failures even when the queue endpoint stays healthy', async () => {
    const client = new H3ComfyClient({
      heartbeatIntervalMs: 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (url) =>
        String(url).endsWith('/queue')
          ? Response.json({ queue_running: [[0, 'p']], queue_pending: [] })
          : new Response('{}', { status: 503 })) as typeof fetch,
    });
    await expect(client.resume('p', new AbortController().signal)).rejects.toThrow('H3_COMFY_HISTORY_UNAVAILABLE');
  });
  it('does not unlock an ambiguous submission merely because the queue is empty', async () => {
    const client = new H3ComfyClient({
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (url) =>
        Response.json(
          String(url).endsWith('/cancel')
            ? { cancelled: false }
            : String(url).endsWith('/queue')
              ? { queue_running: [], queue_pending: [] }
              : {}
        )) as typeof fetch,
    });
    await expect(client.cancel('reserved', true)).rejects.toThrow('H3_SUBMISSION_STATE_UNKNOWN');
    await expect(client.confirmStopped('reserved', true)).rejects.toThrow('H3_SUBMISSION_STATE_UNKNOWN');
  });

  it('uses persisted execution time rather than restarting the deadline after recovery', async () => {
    const client = new H3ComfyClient({ maxWaitMs: 100, fetchImpl: (async () => Response.json({})) as typeof fetch });
    await expect(
      client.resume('p', new AbortController().signal, undefined, undefined, {
        startedAt: new Date(Date.now() - 1000).toISOString(),
      })
    ).rejects.toThrow('H3_COMFY_HISTORY_TIMEOUT');
  });

  it.each(['queued', 'running'])(
    'recovers a brief disconnection while the target is %s, without a second submission',
    async (state) => {
      let now = 1000,
        reads = 0,
        probes = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const updates = vi.fn();
      const fetchImpl = vi.fn(async (url) => {
        if (String(url).endsWith('/queue')) {
          if (++probes === 1) throw new Error('offline');
          return Response.json({
            queue_running: state === 'running' ? [[0, 'p']] : [],
            queue_pending: state === 'queued' ? [[0, 'p']] : [],
          });
        }
        return Response.json(
          ++reads < 4
            ? {}
            : { p: { status: { completed: true }, outputs: { out: { videos: [{ filename: 'done.mp4' }] } } } }
        );
      });
      const client = new H3ComfyClient({
        heartbeatIntervalMs: 0,
        maxWaitMs: 100,
        pollIntervalMs: 0,
        sleep: async () => {
          now += 10;
        },
        fetchImpl: fetchImpl as typeof fetch,
      });
      try {
        await client.resume('p', new AbortController().signal, updates);
        expect(updates.mock.calls.some(([, , m]) => m?.state === 'reconnecting')).toBe(true);
        expect(updates.mock.calls.some(([, , m]) => m?.state === 'connected' && m?.remoteState === state)).toBe(true);
        expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
      } finally {
        clock.mockRestore();
      }
    }
  );

  it('lets history settle after the target disappears from the queue', async () => {
    let reads = 0;
    const client = new H3ComfyClient({
      heartbeatIntervalMs: 0,
      missingGraceMs: 60_000,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (url) =>
        Response.json(
          String(url).endsWith('/queue')
            ? { queue_running: [], queue_pending: [] }
            : ++reads < 3
              ? {}
              : { p: { status: { completed: true }, outputs: { out: { videos: [{ filename: 'done.mp4' }] } } } }
        )) as typeof fetch,
    });
    await expect(client.resume('p', new AbortController().signal)).resolves.toHaveProperty('promptId', 'p');
  });
  it('does not confuse cancellation acknowledgement with remote termination', async () => {
    const client = new H3ComfyClient({
      cancelConfirmAttempts: 2,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (url) =>
        Response.json(
          String(url).endsWith('/cancel') ? { cancelled: true } : { queue_running: [[0, 'p']], queue_pending: [] }
        )) as typeof fetch,
    });
    await expect(client.cancel('p')).rejects.toThrow('H3_COMFY_CANCEL_UNCONFIRMED');
  });

  it('preserves a completed result when completion wins the cancellation race', async () => {
    const client = new H3ComfyClient({
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (url) =>
        Response.json(
          String(url).endsWith('/cancel')
            ? { cancelled: false }
            : String(url).endsWith('/queue')
              ? { queue_running: [], queue_pending: [] }
              : { p: { status: { completed: true }, outputs: { out: { videos: [{ filename: 'done.mp4' }] } } } }
        )) as typeof fetch,
    });
    await expect(client.cancel('p')).resolves.toMatchObject({ promptId: 'p', artifacts: [{ filename: 'done.mp4' }] });
  });

  it('allows silent running nodes past the idle threshold and keeps execution timestamps truthful', async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let reads = 0;
    const updates = vi.fn();
    const client = new H3ComfyClient({
      maxIdleMs: 5,
      maxWaitMs: 100,
      heartbeatIntervalMs: 0,
      pollIntervalMs: 0,
      sleep: async () => {
        now += 10;
      },
      fetchImpl: (async (url) =>
        Response.json(
          String(url).endsWith('/queue')
            ? { queue_running: [[0, 'p']], queue_pending: [] }
            : String(url).includes('/history/')
              ? ++reads >= 4
                ? { p: { status: { completed: true }, outputs: { out: { videos: [{ filename: 'done.mp4' }] } } } }
                : {}
              : {}
        )) as typeof fetch,
    });
    try {
      await expect(
        client.resume('p', new AbortController().signal, updates, undefined, {
          activity: { phase: 'waiting', updatedAt: new Date(1000).toISOString() },
        })
      ).resolves.toHaveProperty('promptId', 'p');
      expect(updates.mock.calls.some(([, , monitor]) => monitor?.state === 'suspected-stall')).toBe(true);
      const activities = updates.mock.calls.map(([, activity]) => activity).filter(Boolean);
      expect(new Set(activities.map((a) => a.updatedAt)).size).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('H3 Comfy client workflow adapter', () => {
  it('loads the currently selected bundle root for each generation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-root-switch-'));
    let selected = path.join(directory, 'first');
    for (const name of ['first', 'second']) {
      const folder = path.join(directory, name, 'workflows', 'lowvram');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, '01_reference_4step_sla_lowvram.api.json'),
        JSON.stringify({
          '1': { class_type: 'Test', inputs: { value: name } },
        })
      );
    }
    const submitted: string[] = [];
    const client = new H3ComfyClient({
      bundleRoot: () => selected,
      fetchImpl: (async (input, init) => {
        if (String(input).includes('/object_info/'))
          return Response.json({ Test: { input: { required: { value: ['STRING'] } }, output: [] } });
        submitted.push(JSON.parse(String(init?.body)).prompt['1'].inputs.value);
        return Response.json({ error: { message: 'test stops before execution' } }, { status: 400 });
      }) as typeof fetch,
    });
    try {
      await expect(client.generate({ prompt: 'test' }, new AbortController().signal)).rejects.toThrow();
      selected = path.join(directory, 'second');
      await expect(client.generate({ prompt: 'test' }, new AbortController().signal)).rejects.toThrow();
      expect(submitted).toEqual(['first', 'second']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it('explicitly disables SLA for dense execution without mutating the pinned template', () => {
    const template = { '1': { class_type: 'H3SLAAttention', inputs: { enabled: true } } };
    expect(buildH3Workflow(template, { prompt: 'lake' }, 'dense')['1'].inputs?.enabled).toBe(false);
    expect(buildH3Workflow(template, { prompt: 'lake' }, 'sla')['1'].inputs?.enabled).toBe(true);
    expect(buildH3Workflow(template, { prompt: 'lake' })['1'].inputs?.enabled).toBe(false);
    expect(template['1'].inputs.enabled).toBe(true);
  });
  it('reads the remote queue without exposing a second execution path', async () => {
    const client = new H3ComfyClient({
      fetchImpl: (async (input) => {
        expect(String(input)).toBe('http://127.0.0.1:8188/queue');
        return Response.json({ queue_running: [['running-prompt']], queue_pending: [['queued-prompt']] });
      }) as typeof fetch,
    });
    await expect(client.queueStatus()).resolves.toEqual({
      queue_running: [['running-prompt']],
      queue_pending: [['queued-prompt']],
    });
  });

  it('frees ComfyUI memory only through the pinned local endpoint', async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    const client = new H3ComfyClient({
      fetchImpl: (async (input, init) => {
        requests.push({ url: String(input), method: init?.method, body: String(init?.body ?? '') });
        return Response.json({});
      }) as typeof fetch,
    });
    await client.freeMemory(true);
    expect(requests).toEqual([
      { url: 'http://127.0.0.1:8188/free', method: 'POST', body: '{"unload_models":true,"free_memory":true}' },
    ]);
  });

  it('routes H3 input materials by the official three-mode contract', () => {
    expect(inferH3Mode({ prompt: 'a city' })).toBe('t2v');
    expect(inferH3Mode({ prompt: 'a city', references: [{ type: 'image', path: 'a.png' }] })).toBe('fl2v');
    expect(
      inferH3Mode({
        prompt: 'a city',
        references: [
          { type: 'image', path: 'a.png' },
          { type: 'image', path: 'b.png' },
        ],
      })
    ).toBe('fl2v');
    expect(
      inferH3Mode({
        prompt: 'a city',
        references: [
          { type: 'image', path: 'a.png' },
          { type: 'image', path: 'b.png' },
          { type: 'image', path: 'c.png' },
        ],
      })
    ).toBe('ref2va');
    expect(
      inferH3Mode({
        prompt: 'a city',
        references: [
          { type: 'video', path: 'a.mp4' },
          { type: 'audio', path: 'a.wav' },
        ],
      })
    ).toBe('ref2va');
  });

  it('enforces the official 4-15 second native output range', () => {
    expect(() => createH3Job({ prompt: 'short', durationSeconds: 3.99 })).toThrow();
    expect(() => createH3Job({ prompt: 'long', durationSeconds: 15.01 })).toThrow();
    expect(createH3Job({ prompt: 'minimum', durationSeconds: 4 }).spec.durationSeconds).toBe(4);
    expect(createH3Job({ prompt: 'maximum', durationSeconds: 15 }).spec.durationSeconds).toBe(15);
  });

  it('rejects explicit modes that conflict with the supplied context', () => {
    expect(() => inferH3Mode({ mode: 't2v', references: [{ type: 'image', path: 'a.png' }] })).toThrow(
      'H3_T2V_REFERENCES_NOT_ALLOWED'
    );
    expect(() => inferH3Mode({ mode: 'fl2v', references: [{ type: 'video', path: 'a.mp4' }] })).toThrow(
      'H3_FL2V_REQUIRES_ONE_OR_TWO_IMAGES'
    );
    expect(() => inferH3Mode({ mode: 'ref2va', references: [] })).toThrow('H3_REF2VA_REQUIRES_REFERENCES');
  });

  it('enforces the official Ref2VA file-count limits', () => {
    const images = Array.from({ length: 10 }, (_, index) => ({ type: 'image' as const, path: `${index}.png` }));
    expect(() => inferH3Mode({ references: images })).toThrow('H3_REFERENCE_LIMIT_IMAGES');
  });

  it('normalizes the legacy reference image field into the inferred image-to-video mode', () => {
    const job = createH3Job({ prompt: 'portrait', referenceImagePath: 'portrait.png' }, 'job-route');
    expect(job.spec.mode).toBe('auto');
    expect(job.spec.references).toEqual([{ type: 'image', path: 'portrait.png' }]);
    expect(job.resolvedMode).toBe('fl2v');
  });

  it('binds first and last images for FL2VA without mutating the template', () => {
    const template = {
      '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'old' } },
      '131': { class_type: 'MiniMaxH3ImageToVideo', inputs: { first_frame: ['901', 0] } },
      '901': { class_type: 'LoadImage', inputs: { image: 'old-a.png' } },
      '902': { class_type: 'LoadImage', inputs: { image: 'old-b.png' } },
    };
    const result = buildH3Workflow(template, {
      prompt: 'new',
      mode: 'fl2v',
      references: [
        { type: 'image', path: 'a.png' },
        { type: 'image', path: 'b.png' },
      ],
    });
    expect(result['901'].inputs?.image).toBe('a.png');
    expect(result['902'].inputs?.image).toBe('b.png');
    expect(result['131'].inputs?.last_frame).toEqual(['902', 0]);
    expect(template['131'].inputs?.last_frame).toBeUndefined();
  });

  it('binds all reference media types to Ref2VA dynamic inputs', () => {
    const template = {
      '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'old' } },
      '131': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { 'ref_images.ref_image_0': ['901', 0] } },
      '901': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
    };
    const result = buildH3Workflow(template, {
      prompt: 'new',
      mode: 'ref2va',
      references: [
        { type: 'image', path: 'a.png' },
        { type: 'image', path: 'b.png' },
        { type: 'video', path: 'clip.mp4' },
        { type: 'audio', path: 'sound.wav' },
      ],
    });
    expect(result['131'].inputs?.['ref_images.ref_image_0']).toEqual(['901', 0]);
    expect(result['131'].inputs?.['ref_images.ref_image_1']).toEqual(['902', 0]);
    expect(result['131'].inputs?.['ref_videos.ref_video_0']).toEqual(['904', 0]);
    expect(result['131'].inputs?.['ref_video_audios.ref_video_audio_0']).toEqual(['904', 1]);
    expect(result['131'].inputs?.['ref_audios.ref_audio_0']).toEqual(['905', 0]);
    expect(result['902'].class_type).toBe('LoadImage');
    expect(result['903'].class_type).toBe('LoadVideo');
    expect(result['904'].class_type).toBe('GetVideoComponents');
    expect(result['905'].class_type).toBe('LoadAudio');
  });

  it('uses the filename returned by ComfyUI when an uploaded reference is renamed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-h3-upload-'));
    const reference = path.join(directory, 'reference.png');
    const workflowPath = path.join(directory, 'workflow.json');
    fs.writeFileSync(reference, 'image');
    fs.writeFileSync(
      workflowPath,
      JSON.stringify({
        '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'old' } },
        '131': { class_type: 'MiniMaxH3ImageToVideo', inputs: { first_frame: ['901', 0] } },
        '901': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
      })
    );
    let submittedBody = '';
    const client = new H3ComfyClient({
      workflowPath,
      pollIntervalMs: 0,
      fetchImpl: (async (input, init) => {
        const url = String(input);
        if (url.includes('/object_info/'))
          return Response.json({
            PrimitiveStringMultiline: { input: { required: { value: ['STRING'] } }, output: ['STRING'] },
            MiniMaxH3ImageToVideo: { input: { required: { first_frame: ['IMAGE'] } }, output: [] },
            LoadImage: { input: { required: { image: [['reference (1).png']] } }, output: ['IMAGE'] },
          });
        if (url.endsWith('/upload/image')) return Response.json({ name: 'reference (1).png' });
        if (url.endsWith('/prompt')) {
          submittedBody = String(init?.body);
          return Response.json({ prompt_id: 'prompt-1' });
        }
        if (url.endsWith('/history/prompt-1')) {
          return Response.json({
            'prompt-1': { status: { completed: true }, outputs: { out: { videos: [{ filename: 'out.mp4' }] } } },
          });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    await client.generate(
      { prompt: 'move', references: [{ type: 'image', path: reference }] },
      new AbortController().signal
    );
    const submitted = JSON.parse(submittedBody) as { prompt: Record<string, { inputs: Record<string, unknown> }> };
    expect(submitted.prompt['901'].inputs.image).toBe('reference (1).png');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects a reference whose extension does not match its declared media type', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-h3-type-'));
    const reference = path.join(directory, 'not-an-image.txt');
    const workflowPath = path.join(directory, 'workflow.json');
    fs.writeFileSync(reference, 'private text');
    fs.writeFileSync(
      workflowPath,
      JSON.stringify({
        '131': { class_type: 'MiniMaxH3ImageToVideo', inputs: {} },
      })
    );
    const fetchImpl = vi.fn();
    const client = new H3ComfyClient({ workflowPath, fetchImpl: fetchImpl as typeof fetch });
    await expect(
      client.generate(
        { prompt: 'move', references: [{ type: 'image', path: reference }] },
        new AbortController().signal
      )
    ).rejects.toThrow('H3_REFERENCE_TYPE_MISMATCH');
    expect(fetchImpl).not.toHaveBeenCalled();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('changes only user-controlled generation inputs and keeps the template immutable', () => {
    const template = {
      '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'old' } },
      '115': { class_type: 'ResolutionSelector', inputs: { megapixels: 0.7 } },
      '133': { class_type: 'PrimitiveFloat', inputs: { value: 10 } },
      '129': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
    };
    const result = buildH3Workflow(template, { prompt: 'new', megapixels: 0.2, durationSeconds: 4, seed: 7 });
    expect(result['1'].inputs?.value).toBe('new');
    expect(result['115'].inputs?.megapixels).toBe(0.2);
    expect(result['133'].inputs?.value).toBe(4);
    expect(result['129'].inputs?.noise_seed).toBe(7);
    expect(template['1'].inputs?.value).toBe('old');
  });

  it('cancels one queued or running prompt through the pinned by-id endpoint', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const client = new (await import('@/process/services/runtime/H3ComfyClient')).H3ComfyClient({
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (input, init) => {
        requests.push({ url: String(input), body: init?.body?.toString() });
        return Response.json(
          String(input).endsWith('/cancel')
            ? { cancelled: true }
            : String(input).endsWith('/queue')
              ? { queue_running: [], queue_pending: [] }
              : {}
        );
      }) as typeof fetch,
    });
    await client.cancel('prompt-1');
    expect(requests[0]).toEqual({ url: 'http://127.0.0.1:8188/api/jobs/prompt-1/cancel' });
    expect(requests.filter((r) => r.url.endsWith('/queue'))).toHaveLength(2);
    expect(requests.some((r) => r.url.endsWith('/interrupt'))).toBe(false);
  });
  it('terminates on execution errors even when completed is false', async () => {
    const client = new H3ComfyClient({
      fetchImpl: (async () =>
        Response.json({ p: { status: { status_str: 'error', completed: false } } })) as typeof fetch,
    });
    await expect(client.resume('p', new AbortController().signal)).rejects.toThrow('H3_COMFY_EXECUTION_FAILED');
  });
  it('fails a missing prompt after the queue/history race grace period', async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = new H3ComfyClient({
      maxIdleMs: 5,
      missingGraceMs: 20,
      heartbeatIntervalMs: 0,
      pollIntervalMs: 0,
      sleep: async () => {
        now += 10;
      },
      fetchImpl: (async (url) =>
        Response.json(String(url).endsWith('/queue') ? { queue_running: [], queue_pending: [] } : {})) as typeof fetch,
    });
    try {
      await expect(client.resume('stalled', new AbortController().signal)).rejects.toThrow('H3_COMFY_PROMPT_LOST');
    } finally {
      clock.mockRestore();
    }
  });
  it('ends the job when the ComfyUI runtime heartbeat is lost', async () => {
    const client = new H3ComfyClient({
      maxIdleMs: 60_000,
      heartbeatIntervalMs: 0,
      heartbeatFailureLimit: 2,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (input) =>
        String(input).endsWith('/history/lost')
          ? Response.json({})
          : new Response('{}', { status: 503 })) as typeof fetch,
    });
    await expect(client.resume('lost', new AbortController().signal)).rejects.toThrow('H3_COMFY_HEARTBEAT_LOST');
  });
  it('rejects a cancellation response that did not cancel the remote prompt', async () => {
    const client = new H3ComfyClient({
      cancelConfirmAttempts: 1,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetchImpl: (async (url) =>
        Response.json(
          String(url).endsWith('/cancel')
            ? { cancelled: false }
            : String(url).endsWith('/queue')
              ? { queue_running: [[0, 'p']], queue_pending: [] }
              : {}
        )) as typeof fetch,
    });
    await expect(client.cancel('p')).rejects.toThrow('H3_COMFY_CANCEL_UNCONFIRMED');
  });

  it('does not promote uploaded references or previews to generated outputs', async () => {
    const client = new H3ComfyClient({
      fetchImpl: (async () =>
        Response.json({
          p: {
            status: { completed: true },
            outputs: {
              out: {
                videos: [
                  { filename: 'reference.mp4', type: 'input' },
                  { filename: 'preview.mp4', type: 'temp' },
                  { filename: 'result.mp4', type: 'output' },
                ],
              },
            },
          },
        })) as typeof fetch,
    });
    const result = await client.resume('p', new AbortController().signal);
    expect(result.artifacts.map((artifact) => artifact.filename)).toEqual(['result.mp4']);
  });

  it('reports OOM with a node-specific diagnosis without leaking traceback paths', async () => {
    const client = new H3ComfyClient({
      fetchImpl: (async () =>
        Response.json({
          p: {
            status: {
              status_str: 'error',
              messages: [
                [
                  'execution_error',
                  {
                    node_id: '129',
                    exception_type: 'torch.OutOfMemoryError',
                    exception_message: 'CUDA out of memory at D:/private/model',
                    traceback: ['private traceback'],
                  },
                ],
              ],
            },
          },
        })) as typeof fetch,
    });
    await expect(client.resume('p', new AbortController().signal)).rejects.toMatchObject({
      message: 'H3_COMFY_EXECUTION_FAILED:OOM:node=129',
      diagnosis: { category: 'OOM', nodeId: '129', retryable: false, action: 'REVIEW_MEMORY_BUDGET' },
    });
  });

  it('keeps structured prompt validation errors actionable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-invalid-'));
    const workflowPath = path.join(directory, 'workflow.json');
    fs.writeFileSync(workflowPath, JSON.stringify({ '42': { class_type: 'Test', inputs: {} } }));
    try {
      const client = new H3ComfyClient({
        workflowPath,
        fetchImpl: (async (input) =>
          String(input).includes('/object_info/')
            ? Response.json({ Test: { input: {}, output: [] } })
            : Response.json(
                {
                  error: { type: 'prompt_outputs_failed_validation', message: 'Output failed' },
                  node_errors: {
                    '42': { errors: [{ type: 'required_input_missing', message: 'Required input missing' }] },
                  },
                },
                { status: 400 }
              )) as typeof fetch,
      });
      await expect(client.generate({ prompt: 'test' }, new AbortController().signal)).rejects.toMatchObject({
        message: 'H3_COMFY_PROMPT_REJECTED:INVALID_INPUT:node=42',
        diagnosis: { category: 'INVALID_INPUT', nodeId: '42', retryable: false, action: 'CHECK_WORKFLOW_INPUTS' },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

it('reports node-scoped activity without inventing total progress and clears counters on node change', async () => {
  let polls = 0;
  const client = new H3ComfyClient({
    fetchImpl: (async () =>
      Response.json(
        ++polls === 1
          ? {}
          : {
              p: {
                status: { completed: true },
                outputs: { '92': { videos: [{ filename: 'test.mp4', type: 'output' }] } },
              },
            }
      )) as typeof fetch,
  });
  const queue = [
    { type: 'executing', data: { prompt_id: 'p', node: '125', node_type: 'SamplerCustomAdvanced' } },
    { type: 'progress', data: { prompt_id: 'p', node: '125', value: 2, max: 4 } },
    { type: 'executing', data: { prompt_id: 'p', node: '122', node_type: 'VAEDecode' } },
    { type: 'execution_success', data: { prompt_id: 'p' } },
  ];
  const events = {
    connected: true,
    next: async () => queue.shift(),
  } as unknown as import('@/process/services/runtime/h3ComfyEvents').H3ComfyEvents;
  const progress = vi.fn();
  await client.resume('p', new AbortController().signal, progress, events);
  expect(progress.mock.calls.slice(0, -1).every(([fraction]) => fraction === 0)).toBe(true);
  expect(progress.mock.calls[2][1]).toMatchObject({ phase: 'node-progress', nodeId: '125', value: 2, max: 4 });
  expect(progress.mock.calls[3][1]).toMatchObject({ phase: 'executing', nodeType: 'VAEDecode' });
  expect(progress.mock.calls[3][1]).not.toHaveProperty('value');
  expect(progress).toHaveBeenLastCalledWith(1);
});
