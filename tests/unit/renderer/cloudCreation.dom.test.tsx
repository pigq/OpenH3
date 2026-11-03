import React from 'react';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudCreationModels } from '@/common/chat/document/creation/cloudModels';
import type { IProvider } from '@/common/config/storage';
import CloudModelSetup from '@/renderer/pages/guid/Creation/CloudModelSetup';
import useConfigModelListWithImage from '@/renderer/hooks/agent/useConfigModelListWithImage';

const state = vi.hoisted(() => ({ providers: [] as IProvider[], create: vi.fn(), update: vi.fn(), mutate: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: { mode: { createProvider: { invoke: state.create }, updateProvider: { invoke: state.update } } },
}));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useProvidersQuery: () => ({ data: state.providers, mutate: state.mutate }),
}));

const provider = (): IProvider => ({
  id: 'mine',
  name: 'My APIYi',
  platform: 'openai',
  base_url: 'https://api.apiyi.com/v1',
  api_key: 'private-existing-key',
  models: ['gpt-image-2.5-all', 'chat-model'],
});
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }))
  );
  vi.clearAllMocks();
  state.providers = [];
  state.create.mockImplementation(async (body) => ({ id: 'created', ...body }));
  state.update.mockImplementation(async (body) => ({ ...provider(), ...body }));
  state.mutate.mockResolvedValue(undefined);
});

describe('cloud creation catalog and setup', () => {
  it('supplements current image model IDs for existing Gemini and OpenRouter accounts', () => {
    state.providers = [
      { ...provider(), id: 'google', platform: 'gemini', base_url: '', models: ['chat-model'] },
      { ...provider(), id: 'router', platform: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', models: [] },
    ];
    const { result } = renderHook(() => useConfigModelListWithImage());
    const models = cloudCreationModels(result.current.modelListWithImage, 'image');
    expect(models.find((model) => model.provider?.id === 'google')?.name).toBe('gemini-2.5-flash-image');
    expect(models.find((model) => model.provider?.id === 'router')?.name).toBe('google/gemini-2.5-flash-image');
    expect(state.providers[0].models).toEqual(['chat-model']);
  });

  it('offers public presets without claiming they are configured', () => {
    const models = cloudCreationModels([], 'image');
    expect(models.find((model) => model.presetId === 'apiyi')).toMatchObject({
      name: 'gpt-image-2.5-all',
      available: false,
      state: 'not-configured',
    });
    expect(cloudCreationModels([], 'video')[0]).toMatchObject({ available: false, state: 'not-configured' });
  });

  it('replaces the documented H3 preset with its saved connection', () => {
    const models = cloudCreationModels([], 'video', [
      {
        id: 'mine',
        name: 'MiniMax H3',
        protocol: 'vllm-h3',
        baseUrl: 'http://10.1.1.32:8091/v1/',
        model: '/home/huhq/h3/models/MiniMax-H3',
        hasApiKey: false,
      },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'cloud-video:mine', available: true, state: 'configured' });
  });

  it('merges the public catalog with user providers and honors disabled models', () => {
    const mine = provider();
    const models = cloudCreationModels([mine], 'image');
    expect(models.filter((model) => model.name === 'gpt-image-2.5-all')).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'mine::gpt-image-2.5-all', available: true });
    expect(cloudCreationModels([{ ...mine, api_key: '' }], 'image')[0].available).toBe(false);
    expect(
      cloudCreationModels([{ ...mine, model_enabled: { 'gpt-image-2.5-all': false } }], 'image').some(
        (model) => model.provider?.id === mine.id
      )
    ).toBe(false);
  });

  it('saves the selected preset with the user key and selects the returned provider', async () => {
    const saved = vi.fn();
    render(<CloudModelSetup model={cloudCreationModels([], 'image')[0]} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText('settings.apiKey'), { target: { value: 'user-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith('created::gpt-image-2.5-all'));
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key: 'user-test-key',
        base_url: 'https://api.apiyi.com/v1',
        models: ['gpt-image-2.5-all'],
      })
    );
  });

  it('keeps an existing key and unrelated models when editing the same endpoint', async () => {
    state.providers = [provider()];
    render(
      <CloudModelSetup model={cloudCreationModels(state.providers, 'image')[0]} onClose={vi.fn()} onSaved={vi.fn()} />
    );
    expect(screen.getByLabelText('settings.apiKey')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(state.update).toHaveBeenCalled());
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mine',
        api_key: 'private-existing-key',
        models: ['gpt-image-2.5-all', 'chat-model'],
      })
    );
  });

  it('edits the selected account when two providers share the same API URL', async () => {
    state.providers = [{ ...provider(), id: 'other-account', api_key: 'other-key' }, provider()];
    const selected = cloudCreationModels(state.providers, 'image').find((model) => model.provider?.id === 'mine')!;
    render(<CloudModelSetup model={selected} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(state.update).toHaveBeenCalled());
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine', api_key: 'private-existing-key' }));
  });

  it('requires an explicit new key when the endpoint is changed', async () => {
    state.providers = [provider()];
    render(
      <CloudModelSetup model={cloudCreationModels(state.providers, 'image')[0]} onClose={vi.fn()} onSaved={vi.fn()} />
    );
    fireEvent.change(screen.getByLabelText('guid.creation.cloudSetup.baseUrl'), {
      target: { value: 'https://other.example/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await screen.findByText('guid.creation.cloudSetup.invalid');
    expect(state.update).not.toHaveBeenCalled();
  });
});
