import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { H3RuntimeManager } from '@/process/services/runtime/H3RuntimeManager';
import { H3PortableInstaller } from '@/process/services/runtime/H3PortableInstaller';
import * as acceleration from '@/process/services/runtime/h3Acceleration';

afterEach(() => vi.restoreAllMocks());

describe('H3 runtime manager', () => {
  it('starts an existing portable runtime without installing or preparing models and acceleration', async () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-no-install-'));
    const portableRoot = path.join(bundleRoot, 'runtime', 'ComfyUI_windows_portable');
    fs.mkdirSync(path.join(portableRoot, 'python_embeded'), { recursive: true });
    fs.mkdirSync(path.join(portableRoot, 'ComfyUI'));
    fs.writeFileSync(path.join(portableRoot, 'python_embeded', 'python.exe'), 'fixture');
    fs.writeFileSync(path.join(portableRoot, 'ComfyUI', 'main.py'), 'fixture');
    const install = vi.spyOn(H3PortableInstaller.prototype, 'ensureInstalled').mockImplementation(() => {
      throw new Error('unexpected installation');
    });
    const models = vi.spyOn(H3PortableInstaller.prototype, 'modelsDirectory').mockImplementation(() => {
      throw new Error('unexpected model preparation');
    });
    const prepare = vi.spyOn(acceleration, 'prepareH3Acceleration').mockRejectedValue(new Error('unexpected pip'));
    let started = false;
    const spawnProcess = vi.fn(() => {
      started = true;
      return { kill: vi.fn() } as never;
    });
    const manager = new H3RuntimeManager(
      {
        systemStats: async () => {
          if (!started) throw new Error('offline');
          return { ok: true };
        },
      },
      { bundleRoot, acceleration: { mode: 'dense' }, spawnProcess }
    );
    try {
      await expect(manager.ensureStarted({ allowInstall: false })).resolves.toEqual({ ok: true });
      expect(install).not.toHaveBeenCalled();
      expect(models).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(spawnProcess).toHaveBeenCalledWith(
        path.join(portableRoot, 'python_embeded', 'python.exe'),
        expect.arrayContaining(['--models-directory', path.join(bundleRoot, 'models')]),
        expect.anything()
      );
    } finally {
      manager.stop();
      fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
  });

  it.each(['auto', 'sla'] as const)(
    'rejects missing acceleration in existing-only %s mode without starting dense',
    async (mode) => {
      const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-no-install-sla-'));
      fs.mkdirSync(path.join(portableRoot, 'python_embeded'), { recursive: true });
      fs.mkdirSync(path.join(portableRoot, 'ComfyUI'));
      fs.writeFileSync(path.join(portableRoot, 'python_embeded', 'python.exe'), 'fixture');
      fs.writeFileSync(path.join(portableRoot, 'ComfyUI', 'main.py'), 'fixture');
      const spawnProcess = vi.fn(() => {
        const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
        queueMicrotask(() => child.emit('error', new Error('unexpected dense launch')));
        return child as never;
      });
      const prepare = vi.spyOn(acceleration, 'prepareH3Acceleration').mockRejectedValue(new Error('unexpected pip'));
      const manager = new H3RuntimeManager(
        {
          systemStats: async () => {
            throw new Error('offline');
          },
        },
        { portableRoot, acceleration: { mode, root: path.join(portableRoot, 'missing-accel') }, spawnProcess }
      );
      try {
        await expect(manager.ensureStarted({ allowInstall: false })).rejects.toThrow(
          'H3_ACCELERATION_DEPENDENCIES_MISSING:TRITON_NOT_FOUND'
        );
        expect(spawnProcess).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(portableRoot, 'comfyui-service.log'))).toBe(false);
      } finally {
        fs.rmSync(portableRoot, { recursive: true, force: true });
      }
    }
  );

  it('rejects a missing existing runtime without extracting the bundled archive', async () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-no-extract-'));
    const install = vi.spyOn(H3PortableInstaller.prototype, 'ensureInstalled').mockImplementation(() => {
      throw new Error('unexpected extraction');
    });
    const manager = new H3RuntimeManager(
      {
        systemStats: async () => {
          throw new Error('offline');
        },
      },
      { bundleRoot }
    );
    try {
      await expect(manager.ensureStarted({ allowInstall: false })).rejects.toThrow('H3_PORTABLE_RUNTIME_NOT_INSTALLED');
      expect(install).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
  });

  it('does not join an installing startup from an existing-only request', async () => {
    const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-install-in-flight-'));
    fs.mkdirSync(path.join(portableRoot, 'python_embeded'), { recursive: true });
    fs.mkdirSync(path.join(portableRoot, 'ComfyUI'));
    fs.writeFileSync(path.join(portableRoot, 'python_embeded', 'python.exe'), 'fixture');
    fs.writeFileSync(path.join(portableRoot, 'ComfyUI', 'main.py'), 'fixture');
    let started: () => void = () => undefined;
    let rejectPreparation: (error: Error) => void = () => undefined;
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(acceleration, 'prepareH3Acceleration').mockImplementation(() => {
      started();
      return new Promise((_resolve, reject) => {
        rejectPreparation = reject;
      });
    });
    const manager = new H3RuntimeManager(
      {
        systemStats: async () => {
          throw new Error('offline');
        },
      },
      { portableRoot, acceleration: { mode: 'auto', root: path.join(portableRoot, 'missing-accel') } }
    );
    try {
      const installing = manager.ensureStarted();
      await preparing;
      const selected = expect(manager.ensureStarted({ allowInstall: false })).rejects.toThrow(
        'H3_RUNTIME_INSTALLATION_IN_PROGRESS'
      );
      rejectPreparation(new Error('PREPARATION_STOPPED'));
      await Promise.all([expect(installing).rejects.toThrow('PREPARATION_STOPPED'), selected]);
    } finally {
      fs.rmSync(portableRoot, { recursive: true, force: true });
    }
  });

  it('uses installed SLA dependencies in existing-only mode without preparing acceleration', async () => {
    const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-existing-sla-'));
    const accelerationRoot = path.join(portableRoot, 'acceleration');
    fs.mkdirSync(path.join(portableRoot, 'python_embeded'), { recursive: true });
    fs.mkdirSync(path.join(portableRoot, 'ComfyUI'));
    fs.writeFileSync(path.join(portableRoot, 'python_embeded', 'python.exe'), 'fixture');
    fs.writeFileSync(path.join(portableRoot, 'ComfyUI', 'main.py'), 'fixture');
    fs.mkdirSync(path.join(accelerationRoot, 'triton'), { recursive: true });
    fs.mkdirSync(path.join(accelerationRoot, 'include'));
    fs.writeFileSync(path.join(accelerationRoot, 'include', 'Python.h'), 'fixture');
    const prepare = vi.spyOn(acceleration, 'prepareH3Acceleration').mockRejectedValue(new Error('unexpected pip'));
    let started = false;
    const spawnProcess = vi.fn(() => {
      started = true;
      return { kill: vi.fn() } as never;
    });
    const manager = new H3RuntimeManager(
      {
        systemStats: async () => {
          if (!started) throw new Error('offline');
          return { ok: true };
        },
      },
      {
        portableRoot,
        acceleration: { mode: 'sla', root: accelerationRoot, pythonDevRoot: accelerationRoot },
        spawnProcess,
      }
    );
    try {
      await expect(manager.ensureStarted({ allowInstall: false })).resolves.toEqual({ ok: true });
      expect(prepare).not.toHaveBeenCalled();
      expect(spawnProcess).toHaveBeenCalledWith(
        path.join(portableRoot, 'python_embeded', 'python.exe'),
        expect.arrayContaining([path.join(accelerationRoot, 'aionui_h3_accel_launcher.py')]),
        expect.objectContaining({
          env: expect.objectContaining({
            AIONUI_H3_RUNTIME_ROOT: portableRoot,
            AIONUI_H3_ACCEL_ROOT: accelerationRoot,
          }),
        })
      );
    } finally {
      manager.stop();
      fs.rmSync(portableRoot, { recursive: true, force: true });
    }
  });

  it('preserves installation and model preparation for ordinary legacy startup', async () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-default-install-'));
    const portableRoot = path.join(bundleRoot, 'existing');
    fs.mkdirSync(path.join(portableRoot, 'python_embeded'), { recursive: true });
    fs.mkdirSync(path.join(portableRoot, 'ComfyUI'));
    fs.writeFileSync(path.join(portableRoot, 'python_embeded', 'python.exe'), 'fixture');
    fs.writeFileSync(path.join(portableRoot, 'ComfyUI', 'main.py'), 'fixture');
    const install = vi.spyOn(H3PortableInstaller.prototype, 'ensureInstalled').mockReturnValue(portableRoot);
    const models = vi
      .spyOn(H3PortableInstaller.prototype, 'modelsDirectory')
      .mockReturnValue(path.join(bundleRoot, 'models'));
    let started = false;
    const manager = new H3RuntimeManager(
      {
        systemStats: async () => {
          if (!started) throw new Error('offline');
          return { ok: true };
        },
      },
      {
        bundleRoot,
        acceleration: { mode: 'dense' },
        spawnProcess: () => {
          started = true;
          return { kill: vi.fn() } as never;
        },
      }
    );
    try {
      await expect(manager.ensureStarted()).resolves.toEqual({ ok: true });
      expect(install).toHaveBeenCalledOnce();
      expect(models).toHaveBeenCalledOnce();
    } finally {
      manager.stop();
      fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
  });

  it('reports child launch errors and releases the startup lock for retry', async () => {
    const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-start-error-'));
    fs.mkdirSync(path.join(portableRoot, 'python_embeded'), { recursive: true });
    fs.mkdirSync(path.join(portableRoot, 'ComfyUI'));
    fs.writeFileSync(path.join(portableRoot, 'python_embeded', 'python.exe'), 'fixture');
    fs.writeFileSync(path.join(portableRoot, 'ComfyUI', 'main.py'), 'fixture');
    let spawns = 0;
    let kills = 0;
    const manager = new H3RuntimeManager(
      {
        systemStats: async () => {
          throw new Error('offline');
        },
      },
      {
        portableRoot,
        spawnProcess: () => {
          spawns++;
          const child = Object.assign(new EventEmitter(), {
            kill: () => {
              kills++;
              return true;
            },
          });
          queueMicrotask(() => child.emit('error', new Error('SPAWN_FAILED')));
          return child as never;
        },
      }
    );
    try {
      await expect(manager.ensureStarted()).rejects.toThrow('SPAWN_FAILED');
      await expect(manager.ensureStarted()).rejects.toThrow('SPAWN_FAILED');
      expect(spawns).toBe(2);
      expect(kills).toBe(2);
    } finally {
      fs.rmSync(portableRoot, { recursive: true, force: true });
    }
  });
  it('uses an already-running ComfyUI endpoint without spawning another process', async () => {
    let calls = 0;
    const manager = new H3RuntimeManager(
      {
        systemStats: async () => {
          calls += 1;
          return { ok: true };
        },
      },
      {
        portableRoot: 'missing-runtime',
        spawnProcess: () => {
          throw new Error('must not spawn');
        },
      }
    );
    await expect(manager.ensureStarted()).resolves.toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it('passes an external offline bundle root to the installer status', () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-bundle-root-'));
    const manager = new H3RuntimeManager({ systemStats: async () => ({ ok: true }) }, { bundleRoot });
    expect(manager.installStatus().bundleRoot).toBe(path.resolve(bundleRoot));
  });

  it('serializes concurrent startup attempts to one portable process', async () => {
    const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-runtime-manager-'));
    fs.mkdirSync(path.join(portableRoot, 'python_embeded'), { recursive: true });
    fs.mkdirSync(path.join(portableRoot, 'ComfyUI'), { recursive: true });
    fs.writeFileSync(path.join(portableRoot, 'python_embeded', 'python.exe'), 'python');
    fs.writeFileSync(path.join(portableRoot, 'ComfyUI', 'main.py'), 'main');
    let started = false;
    let spawns = 0;
    let spawnOptions: { cwd: string; windowsHide: boolean; stdio: ['ignore', number, number] } | undefined;
    const manager = new H3RuntimeManager(
      {
        systemStats: async () => {
          if (!started) throw new Error('offline');
          return { ok: true };
        },
      },
      {
        portableRoot,
        modelsDirectory: portableRoot,
        spawnProcess: (_command, _args, options) => {
          spawns += 1;
          spawnOptions = options;
          started = true;
          return {} as never;
        },
      }
    );
    const [first, second] = await Promise.all([manager.ensureStarted(), manager.ensureStarted()]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(spawns).toBe(1);
    expect(spawnOptions?.stdio[0]).toBe('ignore');
    expect(typeof spawnOptions?.stdio[1]).toBe('number');
    expect(spawnOptions?.stdio[1]).toBe(spawnOptions?.stdio[2]);
    expect(fs.existsSync(path.join(portableRoot, 'comfyui-service.log'))).toBe(true);
  });
});

it('discovers portable acceleration without machine-specific environment variables', () => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-auto-discover-'));
  try {
    const portableRoot = path.join(bundleRoot, 'runtime');
    const python = path.join(portableRoot, 'python_embeded');
    fs.mkdirSync(path.join(python, 'Lib', 'site-packages', 'triton'), { recursive: true });
    fs.mkdirSync(path.join(python, 'include'), { recursive: true });
    fs.writeFileSync(path.join(python, 'include', 'Python.h'), 'fixture');
    const manager = new H3RuntimeManager({ systemStats: async () => ({}) }, { bundleRoot, portableRoot });
    expect(manager.accelerationStatus()).toMatchObject({ mode: 'auto', backend: 'sla', available: true });
    fs.rmSync(path.join(python, 'include', 'Python.h'));
    expect(manager.accelerationStatus()).toMatchObject({ backend: 'dense', reason: 'PYTHON_DEV_FILES_NOT_FOUND' });
  } finally {
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  }
});
