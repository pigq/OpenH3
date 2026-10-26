import { useCallback, useSyncExternalStore } from 'react';
import { templateSnapshotSchema, type TemplateSnapshot } from '@/common/contentCatalog/snapshot';

const STORAGE_KEY = 'openh3.guid-draft.v1';
const SCOPE_STORAGE_KEY = `${STORAGE_KEY}.scope`;
const isDesktopRuntime = typeof window !== 'undefined' && Boolean(window.electronAPI);
let owner: string | null = isDesktopRuntime ? 'desktop' : null;
let lastOwner = owner;
const scopeSession = Math.random().toString(36).slice(2);
let generation = 0;
let mayRestoreScope = true;
const createScope = (): string | null => {
  if (!owner) return null;
  let token: string | undefined;
  if (mayRestoreScope) {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(SCOPE_STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        const value = saved as { owner?: unknown; token?: unknown };
        if (value.owner === owner && typeof value.token === 'string' && value.token) token = value.token;
      }
    } catch {
      /* An unavailable or malformed session record starts a fresh generation. */
    }
  }
  mayRestoreScope = false;
  token ??= `${owner}:${scopeSession}:${++generation}`;
  try {
    sessionStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify({ owner, token }));
  } catch {
    /* The in-memory scope still protects asynchronous work when storage is disabled. */
  }
  return token;
};
const invalidateScope = () => {
  // Only a cold startup may restore a token, never a runtime detach or explicit reset.
  mayRestoreScope = false;
  try {
    sessionStorage.removeItem(SCOPE_STORAGE_KEY);
  } catch {
    /* A failed removal must not reopen the in-memory restoration gate. */
  }
};
let scope = createScope();
let draft = '';
let templateSnapshot: TemplateSnapshot | undefined;
const listeners = new Set<() => void>();
let state = { draft, scope };
const notify = () => {
  state = { draft, scope };
  for (const listener of listeners) listener();
};
const storageKey = (draftOwner: string) => `${STORAGE_KEY}:${draftOwner}`;
const restore = () => {
  if (!owner) return;
  try {
    // Unowned legacy content belongs only to the desktop single-user runtime.
    const raw =
      localStorage.getItem(storageKey(owner)) ?? (isDesktopRuntime ? localStorage.getItem(STORAGE_KEY) : null);
    const saved: unknown = JSON.parse(raw || 'null');
    const value =
      saved && typeof saved === 'object' ? (saved as { input?: unknown; templateSnapshot?: unknown }) : undefined;
    const input = typeof saved === 'string' ? saved : value?.input;
    if (typeof input === 'string' && input.length <= 131072) draft = input;
    const parsed = templateSnapshotSchema.safeParse(value?.templateSnapshot);
    if (parsed.success) templateSnapshot = parsed.data as TemplateSnapshot;
  } catch {
    /* Storage may be unavailable; the in-memory draft still works. */
  }
};
// Web startup deliberately does not read any content until AuthProvider confirms user.id.
restore();
state = { draft, scope };
const persist = () => {
  if (!owner) return;
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify({ schemaVersion: 1, input: draft, templateSnapshot }));
  } catch {
    /* Quota errors must not discard the current composer. */
  }
};

/** Attach a confirmed Web identity, or detach memory without deleting that owner's saved draft. */
export const setGuidDraftOwner = (userId: string | null): void => {
  if (isDesktopRuntime) return;
  const nextOwner = userId ? `user:${encodeURIComponent(userId)}` : null;
  if (owner === nextOwner) return;
  if (owner) invalidateScope();
  owner = nextOwner;
  scope = createScope();
  if (owner) lastOwner = owner;
  draft = '';
  templateSnapshot = undefined;
  restore();
  notify();
};
export const setGuidTemplateSnapshot = (snapshot?: TemplateSnapshot): void => {
  if (!owner) return;
  templateSnapshot = snapshot ? structuredClone(snapshot) : undefined;
  persist();
};
export const getGuidTemplateSnapshot = (): TemplateSnapshot | undefined =>
  templateSnapshot ? structuredClone(templateSnapshot) : undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => state;
const writeDraft = (next: string) => {
  if (!owner || draft === next) return;
  draft = next;
  if (!next) templateSnapshot = undefined;
  persist();
  notify();
};

/** Capture before starting asynchronous work; detach/reset invalidates the opaque token. */
export const getGuidDraftScope = (): string | null => scope;
/** Only the desktop runtime may consume legacy, unscoped initial messages. */
export const isGuidDraftScopeCurrent = (candidate: unknown): boolean =>
  scope !== null && (candidate === scope || (isDesktopRuntime && candidate === undefined));
/** Release only the prompt acknowledged in the same identity generation, even after navigation. */
export const clearGuidDraftIfMatches = (sent: string, sentScope: string | null): void => {
  if (sentScope !== null && scope === sentScope && draft === sent) writeDraft('');
};
/** Explicit reset deletes only the active (or most recently detached) owner's saved content. */
export const resetGuidDraft = (): void => {
  templateSnapshot = undefined;
  draft = '';
  invalidateScope();
  scope = createScope();
  notify();
  try {
    const draftOwner = owner ?? lastOwner;
    if (draftOwner) localStorage.removeItem(storageKey(draftOwner));
    if (isDesktopRuntime) localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Storage can be disabled. */
  }
};

export const useGuidDraft = () => {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setDraft = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (nextValue) => {
      // A callback retained by an unmounted composer must not edit the next account.
      if (current.scope !== scope) return;
      writeDraft(typeof nextValue === 'function' ? nextValue(draft) : nextValue);
    },
    [current.scope]
  );
  return [current.draft, setDraft] as const;
};
