import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startBackend } from '../../../packages/web-host/src/backend-launcher';
import { startStaticServer } from '../../../packages/web-host/src/static-server';
import { ContentCatalogService } from '@/process/services/contentCatalog/service';
import { ContentStore } from '@/process/services/contentCatalog/store';
import { startContentHost } from '@/process/services/contentCatalog/host';
import { candidate, keys, image, digest, withCatalog } from '../../unit/contentCatalog/fixtures';
import { captureTemplateSnapshot } from '@/common/contentCatalog/snapshot';
import { parseCatalog } from '@/common/contentCatalog/schema';

it.skipIf(!process.env.OPENH3_CORE_TEST_BINARY)(
  'shares verified snapshots across real Core/Desktop/WebUI without changing local models or historical provenance',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'openh3-content-core-'));
    const base = candidate(1);
    const catalog = parseCatalog({
      ...base.catalog,
      entries: [
        {
          id: 'official:example',
          revision: 1,
          origin: 'official',
          entryType: 'template',
          kind: 'image',
          title: { 'en-US': 'Template' },
          description: { 'en-US': 'Description' },
          prompt: { 'en-US': 'Original prompt' },
          cover: digest,
          ratio: '1:1',
          attribution: { author: 'Test author', license: 'CC0', sourceUrl: 'https://github.com/pigq/OpenH3' },
        },
      ],
    });
    const item = catalog.entries[0];
    if (item.entryType !== 'template') throw Error('fixture');
    const provenance = captureTemplateSnapshot(item, 1, 'en-US', 'en-US');
    let remote = withCatalog(base, catalog);
    const service = new ContentCatalogService({
      store: new ContentStore(path.join(root, 'official-content'), keys),
      source: { keys, check: async () => remote, asset: async () => image },
      builtin: { ...catalog, releaseSequence: 0, entries: [] },
      version: '2.2.2',
    });
    await service.initialize();
    const host = await startContentHost(service);
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
    let web: Awaited<ReturnType<typeof startStaticServer>> | undefined;
    try {
      await writeFile(path.join(root, 'user-model.safetensors'), 'user-owned model sentinel');
      await mkdir(path.join(root, 'static'));
      await writeFile(path.join(root, 'static/index.html'), '<title>Isolated content test</title>');
      backend = await startBackend({
        app: { version: '2.2.2', isPackaged: false, resourcesPath: root, userDataPath: root },
        resolveBackend: () => process.env.OPENH3_CORE_TEST_BINARY!,
        dataDir: root,
        contentHost: host,
      });
      const core = `http://127.0.0.1:${backend.port}`;
      web = await startStaticServer({ staticDir: path.join(root, 'static'), backendPort: backend.port, port: 0 });
      const api = '/api/content-catalog';
      expect((await fetch(web.localUrl + api + '/catalog')).status).toBe(401);
      for (const openingPath of ['/ws', '/api/stt/stream']) {
        const response = await new Promise<string>((resolve, reject) => {
          const socket = net.connect(web!.port, '127.0.0.1');
          const chunks: Buffer[] = [];
          socket.setTimeout(5000, () => socket.destroy(new Error('Pipelined request did not close')));
          socket.on('error', reject);
          socket.on('data', (chunk) => chunks.push(chunk));
          socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          socket.once('connect', () => {
            socket.write(
              `GET ${openingPath} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n` +
                `GET ${api}/catalog HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
            );
          });
        });
        expect(response).toContain('401 Unauthorized');
        expect(response).not.toContain('"releaseSequence"');
      }
      expect(
        (
          await fetch(web.localUrl + api + '/check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status
      ).toBe(403);
      const password = await fetch(core + '/api/webui/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ new_password: 'TestOnlyP@ss123!' }),
      });
      expect(password.status).toBe(200);
      const login = await fetch(web.localUrl + '/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'TestOnlyP@ss123!' }),
      });
      expect(login.status).toBe(200);
      const credentials = await login.json();
      const token = credentials.token ?? credentials.data?.token;
      expect(typeof token).toBe('string');
      const headers = {
        Authorization: `Bearer ${token}`,
        cookie: 'aionui-csrf-token=test-csrf',
        'x-csrf-token': 'test-csrf',
        'content-type': 'application/json',
      };
      await service.check();
      expect(service.getStatus().phase).toBe('ready');
      const desktop = await (await fetch(core + api + '/catalog')).json();
      const browser = await (await fetch(web.localUrl + api + '/catalog', { headers })).json();
      expect(browser).toEqual(desktop);
      expect(browser.data.releaseSequence).toBe(1);
      const media = await fetch(web.localUrl + api + '/assets/1/' + digest, {
        headers: { ...headers, range: 'bytes=0-3' },
      });
      expect(media.status).toBe(206);
      expect(await media.text()).toBe(image.subarray(0, 4).toString());
      const create = await fetch(core + '/api/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'acp',
          name: 'Provenance test',
          extra: { creation_request: { id: 'model', source: 'local', templateSnapshot: provenance } },
        }),
      });
      expect(create.status).toBe(201);
      const conversation = (await create.json()).data;
      remote = withCatalog(candidate(2), { ...catalog, releaseSequence: 2, entries: [] });
      await service.check();
      const history = await (await fetch(core + `/api/conversations/${conversation.id}`)).json();
      expect(history.data.extra.creation_request.templateSnapshot).toEqual(provenance);
      expect((await (await fetch(web.localUrl + api + '/catalog', { headers })).json()).data.entries).toHaveLength(0);
      expect(await readFile(path.join(root, 'user-model.safetensors'), 'utf8')).toBe('user-owned model sentinel');
      await service.restore();
      expect((await (await fetch(core + api + '/catalog')).json()).data.releaseSequence).toBe(1);
    } finally {
      await web?.stop();
      await backend?.stop();
      await service.stop();
      await host.close();
      // Windows can briefly retain directory handles after the Core exits.
      // Bound cleanup retries without hiding a persistent resource leak.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  60000
);
