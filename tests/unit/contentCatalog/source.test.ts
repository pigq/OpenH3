import { describe, it, expect, vi } from 'vitest';
import { GitHubContentSource } from '@/process/services/contentCatalog/source';
import { candidate, keys } from './fixtures';
import { ContentRequestPool } from '@/process/services/contentCatalog/assets';
describe('fixed GitHub channel', () => {
  it('aborts and joins the sibling metadata request before returning a failure', async () => {
    let siblingSignal: AbortSignal | undefined;
    let cleaned = false;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/commits/')) return new Response(JSON.stringify({ sha: 'b'.repeat(40) }));
      if (u.endsWith('manifest.json')) return new Response(null, { status: 500 });
      siblingSignal = init!.signal!;
      return new Response(
        new ReadableStream({
          cancel() {
            cleaned = true;
          },
        })
      );
    });
    await expect(new GitHubContentSource(keys, fetcher).check(0, new AbortController().signal)).rejects.toThrow(
      'HTTP_500'
    );
    expect(siblingSignal?.aborted).toBe(true);
    expect(cleaned).toBe(true);
  });
  it('pins the channel and snapshot commits and verifies the original bytes', async () => {
    const c = candidate();
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      return new Response(
        u.includes('/commits/')
          ? JSON.stringify({ sha: 'b'.repeat(40) })
          : u.endsWith('manifest.sig')
            ? c.signature
            : u.endsWith('manifest.json')
              ? c.manifestBytes
              : c.catalogBytes
      );
    });
    const result = await new GitHubContentSource(keys, fetcher).check(0, new AbortController().signal);
    expect(result.catalog.releaseSequence).toBe(1);
    expect(urls).toEqual([
      'https://api.github.com/repos/pigq/OpenH3/commits/content-stable',
      `https://raw.githubusercontent.com/pigq/OpenH3/${'b'.repeat(40)}/manifest.json`,
      `https://raw.githubusercontent.com/pigq/OpenH3/${'b'.repeat(40)}/manifest.sig`,
      `https://raw.githubusercontent.com/pigq/OpenH3/${'a'.repeat(40)}/catalog.json`,
    ]);
  });
  it('rejects redirects outside the allowlist and unexpected ports', async () => {
    for (const location of [
      'https://static.aionui.com/x',
      'https://raw.githubusercontent.com:8443/x',
      'http://raw.githubusercontent.com/x',
    ]) {
      const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
      await expect(new GitHubContentSource(keys, fetcher).check(0, new AbortController().signal)).rejects.toThrow(
        'HOST_NOT_ALLOWED'
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('does not make requests when the trust root is unconfigured', async () => {
    const fetcher = vi.fn();
    await expect(new GitHubContentSource({}, fetcher).check(0, new AbortController().signal)).rejects.toThrow(
      'TRUST_UNCONFIGURED'
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces streamed byte limits without trusting content-length', async () => {
    let cancelled = false;
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(200000));
            },
            cancel() {
              cancelled = true;
            },
          })
        )
    );
    await expect(new GitHubContentSource(keys, fetcher).check(0, new AbortController().signal)).rejects.toThrow(
      'SIZE_LIMIT'
    );
    expect(cancelled).toBe(true);
  });
  it('cancels a stalled reader when its caller aborts', async () => {
    let cancelled = false;
    const abort = new AbortController();
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              setTimeout(() => abort.abort(), 5);
            },
            cancel() {
              cancelled = true;
            },
          })
        )
    );
    await expect(new GitHubContentSource(keys, fetcher).check(0, abort.signal)).rejects.toThrow();
    expect(cancelled).toBe(true);
  }, 200);
  it('shares a four-request budget and removes aborted waiters', async () => {
    const pool = new ContentRequestPool();
    let active = 0,
      max = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      pool.run(new AbortController().signal, async () => {
        active++;
        max = Math.max(max, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
      });
    const tasks = Array.from({ length: 4 }, task);
    const abort = new AbortController();
    const queued = pool.run(abort.signal, vi.fn());
    const rejected = queued.catch((e) => e);
    abort.abort();
    expect(await rejected).toBeInstanceOf(Error);
    const fifth = task();
    expect(active).toBe(4);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    for (const done of releases.splice(0)) done();
    await Promise.all([...tasks, fifth]);
    expect(max).toBe(4);
  });
});
