type Listener = () => void;
const listeners = new Set<Listener>();

/** Follow-up wallet/usage reads after billed cloud work ends; the server may settle debits late. */
export const SETTLEMENT_RETRY_DELAYS = [5000, 20000] as const;

/** Focus revalidation for account reads, throttled so window switching cannot flood the gateway. */
export const ACCOUNT_FOCUS_THROTTLE = 30000;

/** Bound automatic model-directory reads when users reopen a selector. */
export const MODEL_CATALOG_REFRESH_SPACING = 30000;

/** The first usage page every account view shares, so the status bar and ledger reuse one read. */
export const DEFAULT_USAGE_INPUT = { page: 1, page_size: 20 } as const;

/** Announce that billed cloud work reached a terminal state. Carries no amounts or job data. */
export function signalAccountActivity(): void {
  for (const listener of listeners) listener();
}

export function onAccountActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A ledger entry written at or after the wallet read began may be missing from that balance.
 * read_started_at is the fence: as_of is completion time and can postdate an entry the read missed.
 */
export function balanceBehindLedger(
  walletReadStartedAt: number | undefined,
  ledger: readonly { created_at: number }[] = []
) {
  const latest = ledger.reduce((max, item) => Math.max(max, item.created_at || 0), 0);
  return { latest, behind: walletReadStartedAt !== undefined && latest >= walletReadStartedAt };
}

/** Shared read time: the older completion of both reads, only when both succeeded. */
export function sharedReadTime(walletAsOf?: number, usageAsOf?: number): number | undefined {
  return walletAsOf && usageAsOf ? Math.min(walletAsOf, usageAsOf) : undefined;
}
