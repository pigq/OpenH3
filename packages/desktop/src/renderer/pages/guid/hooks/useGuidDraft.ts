import { useCallback, useSyncExternalStore } from 'react';
import { templateSnapshotSchema, type TemplateSnapshot } from '@/common/contentCatalog/snapshot';

let draft = '';
let templateSnapshot: TemplateSnapshot | undefined;
const STORAGE_KEY = 'openh3.guid-draft.v1';
try {
  const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  const value =
    saved && typeof saved === 'object' ? (saved as { input?: unknown; templateSnapshot?: unknown }) : undefined;
  const input = typeof saved === 'string' ? saved : value?.input;
  if (typeof input === 'string' && input.length <= 131072) draft = input;
  const parsed = templateSnapshotSchema.safeParse(value?.templateSnapshot);
  if (parsed.success) templateSnapshot = parsed.data as TemplateSnapshot;
} catch {
  /* Storage may be unavailable; the in-memory draft still works. */
}
const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, input: draft, templateSnapshot }));
  } catch {
    /* Quota errors must not discard the current composer. */
  }
};
export const setGuidTemplateSnapshot = (snapshot?: TemplateSnapshot): void => {
  templateSnapshot = snapshot ? structuredClone(snapshot) : undefined;
  persist();
};
export const getGuidTemplateSnapshot = (): TemplateSnapshot | undefined =>
  templateSnapshot ? structuredClone(templateSnapshot) : undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => draft;
const writeDraft = (next: string) => {
  if (draft === next) return;
  draft = next;
  if (!next) templateSnapshot = undefined;
  persist();
  for (const listener of listeners) listener();
};

/** Release only the prompt acknowledged by the backend, even after navigation. */
export const clearGuidDraftIfMatches = (sent: string): void => {
  if (draft === sent) writeDraft('');
};
/** Remove account-scoped in-memory state as well as the persisted copy on logout. */
export const resetGuidDraft = (): void => {
  templateSnapshot = undefined;
  writeDraft('');
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Storage can be disabled. */
  }
};

export const useGuidDraft = () => {
  const content = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setDraft = useCallback<React.Dispatch<React.SetStateAction<string>>>((nextValue) => {
    writeDraft(typeof nextValue === 'function' ? nextValue(draft) : nextValue);
  }, []);
  return [content, setDraft] as const;
};
