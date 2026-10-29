import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';

export type ComfyCleanupReason = 'component-switch' | 'idle' | 'terminal-error' | 'memory-pressure' | 'oom';
export type ComfyRuntimeCoordinatorOptions = {
  directory?: string;
  idleTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

type LockOwner = { pid: number; hostname: string; token: string; startedAt: number; resource?: string };
export type ComfyRuntimeContext = unknown;
export type ComfyRuntimeRunOptions = {
  /** Stable id of the local job. Required to recover an uncertain submission. */
  taskId?: string;
  /** Continue monitoring an already submitted task; never submit a second prompt. */
  recover?: boolean;
  /** Returns true when the remote prompt may still own GPU work after an error. */
  isUncertain?: () => boolean;
  /** Runtime identity used by cleanup (endpoint, pid, profile, etc.). */
  context?: ComfyRuntimeContext;
};
type RuntimeState = {
  resource?: string;
  signature?: string;
  completedAt?: number;
  context?: ComfyRuntimeContext;
  uncertain?: { taskId?: string; context?: ComfyRuntimeContext };
};

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Cross-process, device-scoped serialization and conservative idle cache cleanup. */
export class ComfyRuntimeCoordinator {
  private readonly directory: string;
  private readonly idleTimeoutMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly active = new AsyncLocalStorage<{ resource: string; taskId?: string; held: boolean }>();

  constructor(options: ComfyRuntimeCoordinatorOptions = {}) {
    this.directory = options.directory ?? path.join(os.tmpdir(), 'openh3-comfy-runtime-locks');
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  async run<T>(
    resource: string,
    signature: string,
    task: () => Promise<T>,
    cleanup: (reason: ComfyCleanupReason, context?: ComfyRuntimeContext) => Promise<void>,
    signal?: AbortSignal,
    options: ComfyRuntimeRunOptions = {}
  ): Promise<T> {
    // Services hold the device lease across OOM cleanup and retry; engine calls
    // inside that lease must not attempt to acquire it a second time.
    const lease = this.active.getStore();
    if (lease?.held) {
      if (!this.covers(lease.resource, resource)) throw new Error('COMFY_NESTED_DEVICE_LEASE_MISMATCH');
      return task();
    }
    const key = digest(resource);
    this.cancelIdle(key);
    const release = await this.acquireResource(resource, signal);
    const statePath = path.join(this.directory, `${key}.json`);
    let state = this.readState(statePath);
    const leaseState = { resource, taskId: options.taskId, held: true };
    let ran = false;
    try {
      const previous = this.relatedStates(resource);
      if (
        previous.some(
          ({ state: value }) =>
            value.uncertain && !(options.recover && options.taskId && value.uncertain.taskId === options.taskId)
        )
      )
        throw new Error('COMFY_REMOTE_STATE_UNCONFIRMED');
      if (!options.recover) {
        for (const prior of previous) {
          if (prior.state.signature && prior.state.signature !== signature)
            await cleanup('component-switch', prior.state.context);
        }
      }
      // Persist before entering the task. A dead process lock can be removed,
      // while this durable fence continues to protect remote work after restart.
      state = { resource, signature, context: options.context, uncertain: { taskId: options.taskId } };
      this.writeState(statePath, state);
      ran = true;
      try {
        const result = await this.active.run(leaseState, task);
        state = options.isUncertain?.()
          ? { resource, signature, context: options.context, uncertain: { taskId: leaseState.taskId } }
          : { resource, signature, completedAt: this.now(), context: options.context };
        this.writeState(statePath, state);
        for (const prior of previous) if (prior.filename !== statePath) fs.rmSync(prior.filename, { force: true });
        return result;
      } catch (error) {
        const remoteUncertain = options.isUncertain?.() === true;
        state = remoteUncertain
          ? { resource, signature, context: options.context, uncertain: { taskId: leaseState.taskId } }
          : { resource, signature, completedAt: this.now(), context: options.context };
        this.writeState(statePath, state);
        // Never clear an uncertain runtime: /free or a broad interrupt could
        // affect the still running prompt. Cleanup independently verifies the
        // queue and identity before observing memory release.
        if (!remoteUncertain) {
          try {
            await cleanup('terminal-error', options.context);
            state.signature = undefined;
            this.writeState(statePath, state);
          } catch {
            /* Keep the original generation diagnosis; release was unconfirmed. */
          }
        }
        throw error;
      }
    } finally {
      // Async descendants inherit this object even after AsyncLocalStorage.run
      // returns. A released lease must never authorize later lock-free work.
      leaseState.held = false;
      release();
      if (ran && !state.uncertain) this.armIdle(key, resource, signature, cleanup);
    }
  }

  /** Record the server's accepted id while still holding its original submission lease. */
  adoptTaskId(expected: string, accepted: string): void {
    const lease = this.active.getStore();
    if (!lease?.held || lease.taskId !== expected) return;
    lease.taskId = accepted;
    const filename = path.join(this.directory, `${digest(lease.resource)}.json`);
    const state = this.readState(filename);
    this.writeState(filename, { ...state, uncertain: { taskId: accepted } });
  }

  /** Only call after the existing remote prompt has been confirmed terminal. */
  async confirmSettled(resource: string, taskId: string): Promise<void> {
    const active = this.active.getStore();
    if (active?.held) {
      if (!this.covers(active.resource, resource)) throw new Error('COMFY_NESTED_DEVICE_LEASE_MISMATCH');
      this.markSettled(resource, taskId);
      return;
    }
    const release = await this.acquireResource(resource);
    try {
      this.markSettled(resource, taskId);
    } finally {
      release();
    }
  }

  private markSettled(resource: string, taskId: string): void {
    for (const prior of this.relatedStates(resource)) {
      if (prior.state.uncertain?.taskId !== taskId) continue;
      this.writeState(prior.filename, { ...prior.state, uncertain: undefined, completedAt: this.now() });
    }
  }

  private overlaps(first: string, second: string): boolean {
    if (first === 'machine' || second === 'machine' || first === second) return true;
    if (first.startsWith('gpu:') && second.startsWith('gpu:')) {
      try {
        const left = JSON.parse(first.slice(4)) as string[];
        const right = JSON.parse(second.slice(4)) as string[];
        return left.some((device) => right.includes(device));
      } catch {
        return true;
      }
    }
    return false;
  }

  private covers(held: string, requested: string): boolean {
    if (held === 'machine' || held === requested) return true;
    if (held.startsWith('gpu:') && requested.startsWith('gpu:')) {
      try {
        const devices = JSON.parse(held.slice(4)) as unknown;
        const needed = JSON.parse(requested.slice(4)) as unknown;
        return (
          Array.isArray(devices) &&
          Array.isArray(needed) &&
          needed.length > 0 &&
          needed.every((device) => typeof device === 'string' && devices.includes(device))
        );
      } catch {
        return false;
      }
    }
    return false;
  }

  private relatedStates(resource: string): Array<{ filename: string; state: RuntimeState }> {
    return fs
      .readdirSync(this.directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const filename = path.join(this.directory, file);
        return { filename, state: this.readState(filename) };
      })
      .filter(({ state }) => !state.resource || this.overlaps(state.resource, resource));
  }

  private async acquireResource(resource: string, signal?: AbortSignal): Promise<() => void> {
    const key = digest(resource);
    for (;;) {
      // The admission lock is short lived. Unknown identities exclude every
      // device; known, disjoint GPUs can still work concurrently.
      const leaveAdmission = await this.acquire('admission', signal);
      try {
        let busy = false;
        for (const file of fs.readdirSync(this.directory)) {
          if (!file.endsWith('.lock') || file === 'admission.lock') continue;
          const filename = path.join(this.directory, file);
          this.reapDeadOwner(filename);
          if (!fs.existsSync(filename)) continue;
          try {
            const owner = JSON.parse(fs.readFileSync(filename, 'utf8')) as LockOwner;
            if (!owner.resource || this.overlaps(owner.resource, resource)) busy = true;
          } catch {
            busy = true;
          }
        }
        if (!busy) return await this.acquire(key, signal, resource);
      } finally {
        leaveAdmission();
      }
      await this.pause(100, signal);
    }
  }

  private async acquire(key: string, signal?: AbortSignal, resource?: string): Promise<() => void> {
    fs.mkdirSync(this.directory, { recursive: true });
    const filename = path.join(this.directory, `${key}.lock`);
    const owner: LockOwner = {
      pid: process.pid,
      hostname: os.hostname(),
      token: crypto.randomUUID(),
      startedAt: this.now(),
      resource,
    };
    for (;;) {
      if (signal?.aborted) throw new Error('COMFY_JOB_CANCELLED');
      try {
        const descriptor = fs.openSync(filename, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(owner));
        fs.closeSync(descriptor);
        return () => {
          try {
            const current = JSON.parse(fs.readFileSync(filename, 'utf8')) as LockOwner;
            if (current.token === owner.token && current.pid === owner.pid) fs.rmSync(filename, { force: true });
          } catch {
            /* Never remove a lock whose owner cannot be proven. */
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.reapDeadOwner(filename);
        await this.pause(100, signal);
      }
    }
  }

  private reapDeadOwner(filename: string): void {
    try {
      const owner = JSON.parse(fs.readFileSync(filename, 'utf8')) as LockOwner;
      if (owner.hostname === os.hostname() && Number.isSafeInteger(owner.pid) && !processAlive(owner.pid))
        fs.rmSync(filename, { force: true });
    } catch {
      /* An unreadable lock is a blocking condition, not a reason to risk concurrent GPU work. */
    }
  }

  private readState(filename: string): RuntimeState {
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as RuntimeState;
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { uncertain: {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      return { uncertain: {} };
    }
  }

  private writeState(filename: string, state: RuntimeState): void {
    const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(temporary, filename);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 5)
            throw error;
          // Windows scanners can briefly hold the destination. Keep the committed
          // remote-task fence intact while retrying only the atomic replacement.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
        }
      }
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Preserve the persistence error if temporary cleanup also fails.
      }
    }
  }

  private armIdle(
    key: string,
    resource: string,
    signature: string,
    cleanup: (reason: ComfyCleanupReason, context?: ComfyRuntimeContext) => Promise<void>
  ): void {
    this.cancelIdle(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.acquireResource(resource)
        .then(async (release) => {
          try {
            const statePath = path.join(this.directory, `${key}.json`);
            const state = this.readState(statePath);
            if (
              this.relatedStates(resource).some(({ state: value }) => value.uncertain) ||
              state.signature !== signature ||
              state.completedAt === undefined ||
              this.now() - state.completedAt < this.idleTimeoutMs
            )
              return;
            await cleanup('idle', state.context);
            this.writeState(statePath, { resource, completedAt: this.now(), context: state.context });
          } catch {
            // Queue activity, identity uncertainty, or missing telemetry leaves the cache untouched.
          } finally {
            release();
          }
        })
        .catch((): void => undefined);
    }, this.idleTimeoutMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private cancelIdle(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  private async pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.sleep(milliseconds);
    if (signal.aborted) throw new Error('COMFY_JOB_CANCELLED');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      const abort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(new Error('COMFY_JOB_CANCELLED'));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

export const sharedComfyRuntimeCoordinator = new ComfyRuntimeCoordinator();

export function comfyRuntimeSignature(profile: ComfyProfile): string {
  return JSON.stringify({
    environment: profile.environment,
    components: profile.components,
  });
}

export type ComfyRuntimeBinding =
  | { kind: 'comfy'; profile: ComfyProfile; outputRoot: string }
  | { kind: 'h3'; baseUrl: string; identity?: { executable: string; root: string; pid?: number } };

/** Persisted bindings let the next process clean the previous server, including legacy H3. */
export async function clearBoundComfyRuntime(
  context: unknown,
  reason: ComfyCleanupReason,
  signal: AbortSignal,
  fallback: () => Promise<void>
): Promise<void> {
  const binding = context as ComfyRuntimeBinding | undefined;
  if (binding?.kind === 'comfy') {
    const { ComfyWorkflowEngine } = await import('./workflowEngine');
    await new ComfyWorkflowEngine({ outputRoot: binding.outputRoot }).clearMemory(binding.profile, reason, signal);
  } else if (binding?.kind === 'h3') {
    if (!binding.identity) throw new Error('H3_MEMORY_CLEAR_IDENTITY_UNAVAILABLE');
    const { H3ComfyClient } = await import('../../runtime/H3ComfyClient');
    await new H3ComfyClient({ baseUrl: binding.baseUrl }).clearMemory(binding.identity);
  } else await fallback();
}

export function comfyRuntimeResourceKey(_baseUrl: string, stats: Record<string, unknown>): string {
  const devices = Array.isArray(stats.devices)
    ? stats.devices.map((entry) => {
        const device = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
        const identity = device.uuid ?? device.gpu_uuid ?? device.pci_bus_id;
        return typeof identity === 'string' && identity.length > 0 ? identity.toLowerCase() : undefined;
      })
    : [];
  // CUDA indices and display names can change with CUDA_VISIBLE_DEVICES. Without
  // physical UUID/bus identity, a machine lease is the only safe cross-process key.
  return devices.length && devices.every((identity) => identity !== undefined)
    ? `gpu:${JSON.stringify([...new Set(devices)].toSorted())}`
    : 'machine';
}
