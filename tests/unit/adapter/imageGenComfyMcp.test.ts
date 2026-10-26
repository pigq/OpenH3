import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { z } from 'zod';

type Reply = { isError?: boolean; content: Array<{ type: string; text: string }> };
type RegisteredTool = { schema: z.ZodRawShape; callback: (input: Record<string, unknown>) => Promise<Reply> };
const { registered, fetchMock, cloudMock } = vi.hoisted(() => ({
  registered: new Map<string, RegisteredTool>(),
  fetchMock: vi.fn(),
  cloudMock: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string, _description: string, schema: z.ZodRawShape, callback: RegisteredTool['callback']) {
      registered.set(name, { schema, callback });
    }
    connect() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    close() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@/common/chat/imageGenCore', () => ({ executeImageGeneration: cloudMock }));

const requestId = 'session-image-1';
const profile = { id: 'selected-z-image', family: 'z-image', kind: 'image', state: 'verified' };
function respond(value: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  );
}
function localSelection(overrides: Record<string, unknown> = {}) {
  return {
    profiles: [profile],
    selection: {
      profileId: profile.id,
      family: profile.family,
      source: 'local',
      kind: 'image',
      intent: 'generate',
      ...overrides,
    },
  };
}
async function invoke(input: Record<string, unknown>): Promise<Reply> {
  const tool = registered.get('aionui_image_generation')!;
  return tool.callback(z.object(tool.schema).parse(input));
}

beforeEach(async () => {
  vi.resetModules();
  registered.clear();
  fetchMock.mockReset();
  cloudMock.mockReset();
  cloudMock.mockResolvedValue({ success: true, text: 'Cloud image ready' });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('AIONUI_CREATION_REQUEST_ID', requestId);
  vi.stubEnv('AIONUI_CREATION_SOURCE', 'local');
  vi.stubEnv('AIONUI_CREATION_KIND', 'image');
  vi.stubEnv('AIONUI_CREATION_PROFILE', 'stale-profile');
  vi.stubEnv('AIONUI_MEDIA_PORT', '33009');
  vi.stubEnv('AIONUI_IMG_PLATFORM', 'openai');
  vi.stubEnv('AIONUI_IMG_MODEL', 'gpt-image');
  await import('@/process/resources/builtinMcp/imageGenServer');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('local image tool routing', () => {
  it('uses current service selection instead of stale environment and returns a generic image job', async () => {
    vi.stubEnv('AIONUI_CREATION_SOURCE', 'cloud');
    vi.stubEnv('AIONUI_CREATION_KIND', 'video');
    respond(localSelection());
    const job = { id: 'image-job-1', status: 'queued', profileId: profile.id, kind: 'image', artifacts: [] };
    respond(job);
    const reply = await invoke({ prompt: 'Generate a red sphere', image_uris: ['source.png'] });
    expect(fetchMock.mock.calls[0][0]).toBe(`http://127.0.0.1:33009/api/comfy/profiles?requestId=${requestId}`);
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:33009/api/comfy/jobs');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      profileId: profile.id,
      requestId,
      input: { prompt: 'Generate a red sphere', imagePaths: [path.resolve('source.png')] },
    });
    expect(JSON.parse(reply.content[0].text)).toEqual({ comfyJobId: job.id, job });
    expect(cloudMock).not.toHaveBeenCalled();
  });

  it('requires a verified selected profile rather than choosing a different available image model', async () => {
    respond({
      ...localSelection(),
      profiles: [
        { ...profile, state: 'loadable' },
        { id: 'other-profile', state: 'verified', kind: 'image' },
      ],
    });
    const reply = await invoke({ prompt: 'A red sphere' });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('COMFY_PROFILE_NOT_VERIFIED');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cloudMock).not.toHaveBeenCalled();
  });

  it('does not route installation or repair intent into a generation', async () => {
    respond(localSelection({ intent: 'repair' }));
    const reply = await invoke({ prompt: 'Repair the model' });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CREATION_GENERATION_NOT_SELECTED');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cloudMock).not.toHaveBeenCalled();
  });

  it('requires local paths for local edits and does not download remote images or use cloud', async () => {
    respond(localSelection());
    const reply = await invoke({ prompt: 'Edit this image', image_uris: ['https://example.com/input.png'] });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('COMFY_LOCAL_IMAGE_PATH_REQUIRED');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cloudMock).not.toHaveBeenCalled();
  });

  it('surfaces a selection change between inspection and submission without retry or cloud fallback', async () => {
    respond(localSelection());
    respond({ error: 'COMFY_SELECTION_CHANGED' }, 409);
    const reply = await invoke({ prompt: 'A red sphere' });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('COMFY_SELECTION_CHANGED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cloudMock).not.toHaveBeenCalled();
  });

  it('uses explicit current cloud selection despite stale local environment', async () => {
    respond({ profiles: [], selection: { source: 'cloud', kind: 'image', intent: 'generate' } });
    const reply = await invoke({ prompt: 'A red sphere' });
    expect(reply.isError).not.toBe(true);
    expect(reply.content[0].text).toBe('Cloud image ready');
    expect(cloudMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('passes the bound template revision to cloud output metadata, not into the prompt', async () => {
    const templateSnapshot = {
      templateId: 'official:cloud',
      templateRevision: 3,
      releaseSequence: 7,
      locale: 'en-US',
      title: 'Title',
      prompt: 'Original',
      parameters: {},
      requiresReference: false,
    };
    respond({ profiles: [], selection: { source: 'cloud', kind: 'image', intent: 'generate', templateSnapshot } });
    await invoke({ prompt: 'Edited' });
    expect(cloudMock.mock.calls[0][0]).toEqual({ prompt: 'Edited', image_uris: undefined, templateSnapshot });
  });

  it('preserves ordinary configured cloud generation outside creation sessions', async () => {
    vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
    vi.stubEnv('AIONUI_CREATION_SOURCE', '');
    await invoke({ prompt: 'A red sphere' });
    expect(cloudMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never invents a missing session or treats unavailable selection as permission to use cloud', async () => {
    vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
    const missing = await invoke({ prompt: 'A red sphere' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('CREATION_REQUEST_CONTEXT_MISSING');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cloudMock).not.toHaveBeenCalled();
    vi.stubEnv('AIONUI_CREATION_REQUEST_ID', requestId);
    respond({ profiles: [] });
    const unknown = await invoke({ prompt: 'A red sphere' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('COMFY_SELECTION_CONTEXT_MISSING');
    expect(cloudMock).not.toHaveBeenCalled();
  });
});
