import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import ComfyModelCards from '@/renderer/pages/guid/components/ComfyModelCards';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh-CN' }, t: (key: string) => key }) }));
const profile = (id: string, state: ComfyProfile['state']) =>
  ({ id, name: id, family: 'qwen-edit', kind: 'image', state, version: '2509', quantization: 'FP8' }) as ComfyProfile;

describe('ComfyUI family cards', () => {
  it('uses the accessible library selector to browse versions and repairs the selected unavailable profile', async () => {
    const onAction = vi.fn();
    const onUse = vi.fn();
    const { container } = render(
      <ComfyModelCards
        profiles={[profile('qwen-verified', 'verified'), profile('qwen-downloaded', 'downloaded')]}
        onAction={onAction}
        onUseProfile={onUse}
      />
    );
    expect(container.querySelector('select')).toBeNull();
    const qwen = within(screen.getByRole('region', { name: 'Qwen-Edit' }));
    fireEvent.click(qwen.getByRole('combobox'));
    fireEvent.click(await screen.findByText(/qwen-downloaded ·/));
    await waitFor(() => expect(qwen.queryByRole('button', { name: 'guid.comfy.use' })).not.toBeInTheDocument());
    fireEvent.click(qwen.getByRole('button', { name: 'guid.comfy.actions.repair' }));
    expect(onAction).toHaveBeenCalledWith({ family: 'qwen-edit', intent: 'repair', profileId: 'qwen-downloaded' });
    expect(onUse).not.toHaveBeenCalled();
  });

  it('keeps use unavailable until the inventory check succeeds', () => {
    render(
      <ComfyModelCards
        profiles={[profile('qwen-verified', 'verified')]}
        unavailable
        onAction={vi.fn()}
        onUseProfile={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'guid.comfy.use' })).toBeDisabled();
  });
});
