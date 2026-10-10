import { createH3Job, type H3GenerationSpec, type H3Job } from '@/common/chat/document/h3Job';
import { H3ComfyClient, type H3GenerationResult, type H3Progress } from './H3ComfyClient';
import type { H3JobStore } from './H3JobStore';
import { H3ReferencePreflight } from './H3ReferencePreflight';
import { H3ComfyError } from './h3ComfyError';

type H3ReferencePreflightLike = { validate(references: H3Job['spec']['references']): Promise<void> };
type RunnerClient = Pick<H3ComfyClient, 'generate' | 'cancel' | 'resume'> &
  Partial<Pick<H3ComfyClient, 'confirmStopped' | 'confirmIdle'>>;

export class H3JobRunner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancellations = new Map<string, Promise<H3GenerationResult | void>>();
  constructor(
    private readonly store: H3JobStore,
    private readonly client: RunnerClient = new H3ComfyClient(),
    private readonly preflight: H3ReferencePreflightLike = new H3ReferencePreflight()
  ) {}

  blocked(): boolean {
    return this.store.listBlocked().length > 0;
  }

  async enqueue(spec: H3GenerationSpec): Promise<H3Job> {
    if (this.blocked()) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
    const job = createH3Job(spec);
    await this.preflight.validate(job.spec.references);
    if (this.blocked()) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
    return this.store.create(job);
  }

  private succeed(id: string, result: H3GenerationResult): H3Job {
    return this.store.update(id, {
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
    if (!['queued', 'running'].includes(current.status)) throw new Error(`H3_JOB_NOT_RUNNABLE:${current.status}`);
    if (this.blocked()) throw new Error('H3_REMOTE_STATE_UNCONFIRMED');
    if (this.controllers.size) throw new Error('H3_JOB_ALREADY_RUNNING');
    const controller = new AbortController();
    this.controllers.set(id, controller);
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
        job = this.store.update(id, { promptId, submissionPending: pending });
        onProgress?.(job);
      };
      const context = { startedAt: job.startedAt, activity: job.activity };
      const result = current.promptId
        ? await this.client.resume(current.promptId, controller.signal, progressChanged, undefined, context)
        : await this.client.generate(current.spec, controller.signal, progressChanged, submitted, context);
      if (this.store.get(id)?.status === 'cancelled') return this.store.get(id)!;
      job = this.succeed(id, result);
      onProgress?.(job);
      return job;
    } catch (error) {
      const latest = this.store.get(id)!;
      if (['cancelled', 'succeeded'].includes(latest.status)) return latest;
      const message = error instanceof Error ? error.message : String(error);
      // Persist the barrier BEFORE awaiting remote cleanup. A crash cannot release it.
      let job = this.store.update(id, {
        status: message === 'H3_JOB_CANCELLED' ? 'cancelled' : 'failed',
        error: message,
        remoteUncertain: !!latest.promptId && !message.startsWith('H3_COMFY_PROMPT_REJECTED:'),
        finishedAt: new Date().toISOString(),
        cancelRequested: false,
        diagnosis: error instanceof H3ComfyError ? error.diagnosis : undefined,
      });
      onProgress?.(job);
      if (job.remoteUncertain) {
        try {
          const result = await this.stopRemote(job);
          job = result
            ? this.succeed(id, result)
            : this.store.update(id, { remoteUncertain: false, submissionPending: false });
        } catch {
          /* Keep the persisted barrier until the remote state is confirmed. */
        }
        onProgress?.(job);
      }
      if (job.status === 'succeeded') return job;
      throw error;
    } finally {
      this.controllers.delete(id);
    }
  }

  async cancel(id: string): Promise<H3Job> {
    const job = this.store.get(id);
    if (!job) throw new Error('H3_JOB_NOT_FOUND');
    if (!job.remoteUncertain && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    if (job.status === 'running' && !job.promptId) {
      this.controllers.get(id)?.abort();
      return this.store.update(id, { cancelRequested: true });
    }
    this.store.update(id, { cancelRequested: true });
    try {
      const result = job.promptId || job.remoteUncertain ? await this.stopRemote(job) : undefined;
      const latest = this.store.get(id)!;
      if (latest.status === 'succeeded') return latest;
      const settled = result
        ? this.succeed(id, result)
        : this.store.update(id, {
            status: job.status === 'failed' ? 'failed' : 'cancelled',
            error: job.status === 'failed' ? job.error : 'H3_JOB_CANCELLED',
            remoteUncertain: false,
            submissionPending: false,
            cancelRequested: false,
            finishedAt: new Date().toISOString(),
          });
      this.controllers.get(id)?.abort();
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
          ? this.succeed(job.id, result)
          : this.store.update(job.id, { remoteUncertain: false, submissionPending: false });
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
