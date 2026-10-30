import { randomUUID } from 'node:crypto';

/** A synchronous admission fence: existing work is never cancelled or drained. */
export class UpdateAdmissionGate {
  private requests = 0;
  private owner: string | null = null;
  private readonly cancelled = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    for (const [id, expiresAt] of this.cancelled) if (expiresAt <= this.now()) this.cancelled.delete(id);
  }

  enter(): (() => void) | null {
    if (this.owner) return null;
    this.requests += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.requests -= 1;
    };
  }

  acquire(leaseId: string, idle: () => boolean, expiresAt = this.now() + 10_000): boolean {
    this.prune();
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.now() ||
      expiresAt > this.now() + 15_000 ||
      this.cancelled.has(leaseId) ||
      this.owner ||
      this.requests ||
      !idle()
    )
      return false;
    this.owner = leaseId;
    return true;
  }

  release(leaseId: string): void {
    this.prune();
    // The caller's acquisition deadline is at most 15s ahead. Expired POSTs
    // are rejected independently, so old tombstones can be safely collected.
    this.cancelled.set(leaseId, this.now() + 15_000);
    if (this.owner === leaseId) this.owner = null;
  }
}

type PendingRollback = { retry: () => Promise<void>; retire: (endpoint: string) => void };
const pendingRollbacks = new Map<string, PendingRollback>();

/** Acquire both services' fences, including rollback for a lost HTTP response. */
export async function acquireUpdateInstallLease(
  endpoints: string[],
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ release: () => Promise<void>; retireEndpoint: (endpoint: string) => void } | null> {
  if (endpoints.length !== 2 || !token) return null;
  await Promise.all([...pendingRollbacks.values()].map((rollback) => rollback.retry()));
  if (pendingRollbacks.size) return null;
  const leaseId = randomUUID();
  const expiresAt = Date.now() + 10_000;
  const attempted: string[] = [];
  const retired = new Set<string>();
  const request = (endpoint: string, method: 'POST' | 'DELETE') =>
    fetchImpl(`${endpoint}/api/system/update-lease`, {
      method,
      headers: { 'content-type': 'application/json', 'x-openh3-update-token': token },
      body: JSON.stringify({ leaseId, expiresAt }),
      signal: AbortSignal.timeout(5000),
    });
  let rollback: PendingRollback | undefined;
  const release = () => {
    if (rollback) return rollback.retry();
    const remaining = new Set(attempted.toReversed().filter((endpoint) => !retired.has(endpoint)));
    let running: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    rollback = {
      retire: (endpoint) => {
        remaining.delete(endpoint);
        if (!remaining.size) {
          clearTimeout(timer);
          pendingRollbacks.delete(leaseId);
        }
      },
      retry: () => {
        if (running) return running;
        clearTimeout(timer);
        running = (async () => {
          for (const endpoint of remaining) {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                if ((await request(endpoint, 'DELETE')).ok) {
                  remaining.delete(endpoint);
                  break;
                }
              } catch {
                /* Retain the same rollback obligation until confirmed. */
              }
            }
          }
        })().finally(() => {
          running = undefined;
          if (!remaining.size) pendingRollbacks.delete(leaseId);
          else {
            timer = setTimeout(() => {
              void rollback!.retry();
            }, 10_000);
            timer.unref?.();
          }
        });
        return running;
      },
    };
    pendingRollbacks.set(leaseId, rollback);
    return rollback.retry();
  };
  try {
    for (const endpoint of endpoints) {
      attempted.push(endpoint);
      const response = await request(endpoint, 'POST');
      const status = (await response.json()) as { idle?: unknown; data?: { idle?: unknown } };
      if (!response.ok || (status.data?.idle ?? status.idle) !== true) {
        await release();
        return null;
      }
    }
    return {
      release,
      retireEndpoint: (endpoint) => {
        // Only the owner that has confirmed this child exited may retire its gate.
        retired.add(endpoint);
        rollback?.retire(endpoint);
      },
    };
  } catch {
    await release();
    return null;
  }
}
