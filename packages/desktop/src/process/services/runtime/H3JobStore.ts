import fs from 'node:fs';
import path from 'node:path';
import { inferH3Mode, normalizeH3GenerationSpec, type H3Job } from '@/common/chat/document/h3Job';

export interface H3JobStore {
  get(id: string): H3Job | undefined;
  create(job: H3Job): H3Job;
  update(id: string, patch: Partial<H3Job>): H3Job;
  listActive(): H3Job[];
  listBlocked(): H3Job[];
}

export class FileH3JobStore implements H3JobStore {
  private readonly jobs = new Map<string, H3Job>();
  constructor(private readonly filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename)) {
      for (const job of JSON.parse(fs.readFileSync(filename, 'utf8')) as H3Job[]) {
        const spec = normalizeH3GenerationSpec(job.spec);
        this.jobs.set(job.id, { ...job, spec, resolvedMode: inferH3Mode(spec) });
      }
    }
  }
  get(id: string): H3Job | undefined {
    return this.jobs.get(id);
  }
  create(job: H3Job): H3Job {
    this.jobs.set(job.id, job);
    this.flush();
    return job;
  }
  update(id: string, patch: Partial<H3Job>): H3Job {
    const current = this.jobs.get(id);
    if (!current) throw new Error('H3_JOB_NOT_FOUND');
    const next = { ...current, ...patch };
    this.jobs.set(id, next);
    this.flush();
    return next;
  }
  listActive(): H3Job[] {
    return [...this.jobs.values()].filter((job) => ['queued', 'running'].includes(job.status));
  }
  listBlocked(): H3Job[] {
    return [...this.jobs.values()].filter((job) => job.remoteUncertain);
  }
  private flush(): void {
    const temp = `${this.filename}.tmp`;
    fs.writeFileSync(temp, JSON.stringify([...this.jobs.values()], null, 2), 'utf8');
    fs.renameSync(temp, this.filename);
  }
}
