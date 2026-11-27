import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IProvider } from '@/common/config/storage';
const f = vi.hoisted(() => ({
  providers: [] as IProvider[],
  scope: 'a:1',
  connected: true,
  refreshCatalog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/renderer/hooks/agent/useGoogleAuthModels', () => ({ useGoogleAuthModels: () => ({ isGoogleAuth: false }) }));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({ useProvidersQuery: () => ({ data: f.providers }) }));
vi.mock('@/renderer/components/settings/SettingsModal/CloudAccount/Provider', () => ({
  useOptionalCloudAccount: () => ({
    scope: f.scope,
    session: { state: f.connected ? 'connected' : 'disconnected' },
    refreshCatalog: f.refreshCatalog,
  }),
}));
import { useGuidModelSelection } from '@/renderer/pages/guid/hooks/useGuidModelSelection';
import GuidModelSelector from '@/renderer/pages/guid/components/GuidModelSelector';
const official: IProvider = {
  id: 'official',
  name: 'Official',
  platform: 'openai',
  base_url: '',
  api_key: '',
  managed_by: 'cloud_account',
  models: ['plain'],
  model_settings: { plain: { supports_tools: false, openai_api_mode: 'responses' } },
};
const byok: IProvider = {
  id: 'byok',
  name: 'BYOK',
  platform: 'openai',
  base_url: '',
  api_key: '',
  models: ['own-model'],
};
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
  });
  f.providers = [official, byok];
  f.connected = true;
  f.scope = 'a:1';
});
afterEach(cleanup);
it('offers a unique tool-less official model through the actual Guid selector and keeps disabled rows out', async () => {
  const disabled = { ...official, id: 'disabled', enabled: false, models: ['disabled-model'] };
  f.providers = [official, disabled, byok];
  const Selector = () => {
    const selected = useGuidModelSelection();
    return (
      <>
        <span data-testid='chosen'>{selected.current_model?.use_model}</span>
        <GuidModelSelector
          isGeminiMode
          modelList={selected.modelList}
          current_model={selected.current_model}
          setCurrentModel={selected.setCurrentModel}
          currentAcpCachedModelInfo={null}
          selectedAcpModel={null}
          setSelectedAcpModel={() => {}}
        />
      </>
    );
  };
  render(<Selector />);
  fireEvent.mouseEnter(screen.getByTestId('guid-model-selector'));
  expect(await screen.findByText('settings.cloudAccount.official · Official')).toBeInTheDocument();
  expect(screen.getByText('settings.cloudAccount.byok · BYOK')).toBeInTheDocument();
  expect(screen.queryByText('disabled-model')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('plain'));
  await waitFor(() => expect(screen.getByTestId('chosen')).toHaveTextContent('plain'));
});
it('admits actual tool-less official models but never defaults to or resumes official without explicit choice', async () => {
  const { result, rerender } = renderHook(() => useGuidModelSelection());
  expect(result.current.modelList.map((p) => p.id)).toContain('official');
  expect(result.current.current_model?.managed_by).not.toBe('cloud_account');
  await act(() => result.current.setCurrentModel({ ...official, use_model: 'plain' }));
  expect(result.current.current_model?.use_model).toBe('plain');
  f.providers = [{ ...official, models: [], enabled: false }, byok];
  rerender();
  await waitFor(() => expect(result.current.current_model).toBeUndefined());
  f.providers = [official, byok];
  rerender();
  expect(result.current.current_model).toBeUndefined();
  await act(() => result.current.setCurrentModel({ ...byok, use_model: 'own-model' }));
  expect(result.current.current_model?.use_model).toBe('own-model');
});
it('fences disabled official and same-account generation changes without mutating BYOK', async () => {
  const { result, rerender } = renderHook(() => useGuidModelSelection());
  await act(() => result.current.setCurrentModel({ ...official, use_model: 'plain' }));
  f.scope = 'a:2';
  f.connected = false;
  rerender();
  expect(result.current.current_model).toBeUndefined();
  f.connected = true;
  rerender();
  expect(result.current.current_model).toBeUndefined();
  await act(() => result.current.setCurrentModel({ ...byok, use_model: 'own-model' }));
  f.scope = 'b:1';
  rerender();
  expect(result.current.current_model?.use_model).toBe('own-model');
});
it('requires reselection when the same official model changes actual protocol', async () => {
  const { result, rerender } = renderHook(() => useGuidModelSelection());
  await act(() => result.current.setCurrentModel({ ...official, use_model: 'plain' }));
  f.providers = [
    { ...official, model_settings: { plain: { supports_tools: false, openai_api_mode: 'chat_completions' } } },
    byok,
  ];
  rerender();
  expect(result.current.current_model).toBeUndefined();
  f.providers = [official, byok];
  rerender();
  expect(result.current.current_model).toBeUndefined();
});
it('rejects automatic assistant defaults for official models and keeps withdrawal blocked until a user chooses', async () => {
  const { result, rerender } = renderHook(() => useGuidModelSelection());
  await act(() => result.current.setCurrentModel({ ...official, use_model: 'plain' }, { automatic: true }));
  expect(result.current.current_model?.managed_by).not.toBe('cloud_account');
  await act(() => result.current.setCurrentModel({ ...official, use_model: 'plain' }));
  f.providers = [byok];
  rerender();
  await waitFor(() => expect(result.current.current_model).toBeUndefined());
  await act(() => result.current.setCurrentModel({ ...byok, use_model: 'own-model' }, { automatic: true }));
  expect(result.current.current_model).toBeUndefined();
  await act(() => result.current.setCurrentModel({ ...byok, use_model: 'own-model' }));
  expect(result.current.current_model?.use_model).toBe('own-model');
});
