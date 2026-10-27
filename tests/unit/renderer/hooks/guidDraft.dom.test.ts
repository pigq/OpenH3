import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendInitialMessage } = vi.hoisted(() => ({ sendInitialMessage: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: { acpConversation: { sendMessage: { invoke: sendInitialMessage } } },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type DraftModule = typeof import('@/renderer/pages/guid/hooks/useGuidDraft');
const LEGACY_KEY = 'openh3.guid-draft.v1';
const userKey = (id: string) => `${LEGACY_KEY}:user:${encodeURIComponent(id)}`;
const desktopKey = `${LEGACY_KEY}:desktop`;
const desktopApi = window.electronAPI;
const alice = { id: 'user-a', username: 'Alice' };
const bob = { id: 'user-b', username: 'Bob' };
const snapshot = {
  templateId: 'official:test',
  templateRevision: 1,
  releaseSequence: 2,
  locale: 'en-US',
  title: 'Title',
  prompt: 'Original',
  parameters: { width: 768 },
  requiresReference: false,
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const authenticated = (user = alice) => response({ success: true, user });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function loadModules(web = false) {
  if (web) delete (window as { electronAPI?: unknown }).electronAPI;
  else window.electronAPI = desktopApi;
  vi.resetModules();
  const draft = await import('@/renderer/pages/guid/hooks/useGuidDraft');
  const auth = await import('@/renderer/hooks/context/AuthContext');
  return { draft, auth };
}
async function renderWeb(fetchMock = vi.fn().mockResolvedValue(authenticated())) {
  vi.stubGlobal('fetch', fetchMock);
  const { draft, auth } = await loadModules(true);
  const hook = renderHook(() => ({ auth: auth.useAuth(), draft: draft.useGuidDraft() }), {
    wrapper: ({ children }) => React.createElement(auth.AuthProvider, null, children),
  });
  await waitFor(() => expect(hook.result.current.auth.status).toBe('authenticated'));
  return { draft, hook, fetchMock };
}
function saveDraft(draft: DraftModule, setter: React.Dispatch<React.SetStateAction<string>>, input = 'Alice draft') {
  act(() => {
    setter(input);
    draft.setGuidTemplateSnapshot(snapshot);
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sendInitialMessage.mockReset();
  document.cookie = 'aionui-csrf-token=; Max-Age=0; Path=/';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.electronAPI = desktopApi;
});

describe('useGuidDraft (desktop single-user scope)', () => {
  it('restores legacy text only on desktop and reloads its independent persisted template copy', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify('Legacy draft'));
    const { draft } = await loadModules();
    const hook = renderHook(() => draft.useGuidDraft());
    expect(hook.result.current[0]).toBe('Legacy draft');
    act(() => draft.setGuidTemplateSnapshot(snapshot));
    hook.unmount();
    const { draft: again } = await loadModules();
    expect(again.getGuidTemplateSnapshot()?.prompt).toBe('Original');
    expect(localStorage.getItem(desktopKey)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(desktopKey)!).input).toBe('Legacy draft');
    again.resetGuidDraft();
    expect(localStorage.getItem(desktopKey)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('restores the legacy draft object with its template snapshot on desktop', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ input: 'Legacy object', templateSnapshot: snapshot }));
    const { draft } = await loadModules();
    const hook = renderHook(() => draft.useGuidDraft());
    expect(hook.result.current[0]).toBe('Legacy object');
    expect(draft.getGuidTemplateSnapshot()).toEqual(snapshot);
  });

  it('persists an independent template revision and clears both on reset', async () => {
    const { draft } = await loadModules();
    const hook = renderHook(() => draft.useGuidDraft());
    const template = structuredClone(snapshot);
    saveDraft(draft, hook.result.current[1], 'Editable prompt');
    act(() => draft.setGuidTemplateSnapshot(template));
    template.parameters.width = 1;
    expect(draft.getGuidTemplateSnapshot()?.parameters.width).toBe(768);
    act(() => hook.result.current[1]('Edited prompt'));
    expect(localStorage.getItem(desktopKey)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(desktopKey)!).templateSnapshot.prompt).toBe('Original');
    act(() => draft.clearGuidDraftIfMatches('Edited prompt', draft.getGuidDraftScope()));
    expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
    draft.resetGuidDraft();
    expect(localStorage.getItem(desktopKey)).toBeNull();
  });

  it('clears the sent draft after navigation has unmounted its composer', async () => {
    const { draft } = await loadModules();
    const first = renderHook(() => draft.useGuidDraft());
    act(() => first.result.current[1]('Sent prompt'));
    const staleSetter = first.result.current[1];
    first.unmount();
    act(() => staleSetter(''));
    const second = renderHook(() => draft.useGuidDraft());
    expect(second.result.current[0]).toBe('');
  });

  it('does not discard a newer draft when an earlier send is acknowledged', async () => {
    const { draft } = await loadModules();
    const hook = renderHook(() => draft.useGuidDraft());
    act(() => hook.result.current[1]('New draft'));
    act(() => draft.clearGuidDraftIfMatches('Earlier send', draft.getGuidDraftScope()));
    expect(hook.result.current[0]).toBe('New draft');
    act(() => draft.clearGuidDraftIfMatches('New draft', draft.getGuidDraftScope()));
    expect(hook.result.current[0]).toBe('');
  });

  it('keeps the new-chat draft across composer remounts', async () => {
    const { draft } = await loadModules();
    const first = renderHook(() => draft.useGuidDraft());
    act(() => first.result.current[1]('A prompt I am still working on'));
    first.unmount();
    const second = renderHook(() => draft.useGuidDraft());
    expect(second.result.current[0]).toBe('A prompt I am still working on');
  });
});

describe('pending initial-message scope across reloads', () => {
  it.each([false, true])('preserves a confirmed owner pending message after a module reload (web=%s)', async (web) => {
    const { draft } = await loadModules(web);
    if (web) draft.setGuidDraftOwner(alice.id);
    const composer = renderHook(() => draft.useGuidDraft());
    saveDraft(draft, composer.result.current[1], 'Pending prompt');
    const pending = { input: 'Pending prompt', guidDraft: 'Pending prompt', guidDraftScope: draft.getGuidDraftScope() };
    sessionStorage.setItem('acp_initial_message_pending', JSON.stringify(pending));
    // A browser reload creates fresh modules, not an explicit AuthProvider detach.
    composer.unmount();
    const { draft: reloaded, auth } = await loadModules(web);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => authenticated())
    );
    const restored = renderHook(() => ({ auth: auth.useAuth(), draft: reloaded.useGuidDraft() }), {
      wrapper: ({ children }) =>
        React.createElement(React.StrictMode, null, React.createElement(auth.AuthProvider, null, children)),
    });
    await waitFor(() => expect(restored.result.current.auth.status).toBe('authenticated'));

    const message = JSON.parse(sessionStorage.getItem('acp_initial_message_pending')!);
    expect(reloaded.isGuidDraftScopeCurrent(message.guidDraftScope)).toBe(true);
    expect(restored.result.current.draft[0]).toBe('Pending prompt');
    expect(reloaded.getGuidTemplateSnapshot()).toEqual(snapshot);
    const acknowledge = deferred<{ turn_id: string; runtime: object }>();
    sendInitialMessage.mockReturnValueOnce(acknowledge.promise);
    const { useAcpInitialMessage } = await import('@/renderer/pages/conversation/platforms/acp/useAcpInitialMessage');
    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'pending',
        backend: 'codex',
        setAiProcessing: vi.fn(),
        resetState: vi.fn(),
        checkAndUpdateTitle: vi.fn(),
        addOrUpdateMessage: vi.fn(),
      })
    );
    await waitFor(() =>
      expect(sendInitialMessage).toHaveBeenCalledExactlyOnceWith({
        input: 'Pending prompt',
        conversation_id: 'pending',
        files: [],
      })
    );
    expect(sessionStorage.getItem('acp_initial_message_pending')).toBeNull();
    expect(restored.result.current.draft[0]).toBe('Pending prompt');
    expect(reloaded.getGuidTemplateSnapshot()).toEqual(snapshot);
    await act(async () => acknowledge.resolve({ turn_id: 'turn-pending', runtime: {} }));
    expect(restored.result.current.draft[0]).toBe('');
    expect(reloaded.getGuidTemplateSnapshot()).toBeUndefined();
  });

  it('rejects the previous account pending message after a reload authenticates another account', async () => {
    const { draft } = await loadModules(true);
    draft.setGuidDraftOwner(alice.id);
    const pendingScope = draft.getGuidDraftScope();
    const { draft: reloaded, hook } = await renderWeb(vi.fn().mockResolvedValue(authenticated(bob)));
    expect(hook.result.current.auth.user?.id).toBe(bob.id);
    expect(reloaded.isGuidDraftScopeCurrent(pendingScope)).toBe(false);
  });

  it('does not revive an earlier token after detach, same-owner reattach, and reload', async () => {
    const { draft } = await loadModules(true);
    draft.setGuidDraftOwner(alice.id);
    const pendingScope = draft.getGuidDraftScope();
    draft.setGuidDraftOwner(null);
    draft.setGuidDraftOwner(alice.id);
    const currentScope = draft.getGuidDraftScope();
    expect(currentScope).not.toBe(pendingScope);
    const { draft: reloaded } = await renderWeb();
    expect(reloaded.isGuidDraftScopeCurrent(pendingScope)).toBe(false);
    expect(reloaded.isGuidDraftScopeCurrent(currentScope)).toBe(true);
  });

  it.each([false, true])('preserves only the reset generation across reload (web=%s)', async (web) => {
    const { draft } = await loadModules(web);
    if (web) draft.setGuidDraftOwner(alice.id);
    const pendingScope = draft.getGuidDraftScope();
    draft.resetGuidDraft();
    const resetScope = draft.getGuidDraftScope();
    const { draft: reloaded } = await loadModules(web);
    if (web) reloaded.setGuidDraftOwner(alice.id);
    expect(reloaded.isGuidDraftScopeCurrent(pendingScope)).toBe(false);
    expect(reloaded.isGuidDraftScopeCurrent(resetScope)).toBe(true);
  });

  it('invalidates a saved token when explicitly reset before cold startup confirms an owner', async () => {
    const { draft } = await loadModules(true);
    draft.setGuidDraftOwner(alice.id);
    const pendingScope = draft.getGuidDraftScope();
    const { draft: reloaded } = await loadModules(true);
    reloaded.resetGuidDraft();
    reloaded.setGuidDraftOwner(alice.id);
    expect(reloaded.isGuidDraftScopeCurrent(pendingScope)).toBe(false);
    expect(reloaded.getGuidDraftScope()).not.toBeNull();
  });

  it('keeps the draft usable and rejects detached tokens when session storage operations fail', async () => {
    const { getItem, setItem, removeItem } = Storage.prototype;
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (this === sessionStorage) throw new Error('Storage unavailable');
      return getItem.call(this, key);
    });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === sessionStorage) throw new Error('Storage unavailable');
      setItem.call(this, key, value);
    });
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
      if (this === sessionStorage) throw new Error('Storage unavailable');
      removeItem.call(this, key);
    });
    const { draft } = await loadModules(true);
    draft.setGuidDraftOwner(alice.id);
    const pendingScope = draft.getGuidDraftScope();
    draft.setGuidDraftOwner(null);
    draft.setGuidDraftOwner(alice.id);
    const hook = renderHook(() => draft.useGuidDraft());
    saveDraft(draft, hook.result.current[1], 'Still editable');
    expect(hook.result.current[0]).toBe('Still editable');
    expect(draft.getGuidTemplateSnapshot()).toEqual(snapshot);
    expect(draft.isGuidDraftScopeCurrent(pendingScope)).toBe(false);
    expect(draft.isGuidDraftScopeCurrent(draft.getGuidDraftScope())).toBe(true);
    expect(read).toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });
});

describe('Web draft identity with the real AuthProvider', () => {
  it('never loads unowned legacy or account storage into memory at cold startup', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ input: 'Legacy secret', templateSnapshot: snapshot }));
    localStorage.setItem(userKey(alice.id), JSON.stringify({ input: 'Alice secret', templateSnapshot: snapshot }));
    const readStorage = vi.spyOn(Storage.prototype, 'getItem');
    const { draft, auth } = await loadModules(true);
    expect(readStorage).not.toHaveBeenCalled();
    const first = renderHook(() => draft.useGuidDraft());
    expect(first.result.current[0]).toBe('');
    expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
    act(() => {
      first.result.current[1]('Unconfirmed edit');
      draft.setGuidTemplateSnapshot(snapshot);
    });
    expect(first.result.current[0]).toBe('');
    expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
    const check = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(check.promise));
    const hook = renderHook(() => ({ auth: auth.useAuth(), draft: draft.useGuidDraft() }), {
      wrapper: ({ children }) => React.createElement(auth.AuthProvider, null, children),
    });
    expect(hook.result.current.auth.status).toBe('checking');
    expect(hook.result.current.draft[0]).toBe('');
    expect(readStorage).not.toHaveBeenCalled();
    await act(async () => {
      check.resolve(response({ success: false }, 403));
    });
    expect(hook.result.current.auth.status).toBe('unauthenticated');
    expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
  });

  it('detaches during refresh and session expiry, then restores only the successfully logged-in owner', async () => {
    const { draft, hook, fetchMock } = await renderWeb();
    saveDraft(draft, hook.result.current.draft[1]);
    const saved = localStorage.getItem(userKey(alice.id));
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).templateSnapshot).toEqual(snapshot);
    const check = deferred<Response>();
    fetchMock.mockReturnValueOnce(check.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = hook.result.current.auth.refresh();
    });
    expect(hook.result.current.auth.status).toBe('checking');
    expect(hook.result.current.draft[0]).toBe('');
    expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
    fetchMock.mockResolvedValueOnce(response({ success: false }, 401));
    await act(async () => {
      check.resolve(response({ success: false }, 401));
      await refreshing;
    });
    expect(hook.result.current.auth.status).toBe('unauthenticated');
    expect(localStorage.getItem(userKey(alice.id))).toBe(saved);
    fetchMock.mockResolvedValueOnce(authenticated(bob));
    await act(async () => {
      expect(await hook.result.current.auth.login({ username: 'Bob', password: 'pw' })).toEqual({ success: true });
    });
    expect(hook.result.current.auth.user?.id).toBe(bob.id);
    expect(hook.result.current.draft[0]).toBe('');
    expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
    saveDraft(draft, hook.result.current.draft[1], 'Bob draft');
    expect(localStorage.getItem(userKey(alice.id))).toBe(saved);
    expect(JSON.parse(localStorage.getItem(userKey(bob.id))!).input).toBe('Bob draft');
  });

  it.each(['refresh', 'login'] as const)(
    'preserves storage on a transient network failure and restores the same user via %s',
    async (reauthenticate) => {
      const { draft, hook, fetchMock } = await renderWeb();
      saveDraft(draft, hook.result.current.draft[1]);
      const saved = localStorage.getItem(userKey(alice.id));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      await act(async () => {
        await hook.result.current.auth.refresh();
      });
      expect(hook.result.current.auth.status).toBe('unauthenticated');
      expect(hook.result.current.draft[0]).toBe('');
      expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
      expect(localStorage.getItem(userKey(alice.id))).toBe(saved);
      fetchMock.mockResolvedValueOnce(authenticated());
      await act(async () => {
        if (reauthenticate === 'login') await hook.result.current.auth.login({ username: 'Alice', password: 'pw' });
        else await hook.result.current.auth.refresh();
      });
      expect(hook.result.current.draft[0]).toBe('Alice draft');
      expect(draft.getGuidTemplateSnapshot()).toEqual(snapshot);
    }
  );

  it('does not revive an aborted refresh identity after another user logs in', async () => {
    const { draft, hook, fetchMock } = await renderWeb();
    saveDraft(draft, hook.result.current.draft[1]);
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = hook.result.current.auth.refresh();
    });
    fetchMock.mockResolvedValueOnce(authenticated(bob));
    await act(async () => {
      await hook.result.current.auth.login({ username: 'Bob', password: 'pw' });
    });
    await act(async () => {
      old.resolve(authenticated());
      await refreshing;
    });
    expect(hook.result.current.auth.user?.id).toBe(bob.id);
    expect(hook.result.current.draft[0]).toBe('');
    expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
  });

  it('ignores an earlier refresh that resolves after a newer refresh', async () => {
    const { hook, fetchMock } = await renderWeb();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = hook.result.current.auth.refresh();
    });
    fetchMock.mockResolvedValueOnce(authenticated(bob));
    await act(async () => {
      await hook.result.current.auth.refresh();
    });
    await act(async () => {
      old.resolve(authenticated());
      await refreshing;
    });
    expect(hook.result.current.auth.user?.id).toBe(bob.id);
  });

  it('does not refresh cookies for a superseded identity after a late 401 response', async () => {
    const { hook, fetchMock } = await renderWeb();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = hook.result.current.auth.refresh();
    });
    fetchMock.mockResolvedValueOnce(authenticated(bob));
    await act(async () => {
      await hook.result.current.auth.login({ username: 'Bob', password: 'pw' });
    });
    await act(async () => {
      old.resolve(response({ success: false }, 401));
      await refreshing;
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(hook.result.current.auth.user?.id).toBe(bob.id);
  });

  it('does not let an old composer setter edit the next user draft', async () => {
    const { draft, hook, fetchMock } = await renderWeb();
    saveDraft(draft, hook.result.current.draft[1]);
    const staleSetter = hook.result.current.draft[1];
    fetchMock.mockResolvedValueOnce(authenticated(bob));
    await act(async () => {
      await hook.result.current.auth.login({ username: 'Bob', password: 'pw' });
    });
    act(() => staleSetter('Alice late update'));
    expect(hook.result.current.draft[0]).toBe('');
    expect(localStorage.getItem(userKey(bob.id))).toBeNull();
  });

  it.each([alice, bob])(
    'does not clear a same-text draft after a new identity generation for $username',
    async (nextUser) => {
      const { draft, hook, fetchMock } = await renderWeb();
      saveDraft(draft, hook.result.current.draft[1], 'Same prompt');
      const sentScope = draft.getGuidDraftScope();
      fetchMock.mockResolvedValueOnce(authenticated(nextUser));
      await act(async () => {
        await hook.result.current.auth.login({ username: nextUser.username, password: 'pw' });
      });
      saveDraft(draft, hook.result.current.draft[1], 'Same prompt');
      act(() => draft.clearGuidDraftIfMatches('Same prompt', sentScope));
      expect(hook.result.current.draft[0]).toBe('Same prompt');
      expect(draft.getGuidTemplateSnapshot()).toEqual(snapshot);
    }
  );

  it('does not let an obsolete login error reset the current account draft', async () => {
    const { draft, hook, fetchMock } = await renderWeb();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    let loggingIn!: ReturnType<typeof hook.result.current.auth.login>;
    act(() => {
      loggingIn = hook.result.current.auth.login({ username: 'Alice', password: 'pw' });
    });
    fetchMock.mockResolvedValueOnce(authenticated(bob));
    await act(async () => {
      await hook.result.current.auth.login({ username: 'Bob', password: 'pw' });
    });
    saveDraft(draft, hook.result.current.draft[1], 'Bob draft');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      old.reject(new Error('cookie parse failed'));
      await loggingIn;
    });
    expect(hook.result.current.auth.user?.id).toBe(bob.id);
    expect(hook.result.current.draft[0]).toBe('Bob draft');
    expect(draft.getGuidTemplateSnapshot()).toEqual(snapshot);
  });

  it.each(['403', 'parse', 'csrf', 'cookie'])(
    'preserves the detached account draft when another account login fails with %s',
    async (failure) => {
      const { draft, hook, fetchMock } = await renderWeb();
      saveDraft(draft, hook.result.current.draft[1]);
      const saved = localStorage.getItem(userKey(alice.id));
      localStorage.setItem('auth-stale', 'expired');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      if (failure === '403') fetchMock.mockResolvedValueOnce(response({ success: false }, 403));
      else {
        const failedResponse = authenticated(bob);
        vi.spyOn(failedResponse, 'json').mockRejectedValueOnce(new Error(`${failure} failed`));
        fetchMock.mockResolvedValueOnce(failedResponse);
      }
      await act(async () => {
        expect(await hook.result.current.auth.login({ username: 'Bob', password: 'pw' })).toMatchObject({
          success: false,
          code: 'csrfError',
          shouldClearCache: true,
        });
      });
      expect(hook.result.current.auth.status).toBe('unauthenticated');
      expect(hook.result.current.draft[0]).toBe('');
      expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
      expect(localStorage.getItem('auth-stale')).toBeNull();
      expect(localStorage.getItem(userKey(alice.id))).toBe(saved);
      fetchMock.mockResolvedValueOnce(authenticated());
      await act(async () => {
        await hook.result.current.auth.login({ username: 'Alice', password: 'pw' });
      });
      expect(hook.result.current.draft[0]).toBe('Alice draft');
      expect(draft.getGuidTemplateSnapshot()).toEqual(snapshot);
    }
  );

  it('restores account storage only after user.id is confirmed', async () => {
    localStorage.setItem(userKey(alice.id), JSON.stringify({ input: 'Saved Alice', templateSnapshot: snapshot }));
    const { draft, hook } = await renderWeb();
    expect(hook.result.current.draft[0]).toBe('Saved Alice');
    expect(draft.getGuidTemplateSnapshot()).toEqual(snapshot);
  });

  it('sends the real Core CSRF header and deletes only the logged-out owner draft', async () => {
    const { draft, hook, fetchMock } = await renderWeb();
    saveDraft(draft, hook.result.current.draft[1]);
    localStorage.setItem(userKey('auth-b'), JSON.stringify({ input: 'Other account' }));
    document.cookie = 'aionui-csrf-token=core-csrf; Path=/';
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    await act(async () => {
      await hook.result.current.auth.logout();
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ 'x-csrf-token': 'core-csrf' }),
      })
    );
    expect(hook.result.current.auth.status).toBe('unauthenticated');
    expect(hook.result.current.draft[0]).toBe('');
    expect(draft.getGuidTemplateSnapshot()).toBeUndefined();
    expect(localStorage.getItem(userKey(alice.id))).toBeNull();
    expect(localStorage.getItem(userKey('auth-b'))).not.toBeNull();
  });

  it.each([403, 500])(
    'rejects HTTP %s logout without pretending the session ended or deleting the draft',
    async (status) => {
      const { draft, hook, fetchMock } = await renderWeb();
      saveDraft(draft, hook.result.current.draft[1]);
      fetchMock.mockResolvedValueOnce(response({ success: false }, status));
      await act(async () => {
        await expect(hook.result.current.auth.logout()).rejects.toThrow();
      });
      expect(hook.result.current.auth.status).toBe('authenticated');
      expect(hook.result.current.draft[0]).toBe('Alice draft');
      expect(draft.getGuidTemplateSnapshot()).toEqual(snapshot);
      expect(localStorage.getItem(userKey(alice.id))).not.toBeNull();
    }
  );

  it('rejects a failed logout network request without erasing the owner', async () => {
    const { draft, hook, fetchMock } = await renderWeb();
    saveDraft(draft, hook.result.current.draft[1]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await expect(hook.result.current.auth.logout()).rejects.toThrow('offline');
    });
    expect(hook.result.current.auth.user?.id).toBe(alice.id);
    expect(hook.result.current.draft[0]).toBe('Alice draft');
  });

  it('explicit cache reset deletes the corresponding storage even after detach', async () => {
    const { draft, hook, fetchMock } = await renderWeb();
    saveDraft(draft, hook.result.current.draft[1]);
    expect(localStorage.getItem(userKey(alice.id))).not.toBeNull();
    fetchMock.mockResolvedValueOnce(response({ success: false }, 403));
    await act(async () => {
      await hook.result.current.auth.refresh();
    });
    act(() => hook.result.current.auth.clearAuthCache());
    expect(localStorage.getItem(userKey(alice.id))).toBeNull();
  });

  it('desktop logout resets its single-user storage without a Web logout request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { draft, auth } = await loadModules();
    const hook = renderHook(() => ({ auth: auth.useAuth(), draft: draft.useGuidDraft() }), {
      wrapper: ({ children }) => React.createElement(auth.AuthProvider, null, children),
    });
    saveDraft(draft, hook.result.current.draft[1]);
    await act(async () => {
      await hook.result.current.auth.logout();
    });
    expect(hook.result.current.auth.status).toBe('authenticated');
    expect(hook.result.current.draft[0]).toBe('');
    expect(localStorage.getItem(desktopKey)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
