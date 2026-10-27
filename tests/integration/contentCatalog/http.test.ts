import { describe, it, expect } from 'vitest';
import { startContentHost } from '@/process/services/contentCatalog/host';
const catalog = {
  schemaVersion: 1,
  releaseSequence: 0,
  defaultLocale: 'en-US',
  publishedAt: new Date().toISOString(),
  entries: [],
  models: [],
  assets: [],
};
describe('protected content HTTP host', () => {
  it('rejects unauthenticated calls and serves only the declared contract', async () => {
    const fake = {
      getCatalog: () => catalog,
      getStatus: () => ({ phase: 'ready' }),
      lease: () => {},
      asset: async () => ({ bytes: Buffer.from('12345678'), asset: { mimeType: 'video/mp4' } }),
    };
    const h = await startContentHost(fake as never);
    try {
      expect((await fetch(h.url + '/api/content-catalog/catalog')).status).toBe(401);
      const headers = { 'x-openh3-content-token': h.token };
      expect((await fetch(h.url + '/api/content-catalog/catalog', { headers })).status).toBe(200);
      const r = await fetch(h.url + '/api/content-catalog/assets/0/' + 'a'.repeat(64), {
        headers: { ...headers, range: 'bytes=0-3' },
      });
      expect(r.status).toBe(206);
      expect(await r.text()).toBe('1234');
      expect(
        (
          await fetch(h.url + '/api/content-catalog/assets/0/' + 'a'.repeat(64), {
            headers: { ...headers, range: 'bytes=999-' },
          })
        ).status
      ).toBe(416);
      expect((await fetch(h.url + '/api/content-catalog/assets/0/..%2Fsecret', { headers })).status).toBe(404);
    } finally {
      await h.close();
    }
  });
});
