import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type {
  CloudAccountRequest,
  CloudAccountResponse,
  CloudModels,
  CloudWallet,
} from '@/common/types/platform/cloudAccount';
const f = vi.hoisted(() => ({
  owner: 'owner',
  request: vi.fn<(r: CloudAccountRequest) => Promise<CloudAccountResponse>>(),
  turn: undefined as undefined | ((event: { session_id: string; turn_id: string }) => void),
  conversation: vi.fn(),
}));
vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: f.owner } }),
}));
vi.mock('@/renderer/components/settings/SettingsModal/CloudAccount/transport', () => ({
  requestCloudAccount: f.request,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { time?: string }) => (o?.time ? `${k} ${o.time}` : k) }),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      turnCompleted: {
        on: (listener: (event: { session_id: string; turn_id: string }) => void) => {
          f.turn = listener;
          return () => {
            f.turn = undefined;
          };
        },
      },
      get: { invoke: f.conversation },
    },
  },
}));
import {
  CloudAccountProvider,
  useCloudAccount,
} from '@/renderer/components/settings/SettingsModal/CloudAccount/Provider';
import CloudAccount from '@/renderer/components/settings/SettingsModal/CloudAccount';
import { formatAccountTime } from '@/renderer/components/settings/SettingsModal/CloudAccount/Panels/format';
import { signalAccountActivity } from '@/renderer/components/settings/SettingsModal/CloudAccount/Panels/freshness';

const usd = (amount: string) => ({
  amount: '1',
  unit: 'new_api_quota',
  display_amount: { amount, currency: 'USD' as const },
});
const baseWallet: CloudWallet = {
  read_started_at: 1700000100,
  as_of: 1700000105,
  wallet_balance: { status: 'available', amount: usd('1.5') },
  device_limit: { status: 'unlimited' },
  billing_preference: 'wallet_only',
  subscriptions: { status: 'available', items: [] },
};
let wallet = baseWallet;
let ledgerAt = 1700000050;
let usageAsOf = 1700000102;
const capabilities = {
  availability: 'available',
  registration_enabled: true,
  email_verification_required: false,
  password_login_enabled: true,
  password_reset_enabled: true,
  anti_bot: 'not_required',
  password_min_length: 8,
  password_max_length: 128,
};
function response(r: CloudAccountRequest): CloudAccountResponse {
  if (r.operation === 'session')
    return {
      success: true,
      data: {
        state: 'connected',
        generation: '1',
        account: { id: '1', username: 'qa', display_name: 'QA', email: null },
      },
    };
  if (r.operation === 'capabilities') return { success: true, data: capabilities } as CloudAccountResponse;
  if (r.operation === 'wallet') return { success: true, data: wallet };
  if (r.operation === 'usage')
    return {
      success: true,
      data: {
        read_started_at: usageAsOf - 1,
        as_of: usageAsOf,
        status: 'available',
        completeness: 'not_reconciled',
        page: 1,
        page_size: 20,
        has_more: false,
        items: [1, 2, 3, 4].map((n) => ({
          id: `debit-${n}`,
          created_at: ledgerAt - n + 1,
          kind: 'consume',
          direction: 'debit',
          quota: usd(`0.${n}`),
          model: `model-${n}`,
          prompt_tokens: '1',
          completion_tokens: '1',
          request_id: `req-${n}`,
        })),
      },
    };
  if (r.operation === 'models')
    return { success: true, data: { status: 'available', quote_semantics: 'x', models: [] } };
  if (r.operation === 'topupOptions')
    return { success: true, data: { status: 'unavailable', options: [], unsupported_providers: [] } };
  if (r.operation === 'topupOrders') return { success: true, data: { items: [], has_more: false, next_before_id: 0 } };
  return { success: true, data: { items: [] } } as CloudAccountResponse;
}
const reads = (operation: string) => f.request.mock.calls.filter(([r]) => r.operation === operation).length;
function mount(providers: unknown[] = []) {
  const cache = new Map<string, unknown>([['providers', { data: providers }]]);
  return render(
    <SWRConfig value={{ provider: () => cache as never, shouldRetryOnError: false, onError: () => {} }}>
      <CloudAccountProvider>
        <CloudAccount />
      </CloudAccountProvider>
    </SWRConfig>
  );
}
const shared = () => screen.findByText(`settings.cloudAccount.updatedAt ${formatAccountTime(1700000102)}`);
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  f.owner = 'owner';
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
  });
  wallet = baseWallet;
  ledgerAt = 1700000050;
  usageAsOf = 1700000102;
  f.conversation.mockReset();
  f.request.mockReset().mockImplementation(async (r) => response(r));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('refreshes model catalogs on entry within one scoped time limit, while allowing a deliberate refresh', async () => {
  let now = 1700000000000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    let names = ['first-model'];
    const catalog = (): CloudModels => ({
      status: 'available',
      quote_semantics: 'observed_rules_not_frozen_final_charge',
      models: names.map((name) => ({
        model_id: name,
        display_name: name,
        provider: 'official',
        purpose: 'text',
        protocol: 'Responses',
        input_capabilities: ['text'],
        supports_tools: true,
        context_limit: 8000,
        max_output_tokens: 1000,
        compatibility_version: 'v1',
        evidence: 'gateway',
        quotes: [
          {
            group: 'default',
            kind: 'request',
            unit: 'USD_per_request',
            group_ratio: '1',
            per_request: '0',
            cache_write_mode: 'none',
            version: 'v1',
            quota_per_usd: '500000',
          },
        ],
      })),
    });
    f.request.mockImplementation(async (r) =>
      r.operation === 'models' ? { success: true, data: catalog() } : response(r)
    );
    const wrapper = ({ children }: React.PropsWithChildren) => (
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <CloudAccountProvider>{children}</CloudAccountProvider>
      </SWRConfig>
    );
    const { result, rerender } = renderHook(() => useCloudAccount(), { wrapper });
    await waitFor(() => expect(result.current.session?.state).toBe('connected'));
    await act(async () => result.current.refreshCatalog(false));
    expect(reads('models')).toBe(1);
    expect(result.current.catalog?.models.map((model) => model.model_id)).toEqual(['first-model']);
    names = ['new-model'];
    await act(async () => result.current.refreshCatalog(false));
    expect(reads('models')).toBe(1);
    now += 30001;
    await act(async () => {
      await Promise.all([result.current.refreshCatalog(false), result.current.refreshCatalog(false)]);
    });
    expect(reads('models')).toBe(2);
    expect(result.current.catalog?.models.map((model) => model.model_id)).toEqual(['new-model']);
    names = [];
    await act(async () => result.current.refreshCatalog());
    expect(reads('models')).toBe(3);
    expect(result.current.catalog?.models).toEqual([]);
    f.request.mockImplementation(async (r) =>
      r.operation === 'models'
        ? { success: false, code: 'CLOUD_RATE_LIMITED', error: 'limited', retry_after: 90 }
        : response(r)
    );
    await act(async () => result.current.refreshCatalog());
    expect(reads('models')).toBe(4);
    now += 30001;
    await act(async () => result.current.refreshCatalog(false));
    expect(reads('models')).toBe(4);
    f.request.mockImplementation(async (r) => response(r));
    f.owner = 'other-owner';
    rerender();
    await waitFor(() => expect(result.current.session?.state).toBe('connected'));
    await act(async () => result.current.refreshCatalog(false));
    expect(reads('models')).toBe(5);
  } finally {
    clock.mockRestore();
  }
});
it('shows one shared read time and a short recent ledger, with no manual refresh while reads are healthy', async () => {
  mount();
  const status = await screen.findByText(`settings.cloudAccount.updatedAt ${formatAccountTime(1700000102)}`);
  expect(status).toBeVisible();
  const recent = within(await screen.findByRole('region', { name: 'settings.cloudAccount.recentActivity' }));
  expect(recent.getByText('model-1')).toBeVisible();
  expect(recent.getByText('model-3')).toBeVisible();
  expect(recent.queryByText('model-4')).not.toBeInTheDocument();
  expect(screen.queryByText('settings.cloudAccount.settling')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'settings.cloudAccount.retryRead' })).not.toBeInTheDocument();
  expect(within(document.querySelector('[data-cloud-status]') as HTMLElement).queryByRole('button')).toBeNull();
  fireEvent.click(recent.getByRole('button', { name: 'settings.cloudAccount.viewAllActivity' }));
  expect(screen.getByRole('tab', { name: 'settings.cloudAccount.activityTab' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
});
it('re-reads a balance that may miss a ledger entry a bounded number of times, then asks for a manual read', async () => {
  ledgerAt = baseWallet.read_started_at;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mount();
  await screen.findByText('settings.cloudAccount.settling');
  await waitFor(() => expect(reads('wallet')).toBe(2));
  await advance(5000);
  await waitFor(() => expect(reads('wallet')).toBe(3));
  await advance(15000);
  await waitFor(() => expect(reads('wallet')).toBe(4));
  expect(await screen.findByText('settings.cloudAccount.settlementStale')).toBeVisible();
  const retry = screen.getByRole('button', { name: 'settings.cloudAccount.retryRead' });
  await advance(60000);
  expect(reads('wallet')).toBe(4);
  const before = { session: reads('session'), usage: reads('usage') };
  fireEvent.click(retry);
  await waitFor(() => expect(reads('wallet')).toBe(5));
  await waitFor(() => expect(reads('usage')).toBe(before.usage + 1));
  expect(reads('session')).toBe(before.session + 1);
});
it('offers retry after a failed balance read and re-reads balance and ledger together', async () => {
  mount();
  await shared();
  f.request.mockImplementation(async (r) =>
    r.operation === 'wallet' ? { success: false, code: 'CLOUD_TRANSPORT', error: 'down' } : response(r)
  );
  act(() => signalAccountActivity());
  const retry = await screen.findByRole('button', { name: 'settings.cloudAccount.retryRead' });
  expect(screen.queryByText(/settings.cloudAccount.updatedAt/)).not.toBeInTheDocument();
  f.request.mockImplementation(async (r) => response(r));
  const before = { wallet: reads('wallet'), usage: reads('usage') };
  fireEvent.click(retry);
  await waitFor(() => expect(reads('wallet')).toBe(before.wallet + 1));
  await waitFor(() => expect(reads('usage')).toBe(before.usage + 1));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'settings.cloudAccount.retryRead' })).not.toBeInTheDocument()
  );
});
it('re-reads balance and ledger together on focus, respecting the gateway retry delay', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mount();
  await shared();
  const initial = { wallet: reads('wallet'), usage: reads('usage') };
  f.request.mockImplementation(async (r) =>
    r.operation === 'wallet'
      ? { success: false, code: 'CLOUD_RATE_LIMITED', error: 'limited', retry_after: 90 }
      : response(r)
  );
  await advance(31000);
  fireEvent.focus(window);
  await screen.findByRole('button', { name: 'settings.cloudAccount.retryRead' });
  expect(reads('wallet')).toBe(initial.wallet + 1);
  expect(reads('usage')).toBe(initial.usage + 1);
  f.request.mockImplementation(async (r) => response(r));
  await advance(31000);
  fireEvent.focus(window);
  await advance(100);
  expect(reads('wallet')).toBe(initial.wallet + 1);
  expect(reads('usage')).toBe(initial.usage + 1);
  await advance(60000);
  fireEvent.focus(window);
  await shared();
  expect(reads('wallet')).toBe(initial.wallet + 2);
  expect(reads('usage')).toBe(initial.usage + 2);
});
it.each([
  ['subscription-only billing', { billing_preference: 'subscription_only' }, false],
  [
    'an unreadable subscription',
    { billing_preference: 'subscription_first', subscriptions: { status: 'unavailable', items: [] } },
    false,
  ],
  [
    'an unused subscription',
    {
      billing_preference: 'subscription_first',
      subscriptions: {
        status: 'available',
        items: [
          {
            id: 's',
            allowance_state: 'committed_snapshot',
            remaining: usd('2'),
            used: usd('0'),
            unlimited: false,
            expires_at: 0,
            next_reset_at: 0,
            allow_wallet_overflow: false,
          },
        ],
      },
    },
    false,
  ],
  [
    'wallet-only billing beside an unused subscription',
    {
      billing_preference: 'wallet_only',
      subscriptions: {
        status: 'available',
        items: [
          {
            id: 's',
            allowance_state: 'committed_snapshot',
            remaining: usd('2'),
            used: usd('0'),
            unlimited: false,
            expires_at: 0,
            next_reset_at: 0,
            allow_wallet_overflow: false,
          },
        ],
      },
    },
    true,
  ],
] as const)('offers a wallet top-up with %s only when it can fund use', async (_name, patch, empty) => {
  wallet = { ...baseWallet, wallet_balance: { status: 'available', amount: usd('0') }, ...patch } as CloudWallet;
  mount();
  await shared();
  expect(screen.queryByText('settings.cloudAccount.emptyBalance') !== null).toBe(empty);
  expect(screen.queryByRole('button', { name: 'settings.cloudAccount.topUp' }) !== null).toBe(empty);
});
it('stops an automatic settlement round when the gateway rate limits a balance read', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mount();
  await screen.findByText(`settings.cloudAccount.updatedAt ${formatAccountTime(1700000102)}`);
  f.request.mockImplementation(async (r) =>
    r.operation === 'wallet'
      ? { success: false, code: 'CLOUD_RATE_LIMITED', error: 'limited', retry_after: 60 }
      : response(r)
  );
  const before = reads('wallet');
  act(() => signalAccountActivity());
  await waitFor(() => expect(reads('wallet')).toBe(before + 1));
  await advance(25000);
  expect(reads('wallet')).toBe(before + 1);
});
it('settles after a turn on an account-managed model and ignores turns on own-key models', async () => {
  mount([{ id: 'official', managed_by: 'cloud_account' }, { id: 'byok' }]);
  await screen.findByText(`settings.cloudAccount.updatedAt ${formatAccountTime(1700000102)}`);
  await waitFor(() => expect(f.turn).toBeDefined());
  const before = reads('wallet');
  f.conversation.mockResolvedValue({ id: 'c1', model: { id: 'byok', use_model: 'gpt' } });
  await act(async () => f.turn?.({ session_id: 'c1', turn_id: 't1' }));
  await waitFor(() => expect(f.conversation).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(reads('wallet')).toBe(before);
  f.conversation.mockResolvedValue({ id: 'c2', model: { id: 'official', use_model: 'astra' } });
  await act(async () => f.turn?.({ session_id: 'c2', turn_id: 't2' }));
  await act(async () => f.turn?.({ session_id: 'c2', turn_id: 't2' }));
  await waitFor(() => expect(reads('wallet')).toBe(before + 1));
  expect(f.conversation).toHaveBeenCalledTimes(2);
});
it('offers top-up next to an empty balance and returns to the balance on a new balance entry', async () => {
  wallet = { ...baseWallet, wallet_balance: { status: 'available', amount: usd('0') } };
  const cache = new Map();
  const tree = (balanceRequest?: string) => (
    <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false, onError: () => {} }}>
      <CloudAccountProvider>
        <CloudAccount balanceRequest={balanceRequest} />
      </CloudAccountProvider>
    </SWRConfig>
  );
  Element.prototype.scrollIntoView = vi.fn();
  const view = render(tree());
  expect(await screen.findByText('settings.cloudAccount.emptyBalance')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'settings.cloudAccount.topUp' }));
  expect(screen.getByRole('tab', { name: 'settings.cloudAccount.purchaseTab' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  view.rerender(tree('menu-entry'));
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'settings.cloudAccount.overviewTab' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  );
  expect(screen.getByRole('region', { name: 'settings.cloudAccount.wallet', exact: true })).toBeVisible();
  expect(screen.getByText('settings.cloudAccount.supportDetails')).toBeInTheDocument();
});
