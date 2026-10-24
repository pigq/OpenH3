import fs from 'node:fs';
import path from 'node:path';
import { h3GenerationSpecSchema, type H3GenerationSpec, type H3Job } from '@/common/chat/document/h3Job';
import type { H3SetupState } from '@/common/chat/document/creation/h3Setup';
import type { CreationInstallConsent, CreationOperation } from '@/common/chat/document/creation/operation';

type Ports = {
  setup: () => H3SetupState;
  install: (consent: CreationInstallConsent) => Promise<void>;
  installed: () => boolean;
  enqueue: (spec: H3GenerationSpec, id: string) => Promise<string>;
  getJob: (id: string) => Pick<H3Job, 'status' | 'remoteUncertain' | 'cancelRequested'> | undefined;
  cancelJob: (id: string) => Promise<unknown>;
};

/** Persist the LLM's generation request while the user authorizes the existing installer. */
export class CreationOperations {
  private operations = new Map<string, CreationOperation>();
  private requests = new Map<string, { conversationId: string; cancelled: boolean }>();
  private pumping = false;
  private starting = new Set<string>();
  private submitting = new Set<string>();
  private cancelling = new Set<string>();
  constructor(
    private filename: string,
    private ports: Ports
  ) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename)) {
      try {
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8')) as {
          operations: CreationOperation[];
          requests: Array<[string, { conversationId: string; cancelled: boolean }]>;
        };
        this.requests = new Map(saved.requests);
        for (const operation of saved.operations) {
          h3GenerationSpecSchema.parse(operation.spec);
          const jobId = operation.jobId ?? operation.id;
          const job = this.ports.getJob(jobId);
          const cancelled =
            this.requests.get(operation.requestId)?.cancelled || ['cancelled', 'cancelling'].includes(operation.state);
          const recovered: CreationOperation = cancelled
            ? {
                ...operation,
                state: job && !this.jobSettled(job) ? 'cancelling' : 'cancelled',
                ...(job ? { jobId } : {}),
              }
            : job
              ? { ...operation, state: 'submitted', jobId }
              : operation.state === 'installing'
                ? { ...operation, state: 'paused' }
                : operation;
          this.operations.set(operation.id, recovered);
        }
        this.flush();
      } catch (error) {
        // Preserve corrupt state for diagnostics; it must never trigger installation or generation.
        this.operations.clear();
        this.requests.clear();
        console.error('[creation] saved requests could not be recovered', error);
      }
    }
  }
  bind(requestId: string, conversationId: string): void {
    const prior = this.requests.get(requestId);
    if (
      typeof requestId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(requestId) ||
      !conversationId ||
      (prior && prior.conversationId !== conversationId)
    )
      throw new Error('CREATION_REQUEST_MISMATCH');
    this.requests.set(requestId, prior ?? { conversationId, cancelled: false });
    this.flush();
  }
  get(id: string): CreationOperation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error('CREATION_OPERATION_NOT_FOUND');
    return operation;
  }
  request(requestId: string, input: unknown): CreationOperation {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))
      throw new Error('CREATION_REQUEST_INVALID');
    const scope = this.requests.get(requestId);
    if (!scope || scope.cancelled) throw new Error('CREATION_CONVERSATION_UNAVAILABLE');
    const spec = h3GenerationSpecSchema.parse(input);
    const previous = [...this.operations.values()].find(
      (operation) =>
        operation.requestId === requestId &&
        operation.state !== 'cancelled' &&
        JSON.stringify(operation.spec) === JSON.stringify(spec)
    );
    if (previous) return previous;
    const pending = [...this.operations.values()].filter(
      (operation) => !['submitted', 'cancelled'].includes(operation.state)
    );
    if (pending.length >= 200) throw new Error('CREATION_OPERATION_LIMIT');
    const operation: CreationOperation = {
      id: crypto.randomUUID(),
      requestId,
      conversationId: scope.conversationId,
      spec,
      state: 'awaiting-consent',
      updatedAt: new Date().toISOString(),
    };
    this.operations.set(operation.id, operation);
    this.flush();
    return operation;
  }
  authorize(id: string, conversationId: string, consent: CreationInstallConsent): CreationOperation {
    const operation = this.get(id);
    if (this.wantsCancellation(id)) throw new Error('CREATION_CONVERSATION_UNAVAILABLE');
    if (!conversationId || operation.conversationId !== conversationId || consent.acceptModelTerms !== true)
      throw new Error('H3_MODEL_TERMS_REQUIRED');
    if (!['awaiting-consent', 'paused', 'failed', 'authorized'].includes(operation.state))
      throw new Error('CREATION_OPERATION_NOT_AUTHORIZABLE');
    return this.update(id, { state: 'authorized', conversationId, consent, error: undefined });
  }
  async start(id: string, requestId: string): Promise<CreationOperation> {
    const operation = this.get(id);
    if (this.wantsCancellation(id)) throw new Error('CREATION_CONVERSATION_UNAVAILABLE');
    if (operation.requestId !== requestId) throw new Error('CREATION_REQUEST_MISMATCH');
    if (['installing', 'submitted'].includes(operation.state)) return operation;
    if (operation.state !== 'authorized' || !operation.consent) throw new Error('CREATION_USER_CONFIRMATION_REQUIRED');
    this.starting.add(id);
    this.update(id, { state: 'installing' });
    try {
      if (!this.ports.installed()) await this.ports.install(operation.consent);
      else await this.submit(operation);
    } catch (error) {
      if (!this.wantsCancellation(id))
        this.update(id, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.starting.delete(id);
      if (this.wantsCancellation(id)) await this.settleCancellation(id);
    }
    return this.get(id);
  }
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const operation of this.operations.values()) {
        if (operation.state === 'cancelling') {
          await this.settleCancellation(operation.id);
          continue;
        }
        // Installer preflight still exposes the previous setup attempt's phase.
        if (this.starting.has(operation.id) || this.submitting.has(operation.id)) continue;
        if (operation.state !== 'installing') continue;
        const setup = this.ports.setup();
        if (setup.phase === 'paused' || setup.phase === 'failed') {
          this.update(operation.id, { state: setup.phase, error: setup.error });
          continue;
        }
        if (!['installed', 'idle'].includes(setup.phase)) continue;
        if (!this.ports.installed()) {
          if (setup.phase === 'installed')
            this.update(operation.id, { state: 'failed', error: 'H3_INSTALLATION_INCOMPLETE' });
          continue;
        }
        await this.submit(operation);
      }
    } finally {
      this.pumping = false;
    }
  }
  private async submit(operation: CreationOperation): Promise<void> {
    if (this.wantsCancellation(operation.id) || this.submitting.has(operation.id)) return;
    this.submitting.add(operation.id);
    try {
      const jobId = await this.ports.enqueue(operation.spec, operation.id);
      this.update(operation.id, { jobId, ...(!this.wantsCancellation(operation.id) ? { state: 'submitted' } : {}) });
    } catch (error) {
      if (!this.wantsCancellation(operation.id))
        this.update(operation.id, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.submitting.delete(operation.id);
      if (this.wantsCancellation(operation.id)) await this.settleCancellation(operation.id);
    }
  }
  async cancel(id: string): Promise<CreationOperation> {
    this.update(id, { state: 'cancelling', error: undefined });
    await this.settleCancellation(id);
    return this.get(id);
  }
  /** Prevent dispatch of jobs whose persisted creation request is being cancelled. */
  canRunJob(id: string): boolean {
    return !this.operations.has(id) || !this.wantsCancellation(id);
  }
  private wantsCancellation(id: string): boolean {
    const operation = this.get(id);
    return (
      ['cancelled', 'cancelling'].includes(operation.state) ||
      this.requests.get(operation.requestId)?.cancelled === true
    );
  }
  private jobSettled(job: Pick<H3Job, 'status' | 'remoteUncertain' | 'cancelRequested'>): boolean {
    return !['queued', 'running'].includes(job.status) && !job.remoteUncertain && !job.cancelRequested;
  }
  private async settleCancellation(id: string): Promise<void> {
    if (this.starting.has(id) || this.submitting.has(id) || this.cancelling.has(id)) return;
    this.cancelling.add(id);
    try {
      const operation = this.get(id);
      const jobId = operation.jobId ?? (this.ports.getJob(id) ? id : undefined);
      if (jobId) {
        this.update(id, { jobId });
        const job = this.ports.getJob(jobId);
        if (!job || !this.jobSettled(job)) await this.ports.cancelJob(jobId);
        const latest = this.ports.getJob(jobId);
        if (latest && !this.jobSettled(latest)) return;
      }
      this.update(id, { state: 'cancelled', error: undefined });
    } catch (error) {
      this.update(id, { state: 'cancelling', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.cancelling.delete(id);
    }
  }
  async cancelConversation(conversationId: string): Promise<void> {
    for (const scope of this.requests.values()) if (scope.conversationId === conversationId) scope.cancelled = true;
    this.flush();
    for (const operation of this.operations.values())
      if (operation.conversationId === conversationId && operation.state !== 'cancelled')
        await this.cancel(operation.id);
  }
  private update(id: string, patch: Partial<CreationOperation>): CreationOperation {
    const next = { ...this.get(id), ...patch, updatedAt: new Date().toISOString() };
    this.operations.set(id, next);
    this.flush();
    return next;
  }
  private flush(): void {
    const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({ operations: [...this.operations.values()], requests: [...this.requests.entries()] }),
        { flag: 'wx', mode: 0o600 }
      );
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(temporary, this.filename);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 5)
            throw error;
          // Windows may briefly refuse replacement even after our handles close.
          // Retry the completed file; never delete the last committed state.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
        }
      }
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Cleanup must not mask the persistence error or remove the live file.
      }
    }
  }
}
