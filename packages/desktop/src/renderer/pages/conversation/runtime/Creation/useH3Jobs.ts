import type { H3Job } from '@/common/chat/document/h3Job';
import { h3JobApi } from '@/common/chat/document/h3JobApi';
import { useMemo, useSyncExternalStore } from 'react';

type JobSnapshot = { job?: H3Job; unavailable: boolean };
type JobEntry = {
  id: string;
  snapshot: JobSnapshot;
  listeners: Set<() => void>;
  stop?: () => void;
};
const entries = new Map<string, JobEntry>();
const settled = (job?: H3Job): boolean => !!job && !['queued', 'running'].includes(job.status) && !job.remoteUncertain;

function entryFor(id: string): JobEntry {
  let entry = entries.get(id);
  if (!entry) {
    entry = { id, snapshot: { unavailable: false }, listeners: new Set() };
    entries.set(id, entry);
  }
  return entry;
}

function publish(entry: JobEntry, snapshot: JobSnapshot): void {
  entry.snapshot = snapshot;
  if (settled(snapshot.job)) {
    entry.stop?.();
    entry.stop = undefined;
  }
  for (const listener of entry.listeners) listener();
}

function start(entry: JobEntry): void {
  if (entry.stop || settled(entry.snapshot.job)) return;
  let disposed = false;
  let refreshing = false;
  let source: EventSource | undefined;
  const update = (job: H3Job): void => {
    if (disposed || job.id !== entry.id || settled(entry.snapshot.job)) return;
    publish(entry, { job, unavailable: false });
  };
  const refresh = (): void => {
    if (disposed || refreshing || settled(entry.snapshot.job)) return;
    refreshing = true;
    const requestedSnapshot = entry.snapshot;
    void h3JobApi
      .get(entry.id)
      .then((job) => {
        // A slow HTTP snapshot must not overwrite newer streamed progress.
        if (entry.snapshot === requestedSnapshot) update(job);
      })
      .catch(() => {
        if (!disposed && entry.snapshot === requestedSnapshot && !settled(entry.snapshot.job))
          publish(entry, { ...entry.snapshot, unavailable: true });
      })
      .finally(() => {
        refreshing = false;
      });
  };
  const timer = setInterval(refresh, 15000);
  entry.stop = () => {
    disposed = true;
    clearInterval(timer);
    source?.close();
  };
  try {
    source = h3JobApi.events(entry.id, update);
    source.onerror = () => {
      if (disposed || settled(entry.snapshot.job)) return;
      publish(entry, { ...entry.snapshot, unavailable: true });
      refresh();
    };
  } catch {
    // Hosts without EventSource still receive bounded HTTP polling.
    publish(entry, { ...entry.snapshot, unavailable: true });
  }
  refresh();
}

function observe(entry: JobEntry, listener: () => void): () => void {
  entry.listeners.add(listener);
  start(entry);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      entry.stop?.();
      entry.stop = undefined;
    }
    // Retain recent snapshots across streamed message anchor changes, with a
    // bounded cache. Active observers are never evicted.
    for (const [id, cached] of entries) {
      if (entries.size <= 100) break;
      if (!cached.listeners.size) entries.delete(id);
    }
  };
}

/** Share one live subscription per job between the chat result and work panel. */
export function useH3Jobs(ids: string[]): JobSnapshot[] {
  const key = ids.join(',');
  const store = useMemo(() => {
    const watched = key ? key.split(',') : [];
    let previous = watched.map((id) => entryFor(id).snapshot);
    return {
      subscribe: (listener: () => void) => {
        const disposers = watched.map((id) => observe(entryFor(id), listener));
        return () => disposers.forEach((dispose) => dispose());
      },
      snapshot: () => {
        if (watched.some((id, index) => previous[index] !== entryFor(id).snapshot))
          previous = watched.map((id) => entryFor(id).snapshot);
        return previous;
      },
    };
  }, [key]);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** Feed authoritative cancellation responses into all observers immediately. */
export function updateH3Job(job: H3Job): void {
  const entry = entryFor(job.id);
  if (!settled(entry.snapshot.job)) publish(entry, { job, unavailable: false });
}

export function resetH3JobsForTest(): void {
  for (const entry of entries.values()) entry.stop?.();
  entries.clear();
}
