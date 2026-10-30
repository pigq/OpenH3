import fs from 'node:fs';
import path from 'node:path';
import type { MediaJob } from '@/common/chat/document/mediaJob';
import type { MediaJobStoreLike } from './MediaJobRunner';

export class JsonMediaJobStore implements MediaJobStoreLike {
  private rows = new Map<string, MediaJob>();
  private recovered = true;
  constructor(private readonly filePath: string) {
    this.load();
  }
  get recoveryKnown(): boolean {
    return this.recovered;
  }
  get(id: string): MediaJob | undefined {
    return this.rows.get(id);
  }
  getByIdempotencyKey(key: string): MediaJob | undefined {
    return [...this.rows.values()].find((job) => job.idempotencyKey === key);
  }
  create(job: MediaJob): MediaJob {
    this.rows.set(job.id, job);
    this.flush();
    return job;
  }
  update(id: string, patch: Pick<MediaJob, 'status' | 'progress'> & { error?: string }): MediaJob {
    const current = this.rows.get(id);
    if (!current) throw new Error(`MEDIA_JOB_NOT_FOUND:${id}`);
    const next = { ...current, ...patch };
    this.rows.set(id, next);
    this.flush();
    return next;
  }
  listActive(): MediaJob[] {
    return [...this.rows.values()].filter((job) => job.status === 'queued' || job.status === 'running');
  }
  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as MediaJob[];
      for (const job of data) this.rows.set(job.id, job);
    } catch (error) {
      this.recovered = (error as NodeJS.ErrnoException).code === 'ENOENT';
      /* first run or corrupt cache: start empty */
    }
  }
  private flush(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.rows.values()], null, 2), 'utf8');
    fs.renameSync(temporary, this.filePath);
  }
}
