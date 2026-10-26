import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaServiceProcess } from '@/process/services/media/MediaServiceProcess';

describe('media service process', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('starts the media process only after Core has published its actual backend port', () => {
    const source = fs.readFileSync(path.resolve('packages/desktop/src/index.ts'), 'utf8');
    const backendStartup = source.indexOf('const backendStartup = await startBackendOrExit');
    const portPublication = source.indexOf('exposeBackendPort(backendPort);', backendStartup);
    const mediaStartup = source.indexOf('mediaServiceProcess = new MediaServiceProcess');
    expect(backendStartup).toBeGreaterThan(0);
    expect(portPublication).toBeGreaterThan(backendStartup);
    expect(mediaStartup).toBeGreaterThan(portPublication);
  });

  it('updates an already running media child after Core recovery supplies its real port', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-service-recovery-'));
    const scriptPath = path.join(root, 'media-service.js');
    fs.writeFileSync(scriptPath, '');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const manager = new MediaServiceProcess({
      scriptPath,
      dataDir: root,
      sleep: async () => undefined,
      fetchImpl,
      spawnProcess: () => ({ once: () => undefined, kill: () => undefined }) as never,
    });
    try {
      await manager.start();
      await manager.setBackendPort(13422);
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://127.0.0.1:33002/api/comfy/runtime-context',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ backendPort: 13422 }),
          headers: expect.objectContaining({ 'x-openh3-ui-token': manager.uiToken }),
        })
      );
    } finally {
      manager.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { configured: undefined, expected: '1' },
    { configured: '0', expected: '0' },
    { configured: '1', expected: '1' },
  ])('starts a controlled child with system CA setting $configured → $expected', async ({ configured, expected }) => {
    vi.stubEnv('NODE_USE_SYSTEM_CA', configured);
    vi.stubEnv('NODE_EXTRA_CA_CERTS', 'custom-ca.pem');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', undefined);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-service-process-'));
    const scriptPath = path.join(root, 'media-service.js');
    fs.writeFileSync(scriptPath, '');
    let started: { command: string; args: string[]; env: NodeJS.ProcessEnv; stdio: unknown } | undefined;
    const manager = new MediaServiceProcess({
      scriptPath,
      dataDir: root,
      backendPort: 13421,
      bundleRoot: path.join(root, 'h3-bundle'),
      sleep: async () => undefined,
      spawnProcess: (command, args, options) => {
        started = { command, args, env: options.env, stdio: options.stdio };
        return { once: () => undefined, kill: () => undefined } as never;
      },
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    try {
      await manager.start();
      expect(started?.args).toEqual([scriptPath]);
      expect(started?.env.AIONUI_MEDIA_PORT).toBe('33002');
      expect(started?.env.AIONUI_DATA_DIR).toBe(root);
      expect(started?.env.OPENH3_MEDIA_BACKEND_PORT).toBe('13421');
      expect(started?.env.AIONUI_H3_BUNDLE_ROOT).toBe(path.join(root, 'h3-bundle'));
      expect(started?.env.NODE_USE_SYSTEM_CA).toBe(expected);
      expect(started?.env.NODE_EXTRA_CA_CERTS).toBe('custom-ca.pem');
      expect(started?.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
      expect(fs.existsSync(path.join(root, 'media-service.log'))).toBe(true);
    } finally {
      manager.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
