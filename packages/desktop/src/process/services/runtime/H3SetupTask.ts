import fs from 'node:fs';
import path from 'node:path';
import type { H3SetupPhase, H3SetupState, H3DownloadProgress } from '@/common/chat/document/h3Setup';

export class H3SetupTask {
  private state: H3SetupState = { phase: 'idle' };
  private running?: Promise<void>;
  private controller?: AbortController;
  constructor(
    private readonly file: string,
    private readonly install: (
      root: string,
      progress: (
        phase: 'downloading' | 'verifying' | 'extracting' | 'installing-acceleration',
        detail?: H3DownloadProgress
      ) => void,
      download: boolean,
      signal: AbortSignal
    ) => Promise<void>
  ) {
    if (fs.existsSync(file)) {
      let saved: H3SetupState;
      try {
        saved = JSON.parse(fs.readFileSync(file, 'utf8')) as H3SetupState;
      } catch {
        // A power loss can leave a truncated state file. Preserve the file for
        // diagnostics and let the user retry instead of crashing media-service.
        this.state = { phase: 'failed', error: 'H3_SETUP_STATE_CORRUPTED' };
        return;
      }
      const phases: H3SetupPhase[] = [
        'idle',
        'downloading',
        'verifying',
        'extracting',
        'installing-acceleration',
        'installed',
        'paused',
        'failed',
      ];
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !phases.includes(saved.phase)) {
        this.state = { phase: 'failed', error: 'H3_SETUP_STATE_INVALID' };
        return;
      }
      this.state = saved;
      if (['downloading', 'verifying', 'extracting', 'installing-acceleration'].includes(saved.phase)) {
        try {
          this.save({ ...saved, phase: 'paused' });
        } catch {
          this.state = { ...saved, phase: 'failed', error: 'H3_SETUP_STATE_WRITE_FAILED' };
        }
      }
    }
  }
  status(): H3SetupState {
    return { ...this.state };
  }
  busy(): boolean {
    return Boolean(this.running);
  }
  wait(): Promise<void> {
    return this.running ?? Promise.resolve();
  }
  async pause(): Promise<H3SetupState> {
    if (!this.running || !['downloading', 'installing-acceleration'].includes(this.state.phase))
      throw new Error('H3_SETUP_NOT_PAUSABLE');
    this.controller?.abort();
    await this.wait();
    return this.status();
  }
  start(bundleRoot: string, download = false): H3SetupState {
    if (this.running) throw new Error('H3_SETUP_BUSY');
    const controller = new AbortController();
    this.controller = controller;
    this.save({ phase: download ? 'downloading' : 'verifying', bundleRoot, download });
    this.running = Promise.resolve()
      .then(() =>
        this.install(
          bundleRoot,
          (phase, detail) => {
            if (!controller.signal.aborted) this.save({ ...this.state, ...detail, phase, bundleRoot, download });
          },
          download,
          controller.signal
        )
      )
      .then(() => this.save({ ...this.state, phase: controller.signal.aborted ? 'paused' : 'installed' }))
      .catch((error: unknown) =>
        this.save({
          ...this.state,
          phase: controller.signal.aborted ? 'paused' : 'failed',
          error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
        })
      )
      .catch(() => {
        this.state = { ...this.state, phase: 'failed', error: 'H3_SETUP_STATE_WRITE_FAILED' };
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.status();
  }
  private save(state: H3SetupState): void {
    if (state.phase !== 'downloading') state = { ...state, retryAttempt: 0, retryDelayMs: 0 };
    const next = { ...state, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(next));
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.state = next;
  }
}
