import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveMediaBinary } from './mediaBinary';

export type MediaServiceProcessOptions = {
  scriptPath: string;
  dataDir: string;
  bundleRoot?: string;
  port?: number;
  backendPort?: number;
  command?: string;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; windowsHide: boolean; env: NodeJS.ProcessEnv; stdio: ['ignore', number, number] }
  ) => ChildProcess;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export class MediaServiceProcess {
  private child?: ChildProcess;
  private readonly port: number;
  /** Secret accepted only for consent actions initiated by the Electron UI. */
  readonly uiToken = crypto.randomBytes(32).toString('hex');
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: MediaServiceProcessOptions) {
    this.port = options.port ?? 33002;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (!fs.existsSync(this.options.scriptPath)) throw new Error('MEDIA_SERVICE_SCRIPT_NOT_FOUND');
    fs.mkdirSync(this.options.dataDir, { recursive: true });
    const logPath = path.join(this.options.dataDir, 'media-service.log');
    const logHandle = fs.openSync(logPath, 'a');
    const command = this.options.command ?? process.execPath;
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // Read at Node startup and inherited by download workers. Adds OS trust
      // to bundled/extra CAs without disabling certificate verification.
      NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA ?? '1',
      OPENH3_MEDIA_PORT: String(this.port),
      AIONUI_MEDIA_PORT: String(this.port),
      OPENH3_DATA_DIR: this.options.dataDir,
      AIONUI_DATA_DIR: this.options.dataDir,
      OPENH3_FFMPEG_PATH: resolveMediaBinary('ffmpeg'),
      OPENH3_FFPROBE_PATH: resolveMediaBinary('ffprobe'),
      AIONUI_FFMPEG_PATH: resolveMediaBinary('ffmpeg'),
      AIONUI_FFPROBE_PATH: resolveMediaBinary('ffprobe'),
      OPENH3_MEDIA_UI_TOKEN: this.uiToken,
      AIONUI_MEDIA_UI_TOKEN: this.uiToken,
      ...(this.options.backendPort ? { OPENH3_MEDIA_BACKEND_PORT: String(this.options.backendPort) } : {}),
      ...(this.options.bundleRoot
        ? { OPENH3_H3_BUNDLE_ROOT: this.options.bundleRoot, AIONUI_H3_BUNDLE_ROOT: this.options.bundleRoot }
        : {}),
    };
    const start = this.options.spawnProcess ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
    try {
      this.child = start(command, [this.options.scriptPath], {
        cwd: this.options.dataDir,
        windowsHide: true,
        env,
        stdio: ['ignore', logHandle, logHandle],
      });
      this.child.once('exit', () => {
        this.child = undefined;
      });
    } finally {
      fs.closeSync(logHandle);
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await this.sleep(250);
      try {
        const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/health`);
        if (response.ok) return;
      } catch {
        /* wait for the child service to bind */
      }
    }
    this.stop();
    throw new Error('MEDIA_SERVICE_START_TIMEOUT');
  }

  /** Refresh Core connectivity after recovery without interrupting media work. */
  async setBackendPort(backendPort: number): Promise<void> {
    if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535)
      throw new Error('MEDIA_SERVICE_BACKEND_PORT_INVALID');
    this.options.backendPort = backendPort;
    if (!this.child) return;
    const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/api/comfy/runtime-context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openh3-ui-token': this.uiToken },
      body: JSON.stringify({ backendPort }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('MEDIA_SERVICE_BACKEND_SYNC_FAILED');
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
