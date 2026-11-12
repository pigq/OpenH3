import { createH3Job, type H3GenerationSpec, type H3Job } from '@/common/chat/document/h3Job';
import { H3ComfyClient, type H3GenerationResult, type H3Progress } from './H3ComfyClient';
import type { H3JobStore } from './H3JobStore';
import { H3ReferencePreflight } from './H3ReferencePreflight';
import { H3ComfyError } from './h3ComfyError';
import {
  sharedComfyRuntimeCoordinator,
  clearBoundComfyRuntime,
  type ComfyCleanupReason,
  type ComfyRuntimeCoordinator,
} from '../media/comfy/runtimeCoordinator';

type H3ReferencePreflightLike = { validate(references: H3Job['spec']['references']): Promise<void> };
type RunnerClient = Pick<H3ComfyClient, 'generate' | 'cancel' | 'resume'> &
  Partial<
    Pick<
      H3ComfyClient,
      | 'confirmStopped'
      | 'confirmIdle'
      | 'runtimeResourceKey'
      | 'clearMemory'
      | 'getBaseUrl'
      | 'runtimeBinding'
      | 'runtimeSignature'
      | 'memorySnapshot'
    >
  >;

export class H3JobRunner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly runCompletions = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private readonly cancellations = new Map<string, Promise<H3GenerationResult | void>>();
  constructor(
    private readonly store: H3JobStore,
    private readonly client: RunnerClient = new H3ComfyClient(),
    private readonly preflight: H3ReferencePreflightLike = new H3ReferencePreflight(),
    private readonly coordinator: ComfyRuntimeCoordinator = sharedComfyRuntimeCoordinator,
    private readonly archive?: (id: string, result: H3GenerationResult) => Promise<void>
  ) {}

  blocked(): boolean {
    return this.store.listBlocked().length > 0;
  }

  async enqueue(spec: H3GenerationSpec, id?: string): Promise<H3Job> {
    const existing = id ? this.store.get(id) : undefined;
    if (existing) return existing;
    if (this.blocked()) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
    const job = createH3Job(spec, id);
    await this.preflight.validate(job.spec.references);
    if (this.blocked()) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
    if (id && this.store.get(id)) return this.store.get(id)!;
    return this.store.create(job);
  }

  private async succeed(id: string, result: H3GenerationResult): Promise<H3Job> {
    const job = this.store.update(id, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      progress: 1,
      remoteUncertain: false,
      submissionPending: false,
      cancelRequested: false,
      error: undefined,
      diagnosis: undefined,
      promptId: result.promptId,
      artifacts: result.artifacts.map((artifact, index) => ({
        ...artifact,
        resourcePath: `/api/h3/jobs/${encodeURIComponent(id)}/artifacts/${index}`,
      })),
    });
    try {
      await this.archive?.(id, result);
    } catch (error) {
      // Generation has completed. A persistence error must never resubmit it.
      console.warn('[h3] artifact archive pending', {
        jobId: id,
        error: error instanceof Error ? error.name : 'Error',
      });
    }
    return job;
  }

  private stopRemote(job: H3Job): Promise<H3GenerationResult | void> {
    const pending = this.cancellations.get(job.id);
    if (pending) return pending;
    const task = Promise.resolve()
      .then(async () => {
        if (job.promptId)
          return job.submissionPending ? this.client.cancel(job.promptId, true) : this.client.cancel(job.promptId);
        if (!this.client.confirmIdle) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
        await this.client.confirmIdle();
      })
      .finally(() => this.cancellations.delete(job.id));
    this.cancellations.set(job.id, task);
    return task;
  }

  async run(id: string, onProgress?: (job: H3Job) => void): Promise<H3Job> {
    const current = this.store.get(id);
    if (!current) throw new Error('H3_JOB_NOT_FOUND');
    if (this.controllers.has(id)) throw new Error('H3_JOB_ALREADY_RUNNING');
    if (current.status === 'succeeded') return current;
    if (!['queued', 'running'].includes(current.status) && !(current.remoteUncertain && current.promptId))
      throw new Error(`H3_JOB_NOT_RUNNABLE:${current.status}`);
    if (this.store.listBlocked().some((job) => job.id !== id)) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
    if (this.controllers.size) throw new Error('H3_JOB_ALREADY_RUNNING');
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let resolveRun!: () => void;
    const completion = new Promise<void>((resolve) => (resolveRun = resolve));
    this.runCompletions.set(id, { promise: completion, resolve: resolveRun });
    try {
      let job = this.store.update(id, {
        status: 'running',
        progress: 0,
        activity: current.activity ?? { phase: 'waiting', updatedAt: new Date().toISOString() },
        startedAt: current.startedAt ?? new Date().toISOString(),
      });
      onProgress?.(job);
      const progressChanged: H3Progress = (progress, activity, monitor) => {
        if (this.store.get(id)?.status !== 'running') return;
        job = this.store.update(id, {
          progress: Math.max(0, Math.min(1, progress)),
          ...(activity ? { activity } : {}),
          ...(monitor ? { monitor } : {}),
        });
        onProgress?.(job);
      };
      const submitted = (promptId: string, pending = false): void => {
        job = this.store.update(id, { promptId, submissionPending: pending, remoteUncertain: false });
        onProgress?.(job);
      };
      const context = { startedAt: job.startedAt, activity: job.activity };
      const coordinated = Boolean(this.client.runtimeResourceKey && this.client.clearMemory);
      const resource = coordinated ? await this.client.runtimeResourceKey!() : '';
      const binding = this.client.runtimeBinding ? await this.client.runtimeBinding() : undefined;
      const signature =
        this.client.runtimeSignature?.() ?? JSON.stringify({ baseUrl: this.client.getBaseUrl?.(), family: 'h3' });
      const cleanup = async (reason: ComfyCleanupReason, previous?: unknown): Promise<void> => {
        let confirmed = false;
        let failure: string | undefined;
        try {
          const prior = previous as typeof binding;
          if (!previous || (prior?.kind === 'h3' && prior.baseUrl === binding?.baseUrl)) {
            if (binding && !binding.identity) throw new Error('H3_MEMORY_CLEAR_IDENTITY_UNAVAILABLE');
            await this.client.clearMemory!(prior?.identity ?? binding?.identity);
          } else
            await clearBoundComfyRuntime(previous, reason, new AbortController().signal, () =>
              this.client.clearMemory!(binding?.identity)
            );
          confirmed = true;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          const memory = this.store.get(id)?.memory;
          this.store.update(id, {
            memory: {
              ...memory,
              cleanups: [
                ...(memory?.cleanups ?? []),
                { at: new Date().toISOString(), reason, confirmed, error: failure },
              ].slice(-20),
            },
          });
        }
      };
      const runRemote = <T>(task: () => Promise<T>): Promise<T> =>
        coordinated
          ? this.coordinator.run(resource, signature, task, cleanup, controller.signal, {
              taskId: id,
              recover: Boolean(current.promptId),
              isUncertain: () => {
                const value = this.store.get(id);
                return Boolean(value?.submissionPending || value?.remoteUncertain);
              },
              context: binding,
            })
          : task();
      const result = await runRemote(async () => {
        const before = await this.client.memorySnapshot?.().catch((): undefined => undefined);
        this.store.update(id, { memory: { ...this.store.get(id)?.memory, components: signature, before } });
        try {
          if (
            !current.promptId &&
            before?.some(
              (device) =>
                typeof device.free === 'number' &&
                typeof device.total === 'number' &&
                device.free < Math.max(512 * 1024 * 1024, device.total * 0.05) &&
                typeof device.torchTotal === 'number' &&
                typeof device.torchFree === 'number' &&
                device.torchTotal > device.torchFree
            )
          )
            await cleanup('memory-pressure', binding);
          let result;
          try {
            result = current.promptId
              ? await this.client.resume(current.promptId, controller.signal, progressChanged, undefined, context)
              : await this.client.generate(current.spec, controller.signal, progressChanged, submitted, context);
          } catch (error) {
            const latest = this.store.get(id)!;
            if (
              !(error instanceof H3ComfyError) ||
              error.diagnosis.category !== 'OOM' ||
              controller.signal.aborted ||
              (latest.oomRetryCount ?? 0) >= 1 ||
              !this.client.clearMemory
            )
              throw error;
            this.store.update(id, {
              oomRetryCount: (latest.oomRetryCount ?? 0) + 1,
              promptId: undefined,
              submissionPending: false,
              remoteUncertain: false,
              diagnosis: error.diagnosis,
            });
            try {
              await cleanup('oom', binding);
            } catch (cause) {
              throw Object.assign(new H3ComfyError('H3_MEMORY_CLEAR_UNCONFIRMED', error.diagnosis), { cause });
            }
            result = await this.client.generate(current.spec, controller.signal, progressChanged, submitted, context);
          }
          this.store.update(id, { remoteUncertain: false, submissionPending: false });
          return result;
        } catch (error) {
          const latest = this.store.get(id)!;
          const uncertain = !(error instanceof H3ComfyError) && Boolean(latest.promptId || latest.submissionPending);
          this.store.update(id, {
            remoteUncertain: latest.status === 'cancelled' ? false : uncertain,
            submissionPending: error instanceof H3ComfyError ? false : latest.submissionPending,
            memory: {
              ...latest.memory,
              failedNode: error instanceof H3ComfyError ? error.diagnosis.nodeId : undefined,
            },
          });
          throw error;
        } finally {
          const after = await this.client.memorySnapshot?.().catch((): undefined => undefined);
          this.store.update(id, { memory: { ...this.store.get(id)?.memory, after } });
        }
      });
      if (this.store.get(id)?.status === 'cancelled') return this.store.get(id)!;
      job = await this.succeed(id, result);
      onProgress?.(job);
      return job;
    } catch (error) {
      const latest = this.store.get(id)!;
      if (['cancelled', 'succeeded'].includes(latest.status)) return latest;
      const message = error instanceof Error ? error.message : String(error);
      const wasCancelled = message === 'H3_JOB_CANCELLED' || (controller.signal.aborted && latest.cancelRequested);
      // Persist the barrier BEFORE awaiting remote cleanup. A crash cannot release it.
      let job = this.store.update(id, {
        status: wasCancelled ? 'cancelled' : 'failed',
        error: wasCancelled ? 'H3_JOB_CANCELLED' : message,
        remoteUncertain: Boolean(latest.remoteUncertain || (latest.promptId && !(error instanceof H3ComfyError))),
        finishedAt: new Date().toISOString(),
        cancelRequested: false,
        diagnosis: error instanceof H3ComfyError ? error.diagnosis : undefined,
      });
      onProgress?.(job);
      if (job.remoteUncertain && wasCancelled) {
        try {
          const result = await this.stopRemote(job);
          job = result
            ? await this.succeed(id, result)
            : this.store.update(id, { remoteUncertain: false, submissionPending: false });
          if (this.client.runtimeResourceKey)
            await this.coordinator.confirmSettled(await this.client.runtimeResourceKey(), id);
        } catch {
          /* Keep the persisted barrier until the remote state is confirmed. */
        }
        onProgress?.(job);
      }
      if (job.status === 'succeeded') return job;
      throw error;
    } finally {
      this.controllers.delete(id);
      this.runCompletions.get(id)?.resolve();
      this.runCompletions.delete(id);
    }
  }

  async cancel(id: string): Promise<H3Job> {
    let job = this.store.get(id);
    if (!job) throw new Error('H3_JOB_NOT_FOUND');
    if (!job.remoteUncertain && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    if (job.status === 'running' && !job.promptId) {
      const running = this.runCompletions.get(id);
      if (running) {
        this.store.update(id, { cancelRequested: true });
        this.controllers.get(id)?.abort();
        await running.promise;
        job = this.store.get(id)!;
        if (!job.remoteUncertain && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
        if (job.remoteUncertain) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
      }
      if (!this.client.confirmIdle) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
      await this.client.confirmIdle();
      if (this.client.runtimeResourceKey)
        await this.coordinator.confirmSettled(await this.client.runtimeResourceKey(), id);
      this.controllers.get(id)?.abort();
      return this.store.update(id, {
        status: 'cancelled',
        error: 'H3_JOB_CANCELLED',
        remoteUncertain: false,
        submissionPending: false,
        cancelRequested: false,
        finishedAt: new Date().toISOString(),
      });
    }
    this.store.update(id, { cancelRequested: true });
    try {
      const result = job.promptId || job.remoteUncertain ? await this.stopRemote(job) : undefined;
      const latest = this.store.get(id)!;
      if (latest.status === 'succeeded') return latest;
      const settled = result
        ? await this.succeed(id, result)
        : this.store.update(id, {
            status: job.status === 'failed' ? 'failed' : 'cancelled',
            error: job.status === 'failed' ? job.error : 'H3_JOB_CANCELLED',
            remoteUncertain: false,
            submissionPending: false,
            cancelRequested: false,
            finishedAt: new Date().toISOString(),
          });
      this.controllers.get(id)?.abort();
      if (this.client.runtimeResourceKey)
        await this.coordinator.confirmSettled(await this.client.runtimeResourceKey(), id);
      return settled;
    } catch (error) {
      if (this.store.get(id)?.status !== 'succeeded') this.store.update(id, { cancelRequested: false });
      throw error;
    }
  }

  /** Read-only background reconciliation never resubmits or repeatedly cancels GPU work. */
  async reconcile(onProgress?: (job: H3Job) => void): Promise<void> {
    for (const job of this.store.listBlocked()) {
      if (this.controllers.has(job.id) || this.cancellations.has(job.id)) continue;
      try {
        if (!job.promptId || !this.client.confirmStopped) continue;
        const result = await this.client.confirmStopped(job.promptId, job.submissionPending);
        const settled = result
          ? await this.succeed(job.id, result)
          : this.store.update(job.id, { remoteUncertain: false, submissionPending: false });
        if (this.client.runtimeResourceKey)
          await this.coordinator.confirmSettled(await this.client.runtimeResourceKey(), job.id);
        onProgress?.(settled);
      } catch {
        /* Runtime offline or target still queued/running: retain the barrier. */
      }
    }
  }

  recover(): H3Job[] {
    return this.store.listActive().map((job) => {
      if (job.status !== 'running') return job;
      if (job.cancelRequested || job.submissionPending)
        return this.store.update(job.id, {
          status: 'failed',
          error: 'H3_CANCEL_STATE_UNCONFIRMED',
          remoteUncertain: true,
          cancelRequested: false,
          finishedAt: new Date().toISOString(),
        });
      if (!job.promptId)
        return this.store.update(job.id, {
          status: 'failed',
          error: 'H3_SUBMISSION_STATE_UNKNOWN',
          remoteUncertain: true,
          finishedAt: new Date().toISOString(),
        });
      return this.store.update(job.id, { status: 'queued' });
    });
  }
}
