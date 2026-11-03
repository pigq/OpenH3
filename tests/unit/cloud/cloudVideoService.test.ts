import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudVideoService } from '@/process/services/media/cloud/CloudVideoService';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-video-'));
  roots.push(root);
  const adapter = {
    submit: vi.fn(async () => ({ id: 'remote-1', status: 'queued' as const, progress: 0 })),
    retrieve: vi.fn(async () => ({ id: 'remote-1', status: 'completed' as const, progress: 100 })),
    download: vi.fn(async () => new Response(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]))),
  };
  const options = { root, adapter: () => adapter };
  const service = new CloudVideoService(options);
  const connection = service.saveConnection({
    name: 'H3',
    protocol: 'vllm-h3',
    baseUrl: 'http://server/v1',
    model: '',
    apiKey: 'secret',
  });
  service.bind('request', 'conversation', connection.id);
  return { root, adapter, service, connection, options };
}
describe('persistent cloud video jobs', () => {
  it('stops polling rejected credentials instead of waiting indefinitely', async () => {
    const { service, adapter } = fixture();
    const job = await service.submit('request', { prompt: 'fox' });
    adapter.retrieve.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    await service.poll();
    expect(service.job(job.id, 'conversation')).toMatchObject({ status: 'failed', error: 'CLOUD_VIDEO_HTTP_401' });
  });
  it('retries failed downloads without submitting another generation', async () => {
    const { service, adapter } = fixture();
    const job = await service.submit('request', { prompt: 'fox' });
    adapter.download.mockRejectedValueOnce(new Error('offline'));
    await service.poll();
    expect(service.job(job.id, 'conversation').status).toBe('queued');
    await service.poll();
    expect(service.job(job.id, 'conversation').status).toBe('succeeded');
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps the submitted endpoint snapshot after connection settings change', async () => {
    const { service, options, connection, adapter } = fixture();
    await service.submit('request', { prompt: 'fox' });
    service.saveConnection({ ...connection, baseUrl: 'http://other/v1', apiKey: 'new-secret' });
    const factory = vi.fn(() => adapter);
    const resumed = new CloudVideoService({ ...options, adapter: factory });
    await resumed.poll();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://server/v1', apiKey: 'secret' }));
  });
  it('supports a later generation in the same conversation with a distinct submission identity', async () => {
    const { service, adapter } = fixture();
    const first = await service.submit('request', { prompt: 'fox' }, 'first');
    await service.poll();
    const second = await service.submit('request', { prompt: 'ocean' }, 'second');
    expect(first.id).not.toBe(second.id);
    expect(adapter.submit).toHaveBeenCalledTimes(2);
  });
  it('submits once and scopes public jobs without credentials', async () => {
    const { service, adapter } = fixture();
    const first = await service.submit('request', { prompt: 'fox' });
    expect(await service.submit('request', { prompt: 'another' })).toEqual(first);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(service.connections())).not.toContain('secret');
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(() => service.job(first.id, 'other')).toThrow('CLOUD_VIDEO_SCOPE_MISMATCH');
    await service.poll();
    expect(service.job(first.id, 'conversation')).toMatchObject({ status: 'succeeded', remoteId: 'remote-1' });
    expect(fs.existsSync(service.artifact(first.id, 'conversation'))).toBe(true);
  });
  it('persists remote IDs and resumes GET after restart without reposting', async () => {
    const { service, adapter, options } = fixture();
    const job = await service.submit('request', { prompt: 'fox' });
    const recovered = new CloudVideoService(options);
    await recovered.poll();
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(recovered.job(job.id, 'conversation').status).toBe('succeeded');
  });
  it('records ambiguous POST and never submits it again', async () => {
    const { service, adapter } = fixture();
    adapter.submit.mockRejectedValue(new Error('socket closed'));
    const job = await service.submit('request', { prompt: 'fox' });
    expect(job).toMatchObject({ status: 'failed', submissionUncertain: true });
    await service.submit('request', { prompt: 'fox' });
    await service.poll();
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(service.updateIdle()).toBe(true);
  });
  it('keeps queued jobs on transient GET failures and reports remote loss', async () => {
    const { service, adapter } = fixture();
    const job = await service.submit('request', { prompt: 'fox' });
    adapter.retrieve.mockRejectedValueOnce(new Error('HTTP_503'));
    await service.poll();
    expect(service.job(job.id, 'conversation').status).toBe('queued');
    adapter.retrieve.mockRejectedValueOnce(Object.assign(new Error('CLOUD_VIDEO_REMOTE_LOST'), { status: 404 }));
    await service.poll();
    expect(service.job(job.id, 'conversation').status).toBe('failed');
  });
});
