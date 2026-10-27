import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PREVIEW_SCOPE_KEY_PREFIX } from '@/renderer/pages/conversation/Preview/context/previewScope';
import { refreshSession } from '@/common/adapter/sessionRefresh';
import { resetGuidDraft, setGuidDraftOwner } from '@/renderer/pages/guid/hooks/useGuidDraft';
import { resolveCoreCsrfToken } from '@/common/adapter/httpBridge';
const CSRF_COOKIE_NAME = 'aionui-csrf-token';

type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

export interface AuthUser {
  id: string;
  username: string;
}

interface LoginParams {
  username: string;
  password: string;
  remember?: boolean;
}

type LoginErrorCode =
  | 'invalidCredentials'
  | 'tooManyAttempts'
  | 'serverError'
  | 'networkError'
  | 'csrfError'
  | 'unknown';

interface LoginResult {
  success: boolean;
  message?: string;
  code?: LoginErrorCode;
  shouldClearCache?: boolean;
}

interface AuthContextValue {
  ready: boolean;
  user: AuthUser | null;
  status: AuthStatus;
  login: (params: LoginParams) => Promise<LoginResult>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearAuthCache: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const AUTH_USER_ENDPOINT = '/api/auth/user';

const isDesktopRuntime = typeof window !== 'undefined' && Boolean(window.electronAPI);

// Clear expired auth cache including cookies and localStorage
// 清除过期的认证缓存，包括 Cookie 和 localStorage
function clearCachedAuthState(): void {
  if (typeof window === 'undefined') return;

  try {
    // Clear CSRF cookie
    document.cookie = `${CSRF_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;

    // Clear localStorage auth-related items, plus per-user UI state that must not
    // leak across accounts. Preview scopes are keyed by project id and hold file
    // content, so leaving them behind would show the next user the previous one's
    // open tabs — and nothing else ever cleaned them up.
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        !key.startsWith('openh3.guid-draft.v1') &&
        (key.includes('auth') ||
          key.includes('csrf') ||
          key.includes('token') ||
          key.startsWith(PREVIEW_SCOPE_KEY_PREFIX))
      ) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (error) {
    console.error('Failed to clear auth cache:', error);
  }
}

function clearAuthCache(): void {
  if (typeof window === 'undefined') return;
  resetGuidDraft();
  clearCachedAuthState();
}

async function fetchCurrentUser(signal?: AbortSignal): Promise<AuthUser | null> {
  try {
    let response = await fetch(AUTH_USER_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      signal,
    });
    if (signal?.aborted) return null;

    // The access cookie may have expired — attempt one silent session refresh
    // and re-check before concluding the user is unauthenticated. Without this
    // the status poll would kick a refreshable session to /login (#4124).
    // refreshSession() single-flights with the httpBridge refresh path.
    if (response.status === 401) {
      const refreshed = await refreshSession();
      if (signal?.aborted) return null;
      if (refreshed) {
        response = await fetch(AUTH_USER_ENDPOINT, {
          method: 'GET',
          credentials: 'include',
          signal,
        });
      }
    }

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      success: boolean;
      user?: AuthUser;
    };
    if (data.success && data.user) {
      return data.user;
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return null;
    }
    console.error('Failed to fetch current user:', error);
  }

  return null;
}

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [ready, setReady] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (isDesktopRuntime) {
      setStatus('authenticated');
      setUser(null);
      setReady(true);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setGuidDraftOwner(null);
    setUser(null);
    setStatus('checking');

    const currentUser = await fetchCurrentUser(controller.signal);
    if (controller.signal.aborted || abortRef.current !== controller) return;
    setGuidDraftOwner(currentUser?.id ?? null);
    if (currentUser) {
      setUser(currentUser);
      setStatus('authenticated');
    } else {
      setUser(null);
      setStatus('unauthenticated');
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      abortRef.current?.abort();
      setGuidDraftOwner(null);
    };
  }, [refresh]);

  const login = useCallback(async ({ username, password, remember }: LoginParams): Promise<LoginResult> => {
    let controller: AbortController | undefined;
    try {
      if (isDesktopRuntime) {
        setReady(true);
        return { success: true };
      }

      abortRef.current?.abort();
      controller = new AbortController();
      abortRef.current = controller;
      setGuidDraftOwner(null);
      setUser(null);
      setStatus('unauthenticated');
      setReady(true);

      // Core explicitly exempts /login from CSRF double-submit validation.
      // Backend route is /login; web-host's static-server explicitly proxies it.
      const response = await fetch('/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ username, password, remember }),
        signal: controller.signal,
      });

      const data = (await response.json()) as {
        success: boolean;
        message?: string;
        user?: AuthUser;
      };

      if (controller.signal.aborted || abortRef.current !== controller) {
        return { success: false, code: 'unknown' };
      }

      if (!response.ok || !data.success || !data.user) {
        let code: LoginErrorCode = 'unknown';
        let message = data?.message ?? 'Login failed';
        let shouldClearCache = false;

        if (response.status === 401) {
          code = 'invalidCredentials';
        } else if (response.status === 403) {
          // CSRF validation failed - clear cache
          code = 'csrfError';
          message = 'Security token expired. Please try again.';
          shouldClearCache = true;
        } else if (response.status === 429) {
          code = 'tooManyAttempts';
        } else if (response.status >= 500) {
          code = 'serverError';
        }

        // Automatic login recovery must not delete the detached account's saved draft.
        if (shouldClearCache) {
          clearCachedAuthState();
        }

        return {
          success: false,
          message,
          code,
          shouldClearCache,
        };
      }

      setGuidDraftOwner(data.user.id);
      setUser(data.user);
      setStatus('authenticated');
      setReady(true);

      // Re-enable WebSocket reconnection after successful login (WebUI mode only)
      if (typeof window !== 'undefined' && (window as any).__websocketReconnect) {
        (window as any).__websocketReconnect();
      }

      return { success: true };
    } catch (error) {
      if (controller && (controller.signal.aborted || abortRef.current !== controller)) {
        return { success: false, code: 'unknown' };
      }
      console.error('Login request failed:', error);

      // Check if error is related to CSRF token parsing
      const errorMessage = (error as Error).message;
      if (errorMessage?.includes('parse') || errorMessage?.includes('csrf') || errorMessage?.includes('cookie')) {
        // CSRF or cookie parsing error - clear cache
        clearCachedAuthState();
        return {
          success: false,
          message: 'Login failed due to cached data. Please clear your browser cache and try again.',
          code: 'csrfError',
          shouldClearCache: true,
        };
      }

      return {
        success: false,
        message: 'Network error. Please try again.',
        code: 'networkError',
      };
    }
  }, []);

  const logout = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (isDesktopRuntime) {
      resetGuidDraft();
      setUser(null);
      setStatus('authenticated');
      setReady(true);
      return;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const csrfToken = resolveCoreCsrfToken();
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const response = await fetch('/logout', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Logout failed (${response.status})`);
    if (controller.signal.aborted || abortRef.current !== controller) return;
    // Do not report success or destroy drafts when Core rejected the logout request.
    clearAuthCache();
    setGuidDraftOwner(null);
    setUser(null);
    setStatus('unauthenticated');
    setReady(true);
  }, []);
  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      user,
      status,
      login,
      logout,
      refresh,
      clearAuthCache,
    }),
    [login, logout, ready, refresh, status, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
