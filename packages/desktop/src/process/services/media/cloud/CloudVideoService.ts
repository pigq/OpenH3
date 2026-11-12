import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  cloudVideoConnectionSchema,
  cloudVideoInputSchema,
  H3_CLOUD_LORA_PATH,
  type CloudVideoConnectionInput,
  type CloudVideoConnection,
  type CloudVideoInput,
  type CloudVideoJob,
  type PublicVideoConnection,
  type VideoAdapter,
} from '@/common/chat/document/creation/cloudVideo';
import { buildVideoForm, createVideoAdapter, validateVideoInput } from './videoAdapters';

type RecordJob = { job: CloudVideoJob; connection: CloudVideoConnection };
type State = {
  connections: CloudVideoConnection[];
  bindings: Record<string, { conversationId: string; connectionId: string }>;
  jobs: RecordJob[];
};
type Options = { root: string; adapter?: (connection: CloudVideoConnection) => VideoAdapter };

/** Owns cloud credentials, immutable job connections and durable single-submission identities. */
export class CloudVideoService {
  private state: State;
  private readonly filename: string;
  private readonly active = new Set<string>();
  private polling = false;
  private closed = false;
  constructor(private readonly options: Options) {
    fs.mkdirSync(options.root, { recursive: true });
    this.filename = path.join(options.root, 'cloud-video.json');
    this.state = fs.existsSync(this.filename)
      ? (JSON.parse(fs.readFileSync(this.filename, 'utf8')) as State)
      : { connections: [], bindings: {}, jobs: [] };
    for (const { job } of this.state.jobs) {
      if (!job.remoteId && ['queued', 'running'].includes(job.status)) {
        Object.assign(job, { status: 'failed', submissionUncertain: true, error: 'CLOUD_VIDEO_SUBMISSION_UNCERTAIN' });
      }
    }
    this.persist();
  }
  private persist(): void {
    const temp = `${this.filename}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.filename);
  }
  connections(): PublicVideoConnection[] {
    return this.state.connections.map(({ apiKey, ...connection }) => ({ ...connection, hasApiKey: Boolean(apiKey) }));
  }
  saveConnection(raw: CloudVideoConnectionInput): PublicVideoConnection {
    const input = cloudVideoConnectionSchema.parse(raw);
    const previous = this.state.connections.find((connection) => connection.id === input.id);
    const baseUrl = input.baseUrl.replace(/\/+$/, '');
    const sameEndpoint = previous?.baseUrl === baseUrl && previous.protocol === input.protocol;
    const apiKey = input.apiKey === undefined && sameEndpoint ? previous.apiKey : (input.apiKey?.trim() ?? '');
    if (input.protocol === 'openai-video' && (!apiKey || !input.model))
      throw new Error('CLOUD_VIDEO_MODEL_KEY_REQUIRED');
    const connection: CloudVideoConnection = {
      ...input,
      id: input.id ?? randomUUID(),
      baseUrl,
      apiKey,
      ...(input.protocol === 'vllm-h3' ? { loraPath: input.loraPath ?? H3_CLOUD_LORA_PATH } : {}),
    };
    this.state.connections = [...this.state.connections.filter((item) => item.id !== connection.id), connection];
    this.persist();
    return this.connections().find((item) => item.id === connection.id)!;
  }
  bind(requestId: string, conversationId: string, connectionId: string): void {
    if (!this.state.connections.some((item) => item.id === connectionId))
      throw new Error('CLOUD_VIDEO_CONNECTION_MISSING');
    const prior = this.state.bindings[requestId];
    if (prior && (prior.conversationId !== conversationId || prior.connectionId !== connectionId))
      throw new Error('CLOUD_VIDEO_SCOPE_MISMATCH');
    this.state.bindings[requestId] = { conversationId, connectionId };
    this.persist();
  }
  async submit(requestId: string, raw: CloudVideoInput, submissionId = requestId): Promise<CloudVideoJob> {
    const matches = ({ job }: RecordJob): boolean =>
      job.requestId === requestId && (job.submissionId ?? job.requestId) === submissionId;
    const prior = this.state.jobs.find(matches);
    if (prior) return { ...prior.job };
    const binding = this.state.bindings[requestId];
    if (!binding) throw new Error('CLOUD_VIDEO_BINDING_REQUIRED');
    const connection = this.state.connections.find((item) => item.id === binding.connectionId)!;
    const input = cloudVideoInputSchema.parse(raw);
    validateVideoInput(connection, input);
    // Validate every local upload before reserving the submission identity.
    if (!this.options.adapter) await buildVideoForm(connection, input);
    const duplicate = this.state.jobs.find(matches);
    if (duplicate) return { ...duplicate.job };
    const job: CloudVideoJob = {
      id: randomUUID(),
      requestId,
      submissionId,
      ...binding,
      model: connection.model || connection.name,
      status: 'queued',
      progress: 0,
      progressKnown: false,
      stage: 'submitting',
      aspectRatio: input.aspectRatio,
      width: input.width,
      height: input.height,
      createdAt: new Date().toISOString(),
    };
    const record = { job, connection: { ...connection } };
    this.state.jobs.push(record);
    this.persist();
    this.active.add(job.id);
    try {
      const remote = await this.adapter(record).submit(input);
      job.remoteId = remote.id;
      job.status = remote.status === 'failed' ? 'failed' : remote.status === 'queued' ? 'queued' : 'running';
      job.stage = remote.status === 'failed' ? 'failed' : remote.status === 'queued' ? 'queued' : 'generating';
      job.progressKnown = remote.progress !== undefined;
      job.progress = remote.progress ?? 0;
      job.lastCheckedAt = job.updatedAt = new Date().toISOString();
      if (remote.status === 'failed') job.error = 'CLOUD_VIDEO_GENERATION_FAILED';
      this.persist();
    } catch (error) {
      // An HTTP rejection proves no accepted job; a lost response does not.
      const status = (error as { status?: number }).status;
      Object.assign(job, {
        status: 'failed',
        stage: 'failed',
        submissionUncertain: !status || status >= 500,
        error: status ? `CLOUD_VIDEO_HTTP_${status}` : 'CLOUD_VIDEO_SUBMISSION_UNCERTAIN',
      });
      this.persist();
    } finally {
      this.active.delete(job.id);
    }
    return { ...job };
  }
  private adapter(record: RecordJob): VideoAdapter {
    return (this.options.adapter ?? createVideoAdapter)(record.connection);
  }
  job(id: string, scope: string): CloudVideoJob {
    const record = this.state.jobs.find((item) => item.job.id === id);
    if (!record) throw new Error('CLOUD_VIDEO_JOB_MISSING');
    if (scope !== record.job.conversationId && scope !== record.job.requestId)
      throw new Error('CLOUD_VIDEO_SCOPE_MISMATCH');
    return { ...record.job };
  }
  artifact(id: string, scope: string): string {
    if (this.job(id, scope).status !== 'succeeded') throw new Error('CLOUD_VIDEO_NOT_COMPLETE');
    return path.join(this.options.root, `${id}.mp4`);
  }
  private async download(record: RecordJob): Promise<void> {
    record.job.status = 'running';
    record.job.stage = 'downloading';
    record.job.downloadBytes = 0;
    record.job.downloadTotalBytes = undefined;
    record.job.updatedAt = new Date().toISOString();
    this.persist();
    const response = await this.adapter(record).download(record.job.remoteId!);
    if (!response.ok || !response.body) throw new Error('CLOUD_VIDEO_DOWNLOAD_FAILED');
    const total = Number(response.headers.get('content-length'));
    if (Number.isSafeInteger(total) && total > 0) record.job.downloadTotalBytes = total;
    const temp = path.join(this.options.root, `${record.job.id}.part`);
    const target = path.join(this.options.root, `${record.job.id}.mp4`);
    const fd = fs.openSync(temp, 'w');
    let size = 0;
    let header = Buffer.alloc(0);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        record.job.downloadBytes = size;
        record.job.updatedAt = new Date().toISOString();
        if (size > 1024 * 1024 * 1024) throw new Error('CLOUD_VIDEO_OUTPUT_TOO_LARGE');
        if (header.length < 12) header = Buffer.concat([header, Buffer.from(value)]).subarray(0, 12);
        fs.writeSync(fd, value);
      }
      if (size < 12 || header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('CLOUD_VIDEO_INVALID_MP4');
    } catch (error) {
      await reader.cancel().catch((): undefined => undefined);
      fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
      throw error;
    }
    fs.closeSync(fd);
    fs.renameSync(temp, target);
  }
  async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      for (const record of this.state.jobs) {
        const { job } = record;
        if (!job.remoteId || !['queued', 'running'].includes(job.status) || this.active.has(job.id)) continue;
        try {
          const remote = await this.adapter(record).retrieve(job.remoteId);
          if (remote.id !== job.remoteId) throw new Error('CLOUD_VIDEO_REMOTE_ID_MISMATCH');
          job.error = undefined;
          job.progressKnown = remote.progress !== undefined;
          job.progress = remote.progress ?? 0;
          job.lastCheckedAt = job.updatedAt = new Date().toISOString();
          if (remote.status === 'failed') {
            job.status = 'failed';
            job.stage = 'failed';
            job.error = 'CLOUD_VIDEO_GENERATION_FAILED';
          } else if (remote.status === 'completed') {
            await this.download(record);
            job.status = 'succeeded';
            job.stage = 'completed';
            job.progressKnown = true;
            job.progress = 100;
          } else {
            job.status = remote.status === 'queued' ? 'queued' : 'running';
            job.stage = remote.status === 'queued' ? 'queued' : 'generating';
          }
        } catch (error) {
          const status = (error as { status?: number }).status;
          const permanent = status !== undefined && [400, 401, 403, 404, 422].includes(status);
          if (permanent) {
            job.status = 'failed';
            job.stage = 'failed';
          }
          job.error =
            status === 404
              ? 'CLOUD_VIDEO_REMOTE_LOST'
              : permanent
                ? `CLOUD_VIDEO_HTTP_${status}`
                : 'CLOUD_VIDEO_CONNECTION_RETRYING';
        }
        this.persist();
      }
    } finally {
      this.polling = false;
    }
  }
  updateIdle(): boolean {
    // Remote work survives a client update; only local requests/downloads need to drain.
    return !this.polling && !this.active.size;
  }
  close(): void {
    this.closed = true;
  }
}
