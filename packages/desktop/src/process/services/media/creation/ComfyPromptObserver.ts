import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { ComfyGenerationJob } from '@/common/chat/document/creation/comfy';
import type { ComfyResourceScope } from '../comfy/ComfyService';
import { verifyComfySmokeArtifact } from '../comfy/mediaValidation';

const inputSchema = z.object({
  conversationId: z.string().min(1).max(256),
  requestId: z.string().uuid().optional(),
  baseUrl: z.string().url(),
  promptId: z.string().uuid(),
  kind: z.enum(['image', 'video']),
});
type Input = z.infer<typeof inputSchema>;
type Saved = Input & { job: ComfyGenerationJob; missingCount: number };
type Json = Record<string, unknown>;
type Options = {
  filename: string;
  outputRoot: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  verifyArtifact?: (
    artifact: { path: string; mimeType: string },
    kind: 'image' | 'video',
    signal: AbortSignal
  ) => Promise<void>;
};
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const active = (saved: Saved): boolean => ['queued', 'running'].includes(saved.job.status);
const types: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

function localOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('COMFY_LOCAL_ENDPOINT_REQUIRED');
  return url.origin;
}

/** Observe an existing external prompt. This service never submits or interrupts ComfyUI work. */
export class ComfyPromptObserver {
  private entries = new Map<string, Saved>();
  private controller = new AbortController();
  private pending?: Promise<void>;
  private stateInvalid = false;
  constructor(private options: Options) {
    try {
      fs.mkdirSync(options.outputRoot, { recursive: true });
      if (!fs.existsSync(options.filename)) return;
      const saved: unknown = JSON.parse(fs.readFileSync(options.filename, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('COMFY_OBSERVER_STATE_INVALID');
      for (const raw of saved) {
        const input = inputSchema.parse(raw);
        const item = raw as Saved;
        z.string().uuid().parse(item.job.id);
        localOrigin(input.baseUrl);
        if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(item.job.status))
          throw new Error('COMFY_OBSERVER_STATE_INVALID');
        try {
          for (const artifact of item.job.artifacts) this.assertArtifact(artifact.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          item.job.status = 'failed';
          item.job.error = 'COMFY_OUTPUT_FILE_MISSING';
          item.job.artifacts = [];
        }
        this.entries.set(item.job.id, { ...input, job: item.job, missingCount: item.missingCount ?? 0 });
      }
    } catch {
      // Preserve the receipt for diagnosis; a bad observer file must not stop
      // model inventory, integrated generation or historical media playback.
      this.stateInvalid = true;
      this.entries.clear();
      console.warn('[comfy] COMFY_OBSERVER_STATE_INVALID');
    }
  }
  observe(raw: Input): ComfyGenerationJob {
    if (this.stateInvalid) throw new Error('COMFY_OBSERVER_STATE_INVALID');
    const input = inputSchema.parse(raw);
    input.baseUrl = localOrigin(input.baseUrl);
    const existing = [...this.entries.values()].find(
      (item) => item.baseUrl === input.baseUrl && item.promptId === input.promptId
    );
    if (existing) {
      if (existing.conversationId !== input.conversationId || existing.requestId !== input.requestId)
        throw new Error('COMFY_SCOPE_MISMATCH');
      if (existing.kind !== input.kind) throw new Error('COMFY_OBSERVATION_KIND_MISMATCH');
      if (existing.job.status === 'failed') {
        existing.job.status = 'queued';
        existing.job.progress = 0;
        existing.job.createdAt = new Date(this.now()).toISOString();
        existing.job.updatedAt = existing.job.createdAt;
        delete existing.job.error;
        existing.missingCount = 0;
      }
      // A previous write may have failed after the entry entered memory.
      // A successful handoff must always have a durable receipt, including retries.
      this.flush();
      return structuredClone(existing.job);
    }
    const now = new Date(this.now()).toISOString();
    const job: ComfyGenerationJob = {
      id: crypto.randomUUID(),
      profileId: 'external-comfy-prompt',
      kind: input.kind,
      promptId: input.promptId,
      observationOnly: true,
      status: 'queued',
      progress: 0,
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(job.id, { ...input, job, missingCount: 0 });
    this.flush();
    return structuredClone(job);
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  job(id: string, scope: ComfyResourceScope): ComfyGenerationJob {
    const saved = this.entries.get(id);
    if (!saved) throw new Error('COMFY_JOB_NOT_FOUND');
    if (
      (!scope.conversationId && !scope.requestId) ||
      (scope.conversationId && scope.conversationId !== saved.conversationId) ||
      (scope.requestId && scope.requestId !== saved.requestId)
    )
      throw new Error('COMFY_SCOPE_MISMATCH');
    try {
      for (const artifact of saved.job.artifacts) this.assertArtifact(artifact.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      saved.job.status = 'failed';
      saved.job.error = 'COMFY_OUTPUT_FILE_MISSING';
      saved.job.artifacts = [];
      this.flush();
    }
    return structuredClone(saved.job);
  }
  tick(): Promise<void> {
    if (this.controller.signal.aborted || this.stateInvalid) return Promise.resolve();
    this.pending ??= this.run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  close(): void {
    this.controller.abort();
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private assertArtifact(file: string): void {
    const root = fs.realpathSync(this.options.outputRoot);
    const relative = path.relative(root, fs.realpathSync(file));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('COMFY_OUTPUT_PATH_UNSAFE');
  }
  private flush(): void {
    fs.mkdirSync(path.dirname(this.options.filename), { recursive: true });
    const temporary = `${this.options.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.entries.values()]), { mode: 0o600 });
    fs.renameSync(temporary, this.options.filename);
  }
  private async request(saved: Saved, route: string): Promise<Response> {
    return (this.options.fetchImpl ?? fetch)(`${saved.baseUrl}${route}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
    });
  }
  private async json(saved: Saved, route: string): Promise<Json> {
    const response = await this.request(saved, route);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`COMFY_OBSERVATION_HTTP_${response.status}`);
    }
    return record(await response.json());
  }
  private async run(): Promise<void> {
    for (const saved of this.entries.values()) {
      if (!active(saved) || this.controller.signal.aborted) continue;
      try {
        if (this.now() - Date.parse(saved.job.createdAt) > 2 * 60 * 60 * 1000)
          throw new Error('COMFY_OBSERVATION_TIMEOUT');
        const history = await this.json(saved, `/history/${encodeURIComponent(saved.promptId)}`);
        const entry = record(history[saved.promptId]);
        const status = record(entry.status);
        if (status.status_str === 'error') throw new Error('COMFY_OBSERVED_GENERATION_FAILED');
        if (
          Array.isArray(status.messages) &&
          status.messages.some((item) => Array.isArray(item) && item[0] === 'execution_interrupted')
        )
          throw new Error('COMFY_OBSERVED_GENERATION_CANCELLED');
        if (status.completed === true) {
          saved.job.artifacts = await this.archive(saved, record(entry.outputs));
          saved.job.status = 'succeeded';
          saved.job.progress = 100;
        } else {
          const queue = await this.json(saved, '/queue');
          const contains = (items: unknown): boolean =>
            Array.isArray(items) && items.some((item) => Array.isArray(item) && item[1] === saved.promptId);
          const running = contains(queue.queue_running);
          if (running || contains(queue.queue_pending) || Object.hasOwn(history, saved.promptId))
            saved.missingCount = 0;
          else if (++saved.missingCount >= 3) throw new Error('COMFY_OBSERVED_PROMPT_LOST');
          saved.job.status = running ? 'running' : 'queued';
        }
        delete saved.job.error;
      } catch (error) {
        if (this.controller.signal.aborted) return;
        const detail = error instanceof Error ? error.message : String(error);
        const terminal =
          /^(COMFY_OUTPUT_(?:PATH_UNSAFE|LIMIT_EXCEEDED|EMPTY)|COMFY_NO_OUTPUT|COMFY_MEDIA_|COMFY_SMOKE_|COMFY_OBSERVED_|COMFY_OBSERVATION_TIMEOUT)/.test(
            detail
          );
        saved.job.error = terminal ? detail : 'COMFY_OBSERVATION_CONNECTION_UNAVAILABLE';
        if (terminal) saved.job.status = 'failed';
        // A disconnect does not prove the original generation stopped. Retry reads only.
      }
      saved.job.updatedAt = new Date(this.now()).toISOString();
      this.flush();
    }
  }
  private async archive(saved: Saved, outputs: Json): Promise<ComfyGenerationJob['artifacts']> {
    const files = Object.values(outputs)
      .flatMap((output) =>
        ['images', 'videos', 'gifs'].flatMap((key) => {
          const value = record(output)[key];
          return Array.isArray(value) ? value.map(record) : value && typeof value === 'object' ? [record(value)] : [];
        })
      )
      .filter((file) => file.type === undefined || file.type === 'output');
    if (!files.length) throw new Error('COMFY_NO_OUTPUT');
    if (files.length > 64) throw new Error('COMFY_OUTPUT_LIMIT_EXCEEDED');
    const directory = fs.mkdtempSync(path.join(this.options.outputRoot, `${saved.job.id}-`));
    const artifacts: ComfyGenerationJob['artifacts'] = [];
    const seen = new Set<string>();
    try {
      for (const file of files) {
        const filename = String(file.filename ?? '');
        const subfolder = typeof file.subfolder === 'string' ? file.subfolder : '';
        const hasControlCharacter = (value: string): boolean =>
          [...value].some((character) => character.charCodeAt(0) < 32);
        if (
          !filename ||
          /[\\/:]/.test(filename) ||
          hasControlCharacter(filename) ||
          /^[.]{1,2}$/.test(filename) ||
          subfolder.includes(':') ||
          hasControlCharacter(subfolder) ||
          subfolder.startsWith('/') ||
          subfolder.startsWith('\\') ||
          subfolder.split(/[\\/]/).includes('..')
        )
          throw new Error('COMFY_OUTPUT_PATH_UNSAFE');
        const mimeType = types[path.extname(filename).toLowerCase()];
        if (!mimeType?.startsWith(`${saved.kind}/`)) continue;
        const query = new URLSearchParams({ filename, subfolder, type: 'output' }).toString();
        if (seen.has(query)) continue;
        seen.add(query);
        const response = await this.request(saved, `/view?${query}`);
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error('COMFY_OUTPUT_RETRIEVAL_FAILED');
        }
        const target = path.join(directory, `${artifacts.length + 1}${path.extname(filename).toLowerCase()}`);
        let bytes = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            done(bytes > 4 * 1024 ** 3 ? new Error('COMFY_OUTPUT_LIMIT_EXCEEDED') : null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
          limit,
          fs.createWriteStream(target, { flags: 'wx' }),
          { signal: this.controller.signal }
        );
        if (!bytes) throw new Error('COMFY_OUTPUT_EMPTY');
        const artifact = { path: target, mimeType };
        await (
          this.options.verifyArtifact ??
          ((artifact, kind, signal) => verifyComfySmokeArtifact(artifact, kind, signal, undefined, 'generation'))
        )(artifact, saved.kind, this.controller.signal);
        artifacts.push(artifact);
      }
      if (!artifacts.length) throw new Error('COMFY_NO_OUTPUT');
      return artifacts;
    } catch (error) {
      // The directory was created by this observer and has no user files.
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
