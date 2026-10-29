import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Theme } from '@/common/theme/types';

const { configGetMock, configSetMock, publishMock, selectThemeMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  configSetMock: vi.fn(),
  publishMock: vi.fn(),
  selectThemeMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    extensions: { getThemes: { invoke: vi.fn().mockResolvedValue([]) } },
    theme: {
      setActive: { invoke: publishMock },
    },
  },
}));

vi.mock('@/common/utils', () => ({ uuid: () => 'custom-theme' }));
vi.mock('@renderer/utils/platform.ts', () => ({ resolveExtensionAssetUrl: (url?: string) => url }));
vi.mock('@renderer/hooks/context/ThemeContext.tsx', () => ({
  useThemeContext: () => ({ theme: 'light', activeTheme: null, activeId: 'light', selectTheme: selectThemeMock }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@arco-design/web-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arco-design/web-react')>()),
  Message: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/renderer/pages/settings/AppearanceSettings/CssThemeModal.tsx', () => ({
  default: ({ visible }: { visible: boolean }) =>
    visible ? React.createElement('div', { role: 'dialog' }, 'Theme editor') : null,
}));

import { setActiveTheme } from '@/renderer/utils/theme/applyTheme';
import CssThemeSettings from '@/renderer/pages/settings/AppearanceSettings/CssThemeSettings';

type BrowserWindow = Window & { electronAPI?: unknown };

describe('setActiveTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configGetMock.mockReturnValue([]);
    configSetMock.mockResolvedValue(undefined);
    publishMock.mockResolvedValue(undefined);
    delete (window as BrowserWindow).electronAPI;
  });

  afterEach(() => {
    cleanup();
    (window as BrowserWindow).electronAPI = {};
  });

  it('returns the selected theme in WebUI without invoking the Electron relay', async () => {
    const selected = await setActiveTheme('dark');

    expect(selected.appearance).toBe('dark');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('publishes the selected theme when running inside Electron', async () => {
    (window as BrowserWindow).electronAPI = {};

    const selected = await setActiveTheme('dark');

    expect(publishMock).toHaveBeenCalledWith(selected);
  });

  it('rejects when the preference cannot be saved', async () => {
    configSetMock.mockRejectedValue(new Error('save failed'));

    await expect(setActiveTheme('dark')).rejects.toThrow('save failed');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('shows OpenH3 defaults and preserves the light, dark and system selection IDs', async () => {
    selectThemeMock.mockResolvedValue(undefined);
    render(React.createElement(CssThemeSettings));

    const light = await screen.findByRole('button', { name: 'OpenH3 · settings.lightMode' });
    expect(light).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'OpenH3 · settings.darkMode' }));
    expect(selectThemeMock).toHaveBeenCalledWith('dark');
    fireEvent.click(screen.getByRole('button', { name: 'settings.cssTheme.followSystem' }));
    expect(selectThemeMock).toHaveBeenCalledWith('system');
    expect(document.querySelector('[style*="default-theme"]')).toBeNull();
  });

  it('keeps custom theme editing separate from selecting a theme', async () => {
    configGetMock.mockReturnValue([
      {
        id: 'custom',
        name: 'My theme',
        appearance: 'dark',
        css: ':root { --primary: #123456; }',
        builtin: false,
        created_at: 0,
        updated_at: 0,
      } satisfies Theme,
    ]);
    render(React.createElement(CssThemeSettings));

    const edit = await screen.findByRole('button', { name: 'common.edit My theme' });
    fireEvent.click(edit);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(selectThemeMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'My theme', exact: true }));
    expect(selectThemeMock).toHaveBeenCalledWith('custom');
  });
});
