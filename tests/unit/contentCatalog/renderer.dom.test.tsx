import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ContentUpdatePanel from '@/renderer/components/ContentCatalog/ContentUpdatePanel';
import type { ContentStatus } from '@/common/contentCatalog/schema';
const { act, model } = vi.hoisted(() => ({
  act: vi.fn(async () => {}),
  model: { status: undefined as ContentStatus | undefined },
}));
vi.mock('@/renderer/components/ContentCatalog/useContentCatalog', () => ({
  useContentCatalog: () => ({ ...model, act }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  act.mockClear();
  model.status = { phase: 'ready', activeSequence: 2, sourceConfigured: true, autoSync: true, canManage: true };
});
describe('independent official content controls', () => {
  it('keeps all host-management controls disabled for readers, including cancel', () => {
    model.status = { ...model.status!, phase: 'downloading', canManage: false };
    render(<ContentUpdatePanel />);
    expect((screen.getByRole('button', { name: 'update.content.cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'update.content.cancel' }));
    expect(act).not.toHaveBeenCalled();
  });
  it('shows added, modified and withdrawn entries independently of client updates', () => {
    model.status = {
      ...model.status!,
      changes: {
        from: 1,
        to: 2,
        added: ['official:new'],
        changed: ['official:changed'],
        removed: ['official:withdrawn'],
      },
    };
    render(<ContentUpdatePanel />);
    expect(screen.getByText('official:new')).toBeTruthy();
    expect(screen.getByText('official:withdrawn')).toBeTruthy();
    expect(screen.queryByText(/重启并更新/)).toBeNull();
  });
  it('checks the content channel without invoking the application installer', () => {
    render(<ContentUpdatePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'update.content.check' }));
    expect(act).toHaveBeenCalledWith('check', undefined);
  });
});
