import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { H3ComfyClient } from './H3ComfyClient';
import { MATLOWAI_PORTABLE_RUNTIME_ARCHIVE } from './h3OfflineBundle';
import { H3PortableInstaller, type H3PortableInstallStatus } from './H3PortableInstaller';
import {
  buildH3AccelerationEnv,
  prepareH3Acceleration,
  ensureH3AccelerationLauncher,
  resolveH3Acceleration,
  type H3AccelerationStatus,
} from './h3Acceleration';

export type H3RuntimeManagerOptions = {
  bundleRoot?: string;
  portableRoot?: string;
  modelsDirectory?: string;
  external?: boolean;
  acceleration?: { mode?: 'auto' | 'dense' | 'sla'; root?: string; pythonDevRoot?: string };
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; windowsHide: boolean; stdio: ['ignore', number, number]; env?: NodeJS.ProcessEnv }
  ) => ChildProcess;
};

export type H3RuntimeStartOptions = { allowInstall?: boolean };

export class H3RuntimeManager {
  private process?: ChildProcess;
  private startup?: Promise<unknown>;
  private startupAllowsInstall = false;
  constructor(
    private readonly client: Pick<H3ComfyClient, 'systemStats'> = new H3ComfyClient(),
    private readonly options: H3RuntimeManagerOptions = {}
  ) {}

  setBundleRoot(bundleRoot: string): void {
    this.options.bundleRoot = path.resolve(bundleRoot);
  }

  async ensureStarted(options: H3RuntimeStartOptions = {}): Promise<unknown> {
    try {
      return await this.client.systemStats();
    } catch (error) {
      if (this.options.external) throw error;
    }
    if (this.startup && this.startupAllowsInstall && options.allowInstall === false)
      throw new Error('H3_RUNTIME_INSTALLATION_IN_PROGRESS');
    if (!this.startup) {
      this.startupAllowsInstall = options.allowInstall !== false;
      this.startup = this.startPortable(this.startupAllowsInstall).finally(() => {
        this.startup = undefined;
        this.startupAllowsInstall = false;
      });
    }
    return this.startup;
  }

  private async startPortable(allowInstall: boolean): Promise<unknown> {
    const installer = this.options.portableRoot
      ? undefined
      : new H3PortableInstaller({ bundleRoot: this.options.bundleRoot });
    const existing = !allowInstall ? installer?.status() : undefined;
    const root = this.options.portableRoot ?? (allowInstall ? installer!.ensureInstalled() : existing!.runtimeRoot);
    const modelsDirectory =
      this.options.modelsDirectory ??
      (allowInstall ? installer?.modelsDirectory() : existing?.modelsDirectory) ??
      path.join(root, 'models');
    const python = path.join(root, 'python_embeded', 'python.exe');
    const main = path.join(root, 'ComfyUI', 'main.py');
    if (!fs.existsSync(python) || !fs.existsSync(main)) throw new Error('H3_PORTABLE_RUNTIME_NOT_INSTALLED');
    const selectedAcceleration = this.accelerationStatus();
    if (!allowInstall && selectedAcceleration.mode !== 'dense' && selectedAcceleration.backend !== 'sla')
      throw new Error(`H3_ACCELERATION_DEPENDENCIES_MISSING:${selectedAcceleration.reason}`);
    if (
      allowInstall &&
      !this.options.spawnProcess &&
      this.accelerationStatus().backend !== 'sla' &&
      this.options.acceleration?.mode !== 'dense'
    )
      await prepareH3Acceleration(this.options.bundleRoot ?? this.installStatus().bundleRoot, root);
    const start = this.options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    let logHandle: number;
    try {
      logHandle = fs.openSync(path.join(root, 'comfyui-service.log'), 'a');
    } catch (error) {
      // A previous detached ComfyUI process can retain the stable log file on Windows.
      // Use a fresh file so a stale handle cannot block H3 startup.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
      logHandle = fs.openSync(path.join(root, `comfyui-service-${Date.now()}.log`), 'a');
    }
    try {
      const acceleration = this.accelerationStatus();
      const env = buildH3AccelerationEnv(this.accelerationOptions());
      let args = [
        '-s',
        'ComfyUI/main.py',
        '--windows-standalone-build',
        '--listen',
        '127.0.0.1',
        '--port',
        '8188',
        '--disable-auto-launch',
        '--models-directory',
        modelsDirectory,
      ];
      if (acceleration.backend === 'sla' && acceleration.root) {
        const launcher = ensureH3AccelerationLauncher(
          acceleration.root,
          root,
          this.accelerationOptions().pythonDevRoot
        );
        delete env.PYTHONPATH;
        env.AIONUI_H3_ACCEL_ROOT = acceleration.root;
        env.AIONUI_H3_RUNTIME_ROOT = root;
        if (this.accelerationOptions().pythonDevRoot)
          env.AIONUI_PYTHON_DEV_ROOT = this.accelerationOptions().pythonDevRoot;
        args = [
          launcher,
          '--windows-standalone-build',
          '--listen',
          '127.0.0.1',
          '--port',
          '8188',
          '--disable-auto-launch',
          '--models-directory',
          modelsDirectory,
        ];
      }
      const spawnOptions = {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', logHandle, logHandle] as ['ignore', number, number],
        env,
      };
      this.process = start(python, args, spawnOptions);
    } finally {
      fs.closeSync(logHandle);
    }
    let processError: Error | undefined;
    this.process?.once?.('error', (error) => {
      processError = error;
    });
    this.process?.once?.('exit', () => {
      processError ??= new Error('H3_RUNTIME_EXITED');
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (processError) {
        this.stop();
        throw processError;
      }
      try {
        return await this.client.systemStats();
      } catch {
        /* wait for server */
      }
    }
    this.stop();
    throw new Error('H3_RUNTIME_START_TIMEOUT');
  }

  stop(): void {
    this.process?.kill();
    this.process = undefined;
  }
  installStatus(): H3PortableInstallStatus {
    return new H3PortableInstaller({ bundleRoot: this.options.bundleRoot }).status();
  }
  installReadiness(): ReturnType<H3PortableInstaller['readiness']> {
    return new H3PortableInstaller({ bundleRoot: this.options.bundleRoot }).readiness();
  }
  private accelerationOptions(): NonNullable<H3RuntimeManagerOptions['acceleration']> {
    const configured = this.options.acceleration ?? {};
    const runtimeRoot = this.options.portableRoot ?? this.installStatus().runtimeRoot;
    const pythonRoot = path.join(runtimeRoot, 'python_embeded');
    const bundledRoot = path.join(this.options.bundleRoot ?? this.installStatus().bundleRoot, 'acceleration');
    const sitePackages = path.join(pythonRoot, 'Lib', 'site-packages');
    const root =
      configured.root ||
      process.env.AIONUI_H3_ACCEL_ROOT ||
      (fs.existsSync(path.join(bundledRoot, 'triton')) ||
      fs.existsSync(path.join(bundledRoot, '.h3-acceleration-fallback.json'))
        ? bundledRoot
        : fs.existsSync(path.join(sitePackages, 'triton'))
          ? sitePackages
          : undefined);
    const pythonDevRoot =
      configured.pythonDevRoot ||
      process.env.AIONUI_PYTHON_DEV_ROOT ||
      (root && fs.existsSync(path.join(root, 'include', 'Python.h')) ? root : pythonRoot);
    return { ...configured, root, pythonDevRoot };
  }
  accelerationStatus(): H3AccelerationStatus {
    return resolveH3Acceleration(this.accelerationOptions());
  }
  static archiveManifest() {
    return MATLOWAI_PORTABLE_RUNTIME_ARCHIVE;
  }
}
