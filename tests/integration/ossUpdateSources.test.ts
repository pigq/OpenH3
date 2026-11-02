/** Source failover against local HTTP feeds; this does not claim native installation coverage. */
import { createServer, get } from 'node:http';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { UpdateInfo } from 'electron-updater';
import type { AppUpdater } from 'electron-updater/out/AppUpdater';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  logger: null as unknown,
  on: vi.fn(),
  removeListener: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
}));
vi.mock('electron-updater', () => ({ autoUpdater: native }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '3.0.7', getPath: () => '/unused-local-feed-profile' },
  autoUpdater: { on: vi.fn(), removeListener: vi.fn() },
  shell: { openPath: vi.fn() },
}));
vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@/process/services/autoUpdateDiagnostics', () => ({
  recordAutoUpdateStatus: vi.fn(),
  recordAutoUpdateNativeInstallReady: vi.fn(),
  recordAutoUpdateNativeInstallError: vi.fn(),
  recordAutoUpdateNativeInstallTimeout: vi.fn(),
  recordAutoUpdateQuitAndInstall: vi.fn(),
}));

const readUrl = (url: URL): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () =>
        response.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${response.statusCode}`))
      );
    }).on('error', reject);
  });

describe('OSS stable source failover with local HTTP fixtures', () => {
  let server: Server;
  const requests: string[] = [];
  const bytes = Buffer.from('identical installer bytes on both origins');
  const digest = createHash('sha512').update(bytes).digest('base64');
  let ossMetadataStatus = 200;
  let ossDownloadStatus = 200;
  let githubVersion = '3.0.8';
  let githubDigest = digest;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    requests.length = 0;
    ossMetadataStatus = ossDownloadStatus = 200;
    githubVersion = '3.0.8';
    githubDigest = digest;
  });
  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    vi.restoreAllMocks();
  });

  const initialize = async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push(url.pathname);
      const isOss = url.pathname.startsWith('/oss/');
      if (url.pathname.endsWith('/latest.yml')) {
        const version = isOss ? '3.0.8' : githubVersion;
        response
          .writeHead(isOss ? ossMetadataStatus : 200, { 'Content-Type': 'text/yaml' })
          .end(
            `version: ${version}\nfiles:\n  - url: OpenH3-${version}-win-x64.exe\n    sha512: ${isOss ? digest : githubDigest}\n    size: ${bytes.length}\n`
          );
      } else {
        response.writeHead(isOss ? ossDownloadStatus : 200).end(bytes);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const { CdnGenericProvider } = await import('@/process/services/cdnGenericProvider');
    const runtime: ProviderRuntimeOptions = {
      platform: 'win32',
      isUseMultipleRangeRequest: false,
      executor: {
        request: (options: { protocol: string; hostname: string; port: number; path: string }) =>
          readUrl(new URL(`${options.protocol}//${options.hostname}:${options.port}${options.path}`)).then((value) =>
            value.toString('utf8')
          ),
      } as unknown as ProviderRuntimeOptions['executor'],
    };
    let provider: GenericProvider;
    const cache = native as typeof native & { updateInfoAndProvider?: { info: UpdateInfo; provider: GenericProvider } };
    delete cache.updateInfoAndProvider;
    native.setFeedURL.mockImplementation((options: { provider: string }) => {
      provider =
        options.provider === 'github'
          ? new GenericProvider({ provider: 'generic', url: `${base}/github/` }, {} as AppUpdater, runtime)
          : new CdnGenericProvider({ provider: 'custom', url: `${base}/oss/` }, {} as AppUpdater, runtime);
    });
    native.checkForUpdates.mockImplementation(async () => {
      const updateInfo = await provider.getLatestVersion();
      cache.updateInfoAndProvider = { info: updateInfo, provider };
      return { isUpdateAvailable: true, updateInfo };
    });
    native.downloadUpdate.mockImplementation(async () => {
      const active = cache.updateInfoAndProvider;
      if (!active) throw new Error('No update checked');
      const file = active.provider.resolveFiles(active.info)[0];
      if (!file) throw new Error('No installer resolved');
      const downloaded = await readUrl(file.url);
      if (createHash('sha512').update(downloaded).digest('base64') !== file.info.sha512)
        throw new Error('SHA-512 mismatch');
      return [];
    });
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();
    return autoUpdaterService;
  };

  it('checks and downloads from OSS without contacting GitHub', async () => {
    const service = await initialize();
    expect((await service.checkForUpdates()).success).toBe(true);
    expect(await service.downloadUpdate()).toEqual({ success: true });
    expect(requests).toEqual(['/oss/latest.yml', '/oss/3.0.8/OpenH3-3.0.8-win-x64.exe']);
  });

  it('uses GitHub when the OSS channel metadata is unavailable', async () => {
    ossMetadataStatus = 503;
    const service = await initialize();
    expect((await service.checkForUpdates()).success).toBe(true);
    expect((await service.downloadUpdate()).success).toBe(true);
    expect(requests).toEqual(['/oss/latest.yml', '/github/latest.yml', '/github/OpenH3-3.0.8-win-x64.exe']);
  });

  it('retries an identical installer on GitHub after OSS download failure', async () => {
    ossDownloadStatus = 503;
    const service = await initialize();
    await service.checkForUpdates();
    expect((await service.downloadUpdate()).success).toBe(true);
    expect(requests).toEqual([
      '/oss/latest.yml',
      '/oss/3.0.8/OpenH3-3.0.8-win-x64.exe',
      '/github/latest.yml',
      '/github/OpenH3-3.0.8-win-x64.exe',
    ]);
  });

  it.each(['version', 'digest'])('never downloads a fallback whose %s differs', async (mismatch) => {
    ossDownloadStatus = 503;
    if (mismatch === 'version') githubVersion = '3.0.9';
    else githubDigest = createHash('sha512').update('different installer').digest('base64');
    const service = await initialize();
    await service.checkForUpdates();
    expect((await service.downloadUpdate()).success).toBe(false);
    expect(requests).toEqual(['/oss/latest.yml', '/oss/3.0.8/OpenH3-3.0.8-win-x64.exe', '/github/latest.yml']);
  });
});
