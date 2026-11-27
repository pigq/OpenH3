import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import type {
  CloudAccountRequest,
  CloudCapabilities,
  CloudSession,
  CloudVerification,
  CloudWallet,
  CloudModels,
  CloudAccountResponse,
} from '@/common/types/platform/cloudAccount';
import type { IProvider } from '@/common/config/storage';
import { useAuth } from '@/renderer/hooks/context/AuthContext';
import { resolveCurrentUserId } from '@/renderer/hooks/system/currentUserId';
import { requestCloudAccount } from './transport';
import {
  ACCOUNT_FOCUS_THROTTLE,
  MODEL_CATALOG_REFRESH_SPACING,
  onAccountActivity,
  SETTLEMENT_RETRY_DELAYS,
} from './Panels/freshness';
import { useManagedTurnSettlement } from './Panels/useManagedTurnSettlement';

type View = 'login' | 'register' | 'recovery' | 'proof' | 'reset';
type Ticket = { owner: string | undefined; epoch: number };
type ReadScope = { ticket: Ticket; publication: number };
type ReadError = Error & ReadScope;
type Snapshot = ReadScope & { session: CloudSession; capabilities: CloudCapabilities };
type State = {
  catalog?: CloudModels;
  catalogPending?: boolean;
  catalogRead?: boolean;
  session?: CloudSession;
  capabilities?: CloudCapabilities;
  revision: number;
  busy: boolean;
  view: View;
  error?: string;
  retryAt: number;
  registered: boolean;
  notice?: string;
  challenge?: CloudVerification;
  proofPurpose?: CloudVerification['purpose'];
  reset?: { challenge_id: string; expires_at: number };
};
export type OwnedRead = (request: CloudAccountRequest) => Promise<CloudAccountResponse | undefined>;
type Lifecycle = State & {
  ownerId?: string;
  scope: string;
  accountKey: string;
  captureScope: () => () => boolean;
  refreshBilling: (paidOrderIds: readonly string[]) => void;
  readOwned: OwnedRead;
  wallet?: CloudWallet;
  walletLoading: boolean;
  walletFailed: boolean;
  refreshWallet: () => void;
  /** Re-read session, wallet and usage together. */
  refreshAccount: () => void;
  /** Automatic, spaced wallet+usage read (page entry); no-op while rate limited. */
  refreshBalance: () => void;
  /** Re-read wallet and usage a bounded number of times while late debits settle. */
  settle: () => void;
  settling: boolean;
  refreshCatalog: (deliberate?: boolean) => Promise<void>;
  deviceTarget?: { id: string; label: string; current: boolean };
  chooseDevice: (target: { id: string; label: string; current: boolean }) => void;
  available: boolean;
  reload: () => void;
  switchView: (view: View) => void;
  run: (request: CloudAccountRequest) => Promise<void>;
  cancel: () => void;
};
const Context = createContext<Lifecycle | undefined>(undefined);
const empty = (): State => ({ revision: 0, busy: false, view: 'login', retryAt: 0, registered: false });
const BALANCE_READ_SPACING = 2000;
const identityOperations = new Set(['login', 'logout', 'passwordResetComplete']);

/** One lifecycle for every host. Only the original owner's operation may commit.
 * SWR owns read scheduling; credentials exist only in a form/transport call.
 */
export const CloudAccountProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const auth = useAuth();
  const { mutate } = useSWRConfig();
  const [desktopOwner, setDesktopOwner] = useState<string>();
  useEffect(() => {
    if (auth.status !== 'authenticated' || auth.user?.id || !window.electronAPI) return;
    let live = true;
    void resolveCurrentUserId().then((id) => {
      if (live) setDesktopOwner(id);
    });
    return () => {
      live = false;
    };
  }, [auth.status, auth.user?.id]);
  const owner =
    auth.status === 'authenticated' ? (auth.user?.id ?? (window.electronAPI ? desktopOwner : undefined)) : undefined;
  const [state, setState] = useState<State>(empty);
  const fence = useRef({ owner, epoch: 0 });
  const readPublication = useRef(0);
  const catalogFlight = useRef<ReadScope | undefined>(undefined);
  const catalogRead = useRef<(ReadScope & { nextAt: number }) | undefined>(undefined);
  const [deviceTarget, setDeviceTarget] = useState<{
    target: NonNullable<Lifecycle['deviceTarget']>;
    ticket: Ticket;
  }>();
  const [resourceRevision, setResourceRevision] = useState(0);
  const paidBilling = useRef({ scope: '', orders: new Set<string>() });
  const settleTimers = useRef<number[]>([]);
  const balanceLimitedUntil = useRef(0);
  const lastBalanceRead = useRef(0);
  const [settling, setSettling] = useState(false);
  const targetRef = useRef<Lifecycle['deviceTarget']>(undefined);
  const identityFlight = useRef<(Ticket & { generation?: string; operation: string; failed?: boolean }) | undefined>(
    undefined
  );
  const generation = useRef<string | undefined>(undefined);
  // Fence synchronously during render: an already-resolved A continuation must
  // not run between rendering owner B and B's effects.
  if (fence.current.owner !== owner) {
    fence.current = { owner, epoch: fence.current.epoch + 1 };
    generation.current = undefined;
    targetRef.current = undefined;
  }
  const renderedOwner = useRef(owner);
  const belongs = renderedOwner.current === owner;
  const current = belongs ? state : empty();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      fence.current.epoch++;
    };
  }, []);
  useEffect(() => {
    const previousOwner = renderedOwner.current;
    renderedOwner.current = owner;
    setState((previous) => ({ ...empty(), revision: previous.revision + 1 }));
    // The provider list can arrive before the local desktop owner on startup.
    // Clear it only when leaving an owner who has already been resolved.
    if (previousOwner !== undefined && previousOwner !== owner)
      void mutate<IProvider[]>(
        'providers',
        (providers) => providers?.filter((provider) => provider.managed_by !== 'cloud_account'),
        { revalidate: false }
      );
  }, [owner, mutate]);
  const matches = useCallback(
    (ticket: Ticket) => live.current && ticket.owner === fence.current.owner && ticket.epoch === fence.current.epoch,
    []
  );
  const matchesRead = useCallback(
    (scope: ReadScope) => matches(scope.ticket) && scope.publication === readPublication.current,
    [matches]
  );
  const clearProviders = useCallback(
    () =>
      mutate<IProvider[]>(
        'providers',
        (providers) => providers?.filter((provider) => provider.managed_by !== 'cloud_account'),
        { revalidate: false }
      ),
    [mutate]
  );
  const read = useCallback(async (): Promise<Snapshot> => {
    const scope = { ticket: { ...fence.current }, publication: readPublication.current };
    try {
      const [session, capabilities] = await Promise.all([
        requestCloudAccount({ operation: 'session' }),
        requestCloudAccount({ operation: 'capabilities' }),
      ]);
      if (!matchesRead(scope) || !session.success || !capabilities.success) throw new Error('CLOUD_TRANSPORT');
      return { ...scope, session: session.data as CloudSession, capabilities: capabilities.data as CloudCapabilities };
    } catch {
      // SWR's catch path can publish an obsolete failure after mutate(). Keep
      // the original read scope so the UI can fence errors as well as data.
      throw Object.assign(new Error('CLOUD_TRANSPORT'), scope);
    }
  }, [matchesRead]);
  const query = useSWR<Snapshot, ReadError>(owner ? ['cloud-account', owner] : null, read, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    shouldRetryOnError: false,
    keepPreviousData: false,
  });
  useEffect(() => {
    if (!query.data || !owner || !matchesRead(query.data)) return;
    // A read may observe this mutation's local commit while its remote outcome
    // is still pending. Only the mutation may finish that transition.
    const snapshot = query.data;
    const flight = identityFlight.current;
    if (flight && matches(flight) && flight.generation && 'generation' in snapshot.session) {
      const next = (BigInt(flight.generation) + BigInt(1)).toString();
      const observed = snapshot.session.generation;
      const expected =
        observed === next &&
        (flight.operation === 'login' ||
          (flight.operation === 'logout' && snapshot.session.state === 'disconnected') ||
          (flight.operation === 'passwordResetComplete' && snapshot.session.state === 'reauth_required'));
      if (!flight.failed && (observed === flight.generation || expected)) return;
      const failedTransition =
        expected && (snapshot.session.state === 'disconnected' || snapshot.session.state === 'reauth_required');
      if (flight.failed && (observed === flight.generation || failedTransition)) {
        // begin_login advances even when credentials fail. This original read
        // may finish that failed attempt without erasing a completed registration.
        generation.current = observed;
        identityFlight.current = undefined;
      }
    }
    const nextGeneration = 'generation' in snapshot.session ? snapshot.session.generation : undefined;
    const changed = generation.current !== undefined && generation.current !== nextGeneration;
    generation.current = nextGeneration;
    if (changed) {
      targetRef.current = undefined;
      setDeviceTarget(undefined);
      fence.current.epoch++;
      void clearProviders();
      void mutate('providers');
    }
    setState((previous) => {
      return {
        ...(changed ? { ...empty(), revision: previous.revision + 1 } : previous),
        ...snapshot,
        ...(snapshot.session.state === 'verification_required'
          ? { view: 'proof' as const, challenge: snapshot.session.verification, proofPurpose: 'login' as const }
          : {}),
      };
    });
  }, [query.data, owner, matches, matchesRead, clearProviders, mutate]);
  const renderEpoch = fence.current.epoch;
  const cancel = useCallback(() => {
    // A host can unmount after an operation starts but before its next render.
    if (!live.current || fence.current.owner !== owner) return;
    fence.current.epoch++;
    targetRef.current = undefined;
    setDeviceTarget(undefined);
    setState((previous) => ({
      ...previous,
      busy: false,
      catalogPending: false,
      view: 'login',
      challenge: undefined,
      reset: undefined,
      error: undefined,
      revision: previous.revision + 1,
    }));
  }, [owner]);
  const switchView = useCallback(
    (view: View) => {
      if (!matches({ owner, epoch: renderEpoch })) return;
      fence.current.epoch++;
      setState((previous) => ({
        ...previous,
        view,
        busy: false,
        error: undefined,
        challenge: undefined,
        reset: undefined,
        revision: previous.revision + 1,
      }));
    },
    [matches, owner, renderEpoch]
  );
  const run = useCallback(
    async (request: CloudAccountRequest) => {
      if (!owner || !matches({ owner, epoch: renderEpoch })) return;
      // All deliberate operations supersede previous form requests; never retry
      // ambiguous credential mutations. The ticket is captured before awaiting.
      fence.current.epoch++;
      const ticket = { ...fence.current };
      const target = targetRef.current;
      if (target) setDeviceTarget({ target, ticket });
      if (
        request.operation === 'verify' &&
        current.proofPurpose === 'device_revocation' &&
        (!target ||
          current.challenge?.purpose !== 'device_revocation' ||
          current.challenge.challenge_id !== request.input.challenge_id)
      )
        return;
      const identity = identityOperations.has(request.operation);
      if (identity)
        identityFlight.current = { ...ticket, generation: generation.current, operation: request.operation };
      setState((previous) => ({
        ...previous,
        busy: true,
        catalogPending: false,
        error: undefined,
        ...(identity
          ? { session: undefined, challenge: undefined, reset: undefined, revision: previous.revision + 1 }
          : {}),
      }));
      if (identity) {
        targetRef.current = undefined;
        setDeviceTarget(undefined);
        void clearProviders();
      }
      const result = await requestCloudAccount(request);
      if (!matches(ticket)) return;
      if (identity && identityFlight.current) {
        if (result.success) identityFlight.current = undefined;
        else identityFlight.current.failed = true;
      }
      if (result.success === false) {
        const retry = result.retry_after ?? result.details?.retry_after ?? 0;
        setState((previous) => ({ ...previous, busy: false, error: result.code, retryAt: Date.now() + retry * 1000 }));
        if (identity || result.code === 'CLOUD_AUTH_REQUIRED' || result.code === 'CLOUD_CONFLICT') {
          void mutate('providers');
          void query.mutate();
        }
        return;
      }
      const data = result.data;
      let connected: CloudSession | undefined;
      if (request.operation === 'login') connected = data as CloudSession;
      if (data && 'result' in data && data.result === 'login') connected = data.session;
      if (connected) {
        readPublication.current++;
        // Publish through SWR's mutation boundary: reads begun before this
        // completed login/proof cannot replace it, even at the same generation.
        // Keep the original operation ticket valid for its catalog continuation.
        void query.mutate(undefined, { revalidate: false });
      }
      if (connected && 'generation' in connected) generation.current = connected.generation;
      if (request.operation === 'logout' || request.operation === 'passwordResetComplete')
        generation.current = undefined;
      const revoked =
        target &&
        data &&
        (('status' in data && data.status === 'revoked') || ('result' in data && data.result === 'device_revoked'));
      if (revoked) {
        targetRef.current = undefined;
        setDeviceTarget(undefined);
        setResourceRevision((value) => value + 1);
        if (target.current) {
          generation.current = undefined;
          readPublication.current++;
          void query.mutate(undefined, { revalidate: false });
          void clearProviders();
          void mutate('providers');
        }
      }
      setState((previous) => {
        let next: State = { ...previous, busy: false, error: undefined };
        if (request.operation === 'register')
          next = { ...next, registered: true, view: 'login', revision: next.revision + 1 };
        if (request.operation === 'emailCode') next.notice = 'codeSent';
        if (request.operation === 'logout' && data && 'remote_revocation' in data)
          next = {
            ...next,
            session: undefined,
            notice: data.remote_revocation === 'unconfirmed' ? 'logoutUnconfirmed' : 'logoutConfirmed',
            view: 'login',
          };
        if (request.operation === 'passwordResetComplete')
          next = {
            ...next,
            view: 'login',
            reset: undefined,
            challenge: undefined,
            revision: next.revision + 1,
            notice:
              data && 'session_cleanup_pending' in data && data.session_cleanup_pending
                ? 'resetCleanupPending'
                : 'resetComplete',
          };
        if (data && 'status' in data && data.status === 'ready')
          next = { ...next, view: 'reset', reset: data as State['reset'], revision: next.revision + 1 };
        if (data && 'result' in data && data.result === 'password_reset_ready')
          next = { ...next, view: 'reset', reset: data, challenge: undefined, revision: next.revision + 1 };
        if (data && 'status' in data && data.status === 'verification_required' && 'verification' in data)
          next = {
            ...next,
            view: 'proof',
            challenge: data.verification,
            proofPurpose: request.operation === 'revokeDevice' ? 'device_revocation' : 'password_reset',
            revision: next.revision + 1,
          };
        if (revoked)
          next = {
            ...next,
            challenge: undefined,
            proofPurpose: undefined,
            notice: 'deviceRevoked',
            revision: next.revision + 1,
            ...(target?.current ? { session: undefined } : {}),
          };
        if (connected)
          next = {
            ...next,
            session: connected,
            catalogPending: connected.state === 'connected',
            catalogRead: false,
            catalog: undefined,
            view: connected.state === 'verification_required' ? 'proof' : 'login',
            challenge: connected.state === 'verification_required' ? connected.verification : undefined,
            proofPurpose: connected.state === 'verification_required' ? 'login' : undefined,
            revision: next.revision + 1,
          };
        return next;
      });
      if (connected?.state === 'connected') {
        // Catalog admission is Core-owned. Revalidate the existing providers key
        // after success AND failure because failure clears admission as well.
        catalogRead.current = {
          ticket,
          publication: readPublication.current,
          nextAt: Date.now() + MODEL_CATALOG_REFRESH_SPACING,
        };
        const catalog = await requestCloudAccount({ operation: 'models' });
        if (!matches(ticket)) return;
        if (catalog.success === false && catalog.code === 'CLOUD_RATE_LIMITED' && catalogRead.current)
          catalogRead.current.nextAt = Math.max(
            catalogRead.current.nextAt,
            Date.now() + (catalog.retry_after ?? catalog.details?.retry_after ?? 60) * 1000
          );
        await mutate('providers');
        if (!matches(ticket)) return;
        setState((previous) => ({
          ...previous,
          catalogPending: false,
          catalogRead: true,
          catalog: catalog.success && catalog.data && 'quote_semantics' in catalog.data ? catalog.data : undefined,
          notice:
            !catalog.success || (catalog.data && 'status' in catalog.data && catalog.data.status === 'unavailable')
              ? 'catalogFailed'
              : undefined,
        }));
      } else if (identity) {
        void mutate('providers');
        if (request.operation !== 'login') void query.mutate();
      }
    },
    [clearProviders, matches, mutate, query.mutate, owner, renderEpoch, current.challenge, current.proofPurpose]
  );
  const scope = `${owner ?? ''}:${fence.current.epoch}:${readPublication.current}:${generation.current ?? ''}:${resourceRevision}`;
  const publication = readPublication.current;
  const readOwned = useCallback<OwnedRead>(
    async (request) => {
      const original = { ticket: { owner, epoch: renderEpoch }, publication };
      if (!matchesRead(original) || current.session?.state !== 'connected') return;
      const result = await requestCloudAccount(request);
      if (!matchesRead(original)) return;
      if (request.operation === 'models') void mutate('providers');
      if (result.success === false && result.code === 'CLOUD_RATE_LIMITED') {
        const retry = result.retry_after ?? result.details?.retry_after ?? 60;
        balanceLimitedUntil.current = Date.now() + retry * 1000;
      }
      if (result.success === false && (result.code === 'CLOUD_AUTH_REQUIRED' || result.code === 'CLOUD_CONFLICT'))
        void query.mutate();
      return result;
    },
    [owner, renderEpoch, publication, current.session?.state, matchesRead, mutate, query.mutate]
  );
  const walletQuery = useSWR<{ scope: string; wallet: CloudWallet }, Error & { scope: string }>(
    current.session?.state === 'connected' ? ['cloud-wallet', scope] : null,
    async () => {
      const result = await readOwned({ operation: 'wallet' });
      if (!result?.success || !result.data || !('wallet_balance' in result.data))
        throw Object.assign(new Error('CLOUD_TRANSPORT'), { scope });
      return { scope, wallet: result.data };
    },
    { shouldRetryOnError: false, revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const connected = current.session?.state === 'connected';
  const revalidateUsage = () =>
    mutate(
      (key) =>
        Array.isArray(key) &&
        key[0] === 'cloud-read' &&
        key[1] === scope &&
        (key[2] as CloudAccountRequest | undefined)?.operation === 'usage'
    );
  /** Automatic reads are single-flight, spaced and paused by a gateway rate limit; deliberate refresh is not spaced. */
  const readBalance = (deliberate = false) => {
    const now = Date.now();
    if (!connected || now < balanceLimitedUntil.current) return false;
    if (!deliberate && (walletRef.current.isValidating || now - lastBalanceRead.current < BALANCE_READ_SPACING))
      return true;
    lastBalanceRead.current = now;
    void walletRef.current.mutate();
    void revalidateUsage();
    return true;
  };
  const clearSettle = () => {
    for (const timer of settleTimers.current) window.clearTimeout(timer);
    settleTimers.current = [];
  };
  const settle = () => {
    if (!connected) return;
    clearSettle();
    if (!readBalance()) return setSettling(false);
    setSettling(true);
    SETTLEMENT_RETRY_DELAYS.forEach((delay, index) => {
      const timer = window.setTimeout(() => {
        if (!readBalance() || index === SETTLEMENT_RETRY_DELAYS.length - 1) {
          clearSettle();
          setSettling(false);
        }
      }, delay);
      settleTimers.current.push(timer);
    });
  };
  const walletRef = useRef(walletQuery);
  walletRef.current = walletQuery;
  const readBalanceRef = useRef(readBalance);
  readBalanceRef.current = readBalance;
  useEffect(() => {
    if (!connected) return;
    let lastFocusRead = 0;
    const onFocus = () => {
      const now = Date.now();
      if (document.visibilityState === 'hidden' || now - lastFocusRead < ACCOUNT_FOCUS_THROTTLE) return;
      if (readBalanceRef.current()) lastFocusRead = now;
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [connected, scope]);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => {
    if (!connected) return;
    return onAccountActivity(() => settleRef.current());
  }, [connected]);
  useManagedTurnSettlement(connected, () => {
    const original = { ticket: { owner, epoch: renderEpoch }, publication };
    const originalGeneration = generation.current;
    return () => matchesRead(original) && originalGeneration === generation.current;
  });
  useEffect(
    () => () => {
      clearSettle();
      setSettling(false);
    },
    [scope, connected]
  );
  useEffect(() => {
    if (targetRef.current && current.session?.state !== 'connected') {
      targetRef.current = undefined;
      setDeviceTarget(undefined);
    }
  }, [scope, current.session?.state]);
  const value: Lifecycle = {
    ...current,
    ownerId: owner,
    scope,
    // Intent identity survives unrelated read/dialog epochs. Consumers never parse it.
    accountKey: JSON.stringify([
      owner,
      current.session?.state === 'connected' ? current.session.account.id : null,
      generation.current,
    ]),
    captureScope: () => {
      const original = { ticket: { owner, epoch: renderEpoch }, publication };
      const originalGeneration = generation.current;
      return () => matchesRead(original) && originalGeneration === generation.current;
    },
    refreshBilling: (paidOrderIds) => {
      if (
        current.session?.state !== 'connected' ||
        !matchesRead({ ticket: { owner, epoch: renderEpoch }, publication })
      )
        return;
      // One scoped notification for paid observations from detail OR history.
      // This is revalidation deduplication, never a local balance or order status.
      if (paidBilling.current.scope !== scope) paidBilling.current = { scope, orders: new Set() };
      const unseen = paidOrderIds.filter((id) => !paidBilling.current.orders.has(id));
      if (!unseen.length || !readBalance(true)) return;
      for (const id of unseen) paidBilling.current.orders.add(id);
    },
    readOwned,
    wallet: walletQuery.data?.scope === scope ? walletQuery.data.wallet : undefined,
    walletLoading: walletQuery.isValidating,
    walletFailed: walletQuery.error?.scope === scope,
    refreshWallet: () => {
      void walletQuery.mutate();
    },
    refreshAccount: () => {
      if (!connected || !matches({ owner, epoch: renderEpoch })) return;
      void query.mutate();
      readBalance(true);
    },
    refreshBalance: () => {
      readBalance();
    },
    settle,
    settling,
    refreshCatalog: async (deliberate = true) => {
      if (current.session?.state !== 'connected') return;
      if (current.catalogPending || (catalogFlight.current && matchesRead(catalogFlight.current))) return;
      const original = { ticket: { owner, epoch: renderEpoch }, publication };
      if (!matchesRead(original)) return;
      if (
        !deliberate &&
        catalogRead.current &&
        matchesRead(catalogRead.current) &&
        Date.now() < catalogRead.current.nextAt
      )
        return;
      catalogFlight.current = original;
      catalogRead.current = { ...original, nextAt: Date.now() + MODEL_CATALOG_REFRESH_SPACING };
      setState((previous) => ({ ...previous, catalogPending: true }));
      const result = await readOwned({ operation: 'models' });
      if (catalogFlight.current === original) catalogFlight.current = undefined;
      if (!matchesRead(original)) return;
      if (result?.success === false && result.code === 'CLOUD_RATE_LIMITED' && catalogRead.current)
        catalogRead.current.nextAt = Math.max(
          catalogRead.current.nextAt,
          Date.now() + (result.retry_after ?? result.details?.retry_after ?? 60) * 1000
        );
      setState((previous) => ({
        ...previous,
        catalogPending: false,
        catalogRead: true,
        catalog: result?.success && result.data && 'quote_semantics' in result.data ? result.data : undefined,
        notice: result?.success ? undefined : 'catalogFailed',
      }));
    },
    deviceTarget:
      current.session?.state === 'connected' && deviceTarget && matches(deviceTarget.ticket)
        ? deviceTarget.target
        : undefined,
    chooseDevice: (target) => {
      if (!matches({ owner, epoch: renderEpoch })) return;
      fence.current.epoch++;
      targetRef.current = target;
      setDeviceTarget({ target, ticket: { ...fence.current } });
      setState((previous) => ({
        ...previous,
        challenge: undefined,
        proofPurpose: undefined,
        busy: false,
        catalogPending: false,
      }));
    },
    error: current.error ?? (query.error && matchesRead(query.error) ? 'CLOUD_TRANSPORT' : undefined),
    available: !!owner,
    run,
    cancel,
    switchView,
    reload: () => {
      if (!matches({ owner, epoch: renderEpoch })) return;
      void query.mutate();
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
};
export const useCloudAccount = (): Lifecycle => {
  const context = useContext(Context);
  if (!context) throw new Error('CloudAccountProvider is required');
  return context;
};
export const useOptionalCloudAccount = (): Lifecycle | undefined => useContext(Context);
