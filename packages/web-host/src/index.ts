import type { WebHostOptions, WebHostHandle } from './types.js';
import path from 'node:path';
import { createContentRuntime } from '../../desktop/src/process/services/contentCatalog/builtin';

export type { AppMetadata, BackendBinaryResolver, WebHostOptions, WebHostHandle } from './types.js';
export { startStaticServer, stopStaticServer } from './static-server.js';
export type { StaticServerOptions, StaticServerHandle } from './static-server.js';

// Backend launcher exports (M4)
export {
  BackendStartupCancelledError,
  BackendLifecycleManager,
  buildSpawnArgs,
  buildSpawnEnv,
  findAvailablePort,
  startBackend,
  stopBackend,
} from './backend-launcher.js';
export type { BackendDirConfig, BackendLaunchOptions, BackendHandle, BackendStartOptions } from './backend-launcher.js';

/**
 * Start WebHost (main entry point).
 *
 * Orchestrates backend-launcher + static-server. web-host itself holds no
 * persistent configuration — callers (Electron main process, `bun run webui`
 * CLI) are responsible for resolving port / allowRemote from their own source
 * of truth (Electron ProcessConfig, CLI flags, env vars).
 */
export async function startWebHost(opts: WebHostOptions): Promise<WebHostHandle> {
  const { startBackend } = await import('./backend-launcher.js');
  const { startStaticServer } = await import('./static-server.js');

  // 1. Start backend (M4)
  let backendHandle;
  let content: Awaited<ReturnType<typeof createContentRuntime>> | undefined;
  if (opts.backend.kind === 'ownBackend') {
    content = await createContentRuntime(
      opts.contentCatalogDir ??
        path.join(opts.app.resourcesPath, opts.app.isPackaged ? 'content-catalog' : 'out/content-catalog'),
      opts.dataDir ?? opts.app.userDataPath,
      opts.app.version
    );
    try {
      backendHandle = await startBackend({
        app: opts.app,
        resolveBackend: opts.backend.resolveBackend,
        dataDir: opts.dataDir,
        logDir: opts.logDir,
        dirs: opts.dirs,
        contentHost: content.host,
      });
    } catch (error) {
      await content.stop();
      throw error;
    }
  } else {
    // useExistingBackend: create a fake handle
    backendHandle = {
      port: opts.backend.port,
      stop: async () => {
        // no-op: external backend
      },
    };
  }

  let staticHandle;
  try {
    // 2. Start static-server (M5)
    staticHandle = await startStaticServer({
      staticDir: opts.staticDir,
      backendPort: backendHandle.port,
      port: opts.port,
      allowRemote: opts.allowRemote ?? false,
    });
  } catch (err) {
    // If static-server fails, clean up backend
    await backendHandle.stop();
    await content?.stop();
    throw err;
  }

  // 3. Return combined handle
  return {
    port: staticHandle.port,
    backendPort: backendHandle.port,
    url: staticHandle.url,
    localUrl: staticHandle.localUrl,
    networkUrl: staticHandle.networkUrl,
    lanIP: staticHandle.lanIP,
    async stop() {
      await staticHandle.stop();
      await backendHandle.stop();
      await content?.stop();
    },
  };
}
