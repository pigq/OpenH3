import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonMediaJobStore } from '@/process/services/media/JsonMediaJobStore';
import {
  UpdateAdmissionGate,
  acquireUpdateInstallLease,
} from '../../../../packages/desktop/src/process/startup/updateInstallGuard';

describe('update task admission', () => {
  it('expires rollback tombstones only after every accepted acquisition deadline has passed', () => {
    let now = 1000;
    const gate = new UpdateAdmissionGate(() => now);
    const expiresAt = now + 10_000;
    gate.release('old');
    now += 14_000;
    expect(gate.acquire('old', () => true, expiresAt)).toBe(false);
    now += 2000;
    expect(gate.acquire('old', () => true, expiresAt)).toBe(false);
    expect(gate.acquire('old', () => true, now + 10_000)).toBe(true);
    gate.release('old');
    expect(gate.acquire('new', () => true, now + 10_000)).toBe(true);
  });
  it('does not mistake an unreadable media job cache for known idle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-update-idle-'));
    try {
      const filename = path.join(root, 'jobs.json');
      expect(new JsonMediaJobStore(filename).recoveryKnown).toBe(true);
      fs.writeFileSync(filename, '{broken');
      expect(new JsonMediaJobStore(filename).recoveryKnown).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not interrupt an admitted request and permits retry after it settles', () => {
    const gate = new UpdateAdmissionGate();
    const finish = gate.enter();
    expect(finish).not.toBeNull();
    expect(gate.acquire('lease-a', () => true)).toBe(false);
    finish!();
    expect(gate.acquire('lease-b', () => true)).toBe(true);
    expect(gate.enter()).toBeNull();
    gate.release('wrong-owner');
    expect(gate.enter()).toBeNull();
    gate.release('lease-b');
    expect(gate.enter()).not.toBeNull();
  });

  it('keeps admissions open when actual work is busy or unknown', () => {
    const gate = new UpdateAdmissionGate();
    expect(gate.acquire('lease-a', () => false)).toBe(false);
    expect(() =>
      gate.acquire('lease-b', () => {
        throw new Error('unknown');
      })
    ).toThrow('unknown');
    expect(gate.enter()).not.toBeNull();
  });

  it('does not acquire a late response after its caller has rolled back', () => {
    const gate = new UpdateAdmissionGate();
    gate.release('cancelled-attempt');
    expect(gate.acquire('cancelled-attempt', () => true)).toBe(false);
    expect(gate.acquire('fresh-attempt', () => true)).toBe(true);
  });
});

describe('desktop update install lease', () => {
  const endpoints = ['http://127.0.0.1:33000', 'http://127.0.0.1:33002'];

  it('holds both admission gates until explicitly released', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ idle: true }), { status: 200 }));
    const lease = await acquireUpdateInstallLease(endpoints, 'control-token', fetchImpl);
    expect(lease).not.toBeNull();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(endpoints.map((url) => `${url}/api/system/update-lease`));
    const requestIds = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).leaseId);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ 'x-openh3-update-token': 'control-token' });
    await lease!.release();
    expect(fetchImpl.mock.calls.slice(2).map(([, init]) => init?.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('accepts the Core success envelope but never a merely healthy response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { idle: true } })));
    expect(await acquireUpdateInstallLease(endpoints, 'control-token', fetchImpl)).not.toBeNull();
  });

  it.each(['busy', 'unknown', 'timeout'])(
    'releases every possibly acquired gate when a service is %s',
    async (failure) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        if (init?.method === 'DELETE') return new Response('{}');
        if (fetchImpl.mock.calls.length === 1) return new Response(JSON.stringify({ idle: true }));
        if (failure === 'timeout') throw new Error('timeout after server acquired gate');
        return new Response(JSON.stringify(failure === 'busy' ? { idle: false } : { status: 'ok' }));
      });
      expect(await acquireUpdateInstallLease(endpoints, 'control-token', fetchImpl)).toBeNull();
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual([
        `${endpoints[1]}/api/system/update-lease`,
        `${endpoints[0]}/api/system/update-lease`,
      ]);
    }
  );

  it('defers when either service has no known endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await acquireUpdateInstallLease([], 'control-token', fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retires rollback for a confirmed stopped Core rather than retrying its obsolete port', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ idle: true })));
    const lease = await acquireUpdateInstallLease(endpoints, 'stopped-core-token', fetchImpl);
    lease!.retireEndpoint(endpoints[0]);
    await lease!.release();
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual([
      `${endpoints[1]}/api/system/update-lease`,
    ]);
    const next = await acquireUpdateInstallLease(
      ['http://127.0.0.1:33003', endpoints[1]],
      'stopped-core-token',
      fetchImpl
    );
    expect(next).not.toBeNull();
    await next!.release();
  });

  it('retries unconfirmed rollback in the background so recovered services accept work without restart', async () => {
    vi.useFakeTimers();
    const gates = new Map(endpoints.map((endpoint) => [endpoint, new UpdateAdmissionGate()]));
    let reachable = true;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const gate = gates.get(String(url).replace('/api/system/update-lease', ''))!;
      const payload = JSON.parse(String(init?.body));
      if (init?.method === 'DELETE') {
        if (!reachable) throw new Error('local service connection lost');
        gate.release(payload.leaseId);
        return new Response('{}');
      }
      return new Response(JSON.stringify({ idle: gate.acquire(payload.leaseId, () => true, payload.expiresAt) }));
    });
    try {
      const lease = await acquireUpdateInstallLease(endpoints, 'rollback-recovery-token', fetchImpl);
      expect(lease).not.toBeNull();
      reachable = false;
      await lease!.release();
      expect([...gates.values()].every((gate) => gate.enter() === null)).toBe(true);
      reachable = true;
      await vi.advanceTimersByTimeAsync(10_000);
      for (const gate of gates.values()) {
        const finish = gate.enter();
        expect(finish).not.toBeNull();
        finish!();
      }
      const retried = await acquireUpdateInstallLease(endpoints, 'rollback-recovery-token', fetchImpl);
      expect(retried).not.toBeNull();
      await retried!.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
