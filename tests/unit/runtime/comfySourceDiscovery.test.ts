import { describe, expect, it, vi } from 'vitest';
import { discoverComfySources } from '@/process/services/media/comfy/discovery/sourceDiscovery';
import { resolveComfyTransports } from '@/process/services/media/comfy/planning/transportSelection';

const component = {
  name: 'model.safetensors',
  repository: 'Org/Model',
  path: 'diffusion_models/model.safetensors',
  sha256: 'a'.repeat(64),
  sizeBytes: 120,
};
describe('exact model source discovery', () => {
  it('automatically replaces an unavailable catalog URL with a verified equivalent file', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD')
        return new Response(null, {
          status: String(url).includes('/old/') ? 503 : 200,
          headers: { 'content-length': '120' },
        });
      return new Response(
        JSON.stringify(
          String(url).includes('modelscope.cn')
            ? {
                Data: {
                  Files: [
                    {
                      Path: component.path,
                      Sha256: component.sha256,
                      Size: 120,
                      Revision: 'b'.repeat(40),
                      Type: 'blob',
                    },
                  ],
                },
              }
            : { siblings: [] }
        )
      );
    });
    const urls = await resolveComfyTransports(
      { ...component, url: 'https://huggingface.co/Org/Model/resolve/old/model.safetensors' },
      fetcher
    );
    expect(urls[0]).toContain('modelscope.cn/models/Org/Model/resolve/' + 'b'.repeat(40));
  });
  it('finds a fixed ModelScope revision and rejects same-name different bytes', async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).includes('modelscope.cn')
              ? {
                  Data: {
                    Files: [
                      {
                        Path: component.path,
                        Sha256: component.sha256,
                        Size: 120,
                        Revision: 'b'.repeat(40),
                        Type: 'blob',
                      },
                      {
                        Path: 'wrong/model.safetensors',
                        Sha256: 'c'.repeat(64),
                        Size: 120,
                        Revision: 'd'.repeat(40),
                        Type: 'blob',
                      },
                    ],
                  },
                }
              : { sha: 'e'.repeat(40), siblings: [] }
          )
        )
    );
    const result = await discoverComfySources(component, { fetcher });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ sha256: component.sha256, sizeBytes: 120, revision: 'b'.repeat(40) });
    expect(result.sources[0].url).toContain('/resolve/' + 'b'.repeat(40));
  });
  it('reports inaccessible metadata separately from no matching artifact', async () => {
    const result = await discoverComfySources(component, {
      fetcher: async () => {
        throw new Error('network');
      },
    });
    expect(result.sources).toEqual([]);
    expect(result.attempts.every((attempt) => attempt.status === 'unreachable')).toBe(true);
  });
  it('uses search results only to discover repositories, then verifies provider metadata', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/models?')) return new Response(JSON.stringify([{ id: 'Mirror/Equivalent' }]));
      return new Response(
        JSON.stringify({
          sha: 'e'.repeat(40),
          siblings: String(url).includes('Mirror/Equivalent')
            ? [{ rfilename: 'model.safetensors', size: 120, lfs: { sha256: component.sha256, size: 120 } }]
            : [],
        })
      );
    });
    const result = await discoverComfySources(component, { fetcher });
    expect(result.sources.some((source) => source.repository === 'Mirror/Equivalent')).toBe(true);
    expect(result.sources.every((source) => source.sha256 === component.sha256)).toBe(true);
  });
});
