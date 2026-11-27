import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CreationModel } from '@/common/chat/document/creation/creation';
import CreationControls from '@/renderer/pages/guid/Creation/CreationControls';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/guid/Creation/CloudModelSetup', () => ({ default: () => null }));

describe('creation model selection', () => {
  const existing: CreationModel = {
    id: 'legacy-h3',
    name: 'Existing H3',
    profileId: 'legacy-h3',
    family: 'h3',
    kind: 'video',
    source: 'local',
    state: 'downloaded',
    available: false,
    intent: 'generate',
  };
  const missing: CreationModel = {
    id: 'fasth3-omni',
    name: 'Missing Omni',
    family: 'fasth3-omni',
    kind: 'video',
    source: 'local',
    state: 'not-installed',
    available: false,
  };
  function setup() {
    const onChange = vi.fn(),
      onManageLocal = vi.fn();
    render(
      <CreationControls
        selection={{ kind: 'video', source: 'local', modelIds: {} }}
        models={[existing, missing]}
        model={existing}
        onChange={onChange}
        onManageLocal={onManageLocal}
      />
    );
    fireEvent.click(screen.getByTestId('creation-model-selector'));
    return { onChange, onManageLocal };
  }
  it('shows the signed-in account section as empty without offering an account setup or a fake model', async () => {
    const model: CreationModel = {
      id: 'preset::cloud-video',
      name: 'MiniMax H3',
      source: 'cloud',
      kind: 'video',
      state: 'not-configured',
      available: false,
    };
    const setDefault = vi.fn();
    const refresh = vi.fn();
    render(
      <CreationControls
        selection={{ kind: 'video', source: 'cloud', modelIds: {} }}
        models={[model]}
        model={model}
        onChange={vi.fn()}
        onManageLocal={vi.fn()}
        accountMedia={{
          accountId: 'u1',
          catalog: { account_id: 'u1', account_key: 'issuer-a-u1', models: [] },
          catalogState: 'empty',
          setDefault,
          defaultModel: undefined,
          refresh,
        }}
      />
    );
    fireEvent.click(screen.getByTestId('creation-model-selector'));
    expect(await screen.findByText('guid.creation.noAccountModels')).toBeVisible();
    expect(screen.getByText('settings.cloudAccount.title')).toBeVisible();
    expect(refresh).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('menuitem', { name: 'settings.cloudAccount.refreshCatalog' }));
    expect(refresh).toHaveBeenLastCalledWith();
    expect(setDefault).not.toHaveBeenCalled();
  });
  it('saves the account default only on an explicit model selection and exposes first-frame support', async () => {
    const model: CreationModel = {
      id: 'account-media:["u1","clip"]',
      name: 'Clip',
      source: 'cloud',
      kind: 'video',
      state: 'configured',
      available: true,
      capabilities: ['image-to-video'],
    };
    const setDefault = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn();
    const onChange = vi.fn();
    render(
      <CreationControls
        selection={{ kind: 'video', source: 'cloud', modelIds: {} }}
        models={[model]}
        model={model}
        onChange={onChange}
        onManageLocal={vi.fn()}
        accountMedia={{
          accountId: 'u1',
          catalog: undefined,
          catalogState: 'available',
          setDefault,
          defaultModel: undefined,
          refresh,
        }}
      />
    );
    fireEvent.click(screen.getByTestId('creation-model-selector'));
    const choice = await screen.findByRole('menuitem', { name: /Clip.*guid.comfy.workflows.tasks.image-to-video/ });
    expect(refresh).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('menuitem', { name: 'settings.cloudAccount.refreshCatalog' }));
    expect(refresh).toHaveBeenLastCalledWith();
    expect(setDefault).not.toHaveBeenCalled();
    fireEvent.click(choice);
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(setDefault).toHaveBeenCalledWith('video', model.id);
  });
  it('selects a downloaded profile for generation without replacing the prompt with repair', async () => {
    const { onChange, onManageLocal } = setup();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Existing H3/ }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onManageLocal).not.toHaveBeenCalled();
  });
  it('offers installation only when there is no registered profile', async () => {
    const { onManageLocal } = setup();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Missing Omni/ }));
    expect(onManageLocal).toHaveBeenCalledWith(missing);
  });
  it('keeps explicit repair available independently of selecting the model', async () => {
    const { onManageLocal } = setup();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'guid.creation.manageLocal' }));
    expect(onManageLocal).toHaveBeenCalledWith(existing);
  });

  it('shows a clear local empty state with a management action and no invented model choices', async () => {
    render(
      <CreationControls
        selection={{ kind: 'video', source: 'local', modelIds: {} }}
        models={[]}
        model={{
          id: 'empty:local-video',
          name: '',
          kind: 'video',
          source: 'local',
          state: 'not-installed',
          available: false,
        }}
        onChange={vi.fn()}
        onManageLocal={vi.fn()}
      />
    );
    expect(screen.getByTestId('creation-model-selector')).toHaveTextContent('guid.creation.noLocalModels');
    fireEvent.click(screen.getByTestId('creation-model-selector'));
    expect(await screen.findByRole('menuitem', { name: 'guid.creation.noLocalModelsHint' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('menuitem', { name: 'guid.creation.manageLocal' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /H3/ })).not.toBeInTheDocument();
  });
});
