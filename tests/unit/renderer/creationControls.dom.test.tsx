import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
});
