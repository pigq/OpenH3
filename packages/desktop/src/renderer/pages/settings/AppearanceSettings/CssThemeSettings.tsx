/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import type { Theme } from '@/common/theme/types';
import { ipcBridge } from '@/common';
import { uuid } from '@/common/utils';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext.tsx';
import { Button, Message, Modal } from '@arco-design/web-react';
import { EditTwo, CheckOne } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CssThemeModal from './CssThemeModal.tsx';
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from './presets.ts';
import { BACKGROUND_BLOCK_START, injectBackgroundCssBlock } from './backgroundUtils.ts';
import { resolveExtensionAssetUrl } from '@renderer/utils/platform.ts';
import { DARK_THEME_ID, LIGHT_THEME_ID, SYSTEM_THEME_ID } from '@/common/theme/constants';
import defaultThemeCss from '@renderer/styles/themes/default-color-scheme.css?raw';
import styles from './CssThemeSettings.module.css';

interface ThemePreviewPalette {
  appBg: string;
  headerBg: string;
  sideBg: string;
  mainBg: string;
  border: string;
  accent: string;
  textMuted: string;
  userBubble: string;
  aiBubble: string;
}

const stripImportant = (value: string) => value.replace(/\s*!important\s*/gi, '').trim();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeColorLike = (value: string, fallback: string) => {
  const cleaned = stripImportant(value);
  if (!cleaned) return fallback;
  if (cleaned.includes('{{') || cleaned.includes('}}')) return fallback;
  if (/var\(/i.test(cleaned)) return fallback;
  if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(cleaned)) {
    return `rgb(${cleaned})`;
  }
  if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|0?\.\d+|1)$/.test(cleaned)) {
    return `rgba(${cleaned})`;
  }
  return cleaned;
};

const parseCssVarsFromBlocks = (css: string, selector: string) => {
  if (!css) return {};
  const regex = new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`, 'gi');
  const map: Record<string, string> = {};
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = regex.exec(css)) !== null) {
    const block = blockMatch[1] || '';
    const varRegex = /--([a-zA-Z0-9-_]+)\s*:\s*([^;]+);/g;
    let varMatch: RegExpExecArray | null;
    while ((varMatch = varRegex.exec(block)) !== null) {
      map[varMatch[1]] = varMatch[2].trim();
    }
  }
  return map;
};

const resolveCssVarValue = (value: string, vars: Record<string, string>, depth = 0): string => {
  if (!value || depth > 6) return value;
  const cleaned = stripImportant(value);
  const match = cleaned.match(/^var\(\s*--([a-zA-Z0-9-_]+)\s*(?:,\s*(.+))?\)$/);
  if (!match) return cleaned;
  const varName = match[1];
  const fallback = match[2]?.trim();
  if (vars[varName]) {
    return resolveCssVarValue(vars[varName], vars, depth + 1);
  }
  if (fallback) {
    return resolveCssVarValue(fallback, vars, depth + 1);
  }
  return cleaned;
};

const readFromVarMap = (vars: Record<string, string>, keys: string[]) => {
  for (const key of keys) {
    const value = vars[key];
    if (value) return resolveCssVarValue(value, vars);
  }
  return '';
};

// Read the shipped tokens so the gallery stays faithful to the actual default
// theme in both appearances, regardless of the currently selected appearance.
const defaultPreviewPalette = (mode: 'light' | 'dark'): ThemePreviewPalette => {
  const vars = {
    ...parseCssVarsFromBlocks(defaultThemeCss, "[data-color-scheme='default']"),
    ...(mode === 'dark'
      ? parseCssVarsFromBlocks(defaultThemeCss, "[data-color-scheme='default'][data-theme='dark']")
      : {}),
  };
  const read = (...keys: string[]) => readFromVarMap(vars, keys);
  return {
    appBg: read('bg-1'),
    headerBg: read('bg-base'),
    sideBg: read('bg-1'),
    mainBg: read('bg-base'),
    border: read('border-base'),
    accent: read('primary'),
    textMuted: read('text-secondary'),
    userBubble: read('message-user-bg'),
    aiBubble: read('bg-2'),
  };
};
const fallbackThemePreviewPaletteByMode = {
  light: defaultPreviewPalette('light'),
  dark: defaultPreviewPalette('dark'),
};

const extractThemePreviewPalette = (css: string, mode: 'light' | 'dark'): ThemePreviewPalette => {
  const modeFallback = fallbackThemePreviewPaletteByMode[mode];
  const rootVars = parseCssVarsFromBlocks(css, ':root');
  const darkVars = {
    ...parseCssVarsFromBlocks(css, "[data-theme='dark']"),
    ...parseCssVarsFromBlocks(css, '[data-theme="dark"]'),
    ...parseCssVarsFromBlocks(css, '[data-theme=dark]'),
  };
  const activeVars = mode === 'dark' ? { ...rootVars, ...darkVars } : rootVars;

  const appBgRaw = readFromVarMap(activeVars, ['bg-1', 'color-bg-1']);
  const panelBgRaw = readFromVarMap(activeVars, ['bg-2', 'color-bg-2', 'fill-1', 'color-fill-1']);
  const borderRaw = readFromVarMap(activeVars, ['bg-3', 'color-border-2', 'border-base']);
  const accentRaw = readFromVarMap(activeVars, ['primary', 'color-primary', 'color-primary-base', 'primary-6']);
  const textMutedRaw = readFromVarMap(activeVars, ['color-text-3', 'text-secondary', 'color-text-2']);
  const aiBubbleRaw = readFromVarMap(activeVars, ['color-fill-2', 'fill-2', 'bg-2', 'color-bg-2']);
  const userBubbleRaw = readFromVarMap(activeVars, [
    'message-user-bg',
    'color-primary-light-3',
    'color-primary-light-2',
    'color-primary',
  ]);

  return {
    appBg: normalizeColorLike(appBgRaw, modeFallback.appBg),
    headerBg: normalizeColorLike(panelBgRaw, modeFallback.headerBg),
    sideBg: normalizeColorLike(panelBgRaw, modeFallback.sideBg),
    mainBg: normalizeColorLike(appBgRaw, modeFallback.mainBg),
    border: normalizeColorLike(borderRaw, modeFallback.border),
    accent: normalizeColorLike(accentRaw, modeFallback.accent),
    textMuted: normalizeColorLike(textMutedRaw, modeFallback.textMuted),
    userBubble: normalizeColorLike(userBubbleRaw, modeFallback.userBubble),
    aiBubble: normalizeColorLike(aiBubbleRaw, modeFallback.aiBubble),
  };
};

const ThemeLayoutPreview: React.FC<{ palette: ThemePreviewPalette }> = ({ palette }) => {
  return (
    <div className='absolute inset-0 pointer-events-none' aria-hidden='true'>
      <div className='absolute inset-0' style={{ background: palette.appBg }} />
      <div
        className='absolute start-8px end-8px top-8px bottom-8px rounded-8px overflow-hidden border border-solid'
        style={{ borderColor: palette.border, background: palette.mainBg }}
      >
        <div
          className='h-20px border-b border-solid flex items-center px-6px gap-4px'
          style={{ borderColor: palette.border, background: palette.headerBg }}
        >
          <span className='block w-5px h-5px rounded-full' style={{ background: palette.accent, opacity: 0.9 }}></span>
          <span className='text-8px font-semibold tracking-0.2px' style={{ color: palette.textMuted }}>
            OpenH3
          </span>
          <span
            className='block w-12px h-4px rounded-full ms-auto'
            style={{ background: palette.border, opacity: 0.45 }}
          ></span>
        </div>
        <div style={{ height: 'calc(100% - 20px)', display: 'flex' }}>
          <div
            className='border-e border-solid px-3px py-3px flex flex-col gap-3px'
            style={{ width: '23%', borderColor: palette.border, background: palette.sideBg }}
          >
            <span className='block h-3px rounded-full' style={{ background: palette.textMuted, opacity: 0.4 }}></span>
            <span
              className='block h-3px rounded-full w-4/5'
              style={{ background: palette.textMuted, opacity: 0.33 }}
            ></span>
            <span
              className='block h-3px rounded-full w-3/5'
              style={{ background: palette.textMuted, opacity: 0.28 }}
            ></span>
          </div>
          <div
            className='border-e border-solid px-4px py-4px flex flex-col gap-4px'
            style={{ width: '54%', borderColor: palette.border, background: palette.mainBg }}
          >
            <span
              className='block h-6px rounded-[6px] w-4/5'
              style={{ background: palette.aiBubble, opacity: 0.9 }}
            ></span>
            <span
              className='block h-6px rounded-[6px] w-3/5 self-end'
              style={{ background: palette.userBubble, opacity: 0.95 }}
            ></span>
            <span
              className='block h-6px rounded-[6px] w-2/3'
              style={{ background: palette.aiBubble, opacity: 0.82 }}
            ></span>
          </div>
          <div className='px-3px py-3px flex flex-col gap-3px' style={{ width: '23%', background: palette.sideBg }}>
            <span className='block h-3px rounded-full' style={{ background: palette.textMuted, opacity: 0.36 }}></span>
            <span
              className='block h-3px rounded-full w-5/6'
              style={{ background: palette.textMuted, opacity: 0.3 }}
            ></span>
          </div>
        </div>
      </div>
    </div>
  );
};

/** Diagonal split preview for the "Follow System" card: light top-left, dark bottom-right. */
const SystemThemePreview: React.FC = () => (
  <div className='absolute inset-0 pointer-events-none'>
    <ThemeLayoutPreview palette={fallbackThemePreviewPaletteByMode.light} />
    <div className='absolute inset-0' style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}>
      <ThemeLayoutPreview palette={fallbackThemePreviewPaletteByMode.dark} />
    </div>
  </div>
);

const ensureBackgroundCss = <T extends { id?: string; cover?: string; css?: string; builtin?: boolean }>(
  theme: T
): T => {
  // Skip builtin themes (Light/Dark have no decorative css to inject)
  if (theme.builtin) {
    return theme;
  }
  if (theme.cover && theme.css && !theme.css.includes(BACKGROUND_BLOCK_START)) {
    return { ...theme, css: injectBackgroundCssBlock(theme.css, theme.cover) };
  }
  return theme;
};

/**
 * CSS 主题设置组件 / CSS Theme Settings Component
 * 用于管理和切换 CSS 皮肤主题 / For managing and switching CSS skin themes
 */
const CssThemeSettings: React.FC = () => {
  const { t } = useTranslation();
  const { theme: currentTheme, activeTheme, activeId, selectTheme } = useThemeContext();
  const [themes, setThemes] = useState<Theme[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingTheme, setEditingTheme] = useState<Theme | null>(null);

  const activeThemeId = activeId ?? activeTheme?.id ?? DEFAULT_THEME_ID;
  const themeName = useCallback(
    (theme: Theme) =>
      theme.id === LIGHT_THEME_ID
        ? `OpenH3 · ${t('settings.lightMode')}`
        : theme.id === DARK_THEME_ID
          ? `OpenH3 · ${t('settings.darkMode')}`
          : theme.name,
    [t]
  );

  const themePreviewPalettes = useMemo(() => {
    const map = new Map<string, ThemePreviewPalette>();
    themes.forEach((cssTheme) => {
      map.set(cssTheme.id, extractThemePreviewPalette(cssTheme.css || '', cssTheme.appearance));
    });
    return map;
  }, [themes]);

  // Virtual "Follow System" card, third in the gallery (after Light and Dark).
  // Not part of BUILTIN_THEMES — it must never enter resolution/dedup/persistence.
  const displayThemes = useMemo(() => {
    if (themes.length === 0) return themes;
    const systemCard: Theme = {
      id: SYSTEM_THEME_ID,
      name: t('settings.cssTheme.followSystem'),
      appearance: 'light',
      builtin: true,
      created_at: 0,
      updated_at: 0,
    };
    const arr = [...themes];
    arr.splice(Math.min(2, arr.length), 0, systemCard);
    return arr;
  }, [themes, t]);

  // 加载主题列表 / Load theme list
  useEffect(() => {
    const loadThemes = async () => {
      try {
        const userThemes = (configService.get('theme.userThemes') as Theme[]) ?? [];

        // Apply background CSS to user themes that have cover images
        const normalizedUserThemes = userThemes.map((theme) => ensureBackgroundCss(theme));

        // 加载扩展主题 / Load extension-contributed themes
        let extensionThemes: Theme[] = [];
        try {
          const loadedExtensionThemes = await ipcBridge.extensions.getThemes.invoke();
          // Map extension themes to Theme shape (css-only, builtin: true, appearance inferred as 'light')
          extensionThemes = loadedExtensionThemes.map((theme) => ({
            id: theme.id,
            name: theme.name,
            cover: resolveExtensionAssetUrl(theme.cover),
            css: theme.css,
            appearance: 'light' as const,
            builtin: true,
            created_at: theme.created_at ?? 0,
            updated_at: theme.updated_at ?? 0,
          }));
        } catch {
          // Extensions not available (e.g., WebUI mode or not initialized yet)
        }

        // 合并主题，按 ID 去重（先出现的优先）
        // Merge builtin, extension, and user themes; deduplicate by ID (first occurrence wins)
        const seenIds = new Set<string>();
        const allThemes: Theme[] = [];
        for (const theme of [...BUILTIN_THEMES, ...extensionThemes, ...normalizedUserThemes]) {
          if (!theme?.id || seenIds.has(theme.id)) continue;
          seenIds.add(theme.id);
          allThemes.push(theme);
        }

        setThemes(allThemes);
      } catch (error) {
        console.error('Failed to load CSS themes:', error);
      }
    };
    void loadThemes();
  }, []);

  /**
   * 选择主题 / Select theme
   */
  const handleSelectTheme = useCallback(
    async (theme: Theme) => {
      try {
        await selectTheme(theme.id);
        Message.success(t('settings.cssTheme.applied', { name: themeName(theme) }));
      } catch {
        Message.error(t('settings.cssTheme.applyFailed'));
      }
    },
    [selectTheme, t, themeName]
  );

  /**
   * 打开添加主题弹窗 / Open add theme modal
   */
  const handleAddTheme = useCallback(() => {
    setEditingTheme(null);
    setModalVisible(true);
  }, []);

  /**
   * 打开编辑主题弹窗 / Open edit theme modal
   */
  const handleEditTheme = useCallback((theme: Theme) => {
    setEditingTheme(theme);
    setModalVisible(true);
  }, []);

  /**
   * 保存主题 / Save theme
   */
  const handleSaveTheme = useCallback(
    async (themeData: Omit<Theme, 'id' | 'created_at' | 'updated_at' | 'builtin'>) => {
      try {
        const now = Date.now();
        let updatedThemes: Theme[];
        const normalizedThemeData = ensureBackgroundCss({ ...themeData, builtin: false });

        let savedId: string | undefined;
        if (editingTheme && !editingTheme.builtin) {
          // 更新现有用户主题 / Update existing user theme
          savedId = editingTheme.id;
          updatedThemes = themes.map((t) => (t.id === savedId ? { ...t, ...normalizedThemeData, updated_at: now } : t));
        } else {
          // 添加新主题 / Add new theme
          const newTheme: Theme = {
            id: uuid(),
            ...normalizedThemeData,
            tokens: undefined,
            builtin: false,
            created_at: now,
            updated_at: now,
          };
          updatedThemes = [...themes, newTheme];
        }

        // 只保存用户主题 / Only save user themes — persist BEFORE re-applying so selectTheme reads updated css
        const userThemes = updatedThemes.filter((t) => !t.builtin);
        await configService.set('theme.userThemes', userThemes);

        setThemes(updatedThemes);

        // If the saved theme is the active one, re-apply to pick up changes
        if (savedId !== undefined && activeThemeId === savedId) {
          await selectTheme(savedId);
        }

        setModalVisible(false);
        setEditingTheme(null);
        Message.success(t('common.saveSuccess'));
      } catch (error) {
        console.error('Failed to save theme:', error);
        Message.error(t('common.saveFailed'));
      }
    },
    [editingTheme, themes, activeThemeId, selectTheme, t]
  );

  /**
   * 删除主题 / Delete theme
   */
  const handleDeleteTheme = useCallback(
    (themeId: string) => {
      Modal.confirm({
        title: t('common.confirmDelete'),
        content: t('settings.cssTheme.deleteConfirm'),
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          try {
            const updatedThemes = themes.filter((t) => t.id !== themeId);
            const userThemes = updatedThemes.filter((t) => !t.builtin);
            await configService.set('theme.userThemes', userThemes);

            // 如果删除的是当前激活主题，回退到 Light / If deleting active theme, fall back to Light
            if (activeThemeId === themeId) {
              await selectTheme(LIGHT_THEME_ID);
            }

            setThemes(updatedThemes);
            setModalVisible(false);
            setEditingTheme(null);
            Message.success(t('common.deleteSuccess'));
          } catch (error) {
            console.error('Failed to delete theme:', error);
            Message.error(t('common.deleteFailed'));
          }
        },
      });
    },
    [themes, activeThemeId, selectTheme, t]
  );

  return (
    <div className='space-y-12px'>
      {/* 标题栏 / Header */}
      <div className='flex items-start md:items-center justify-between gap-8px flex-wrap'>
        <span className='text-14px text-t-secondary leading-22px'>{t('settings.cssTheme.selectOrCustomize')}</span>
        <Button type='primary' size='small' className='!h-32px !rounded-8px !px-14px !m-0' onClick={handleAddTheme}>
          {t('settings.cssTheme.addManually')}
        </Button>
      </div>

      {/* 主题卡片列表 / Theme card list.
          Fixed-width cards that wrap: a full row packs several cards, while a
          short list (e.g. just Light/Dark/Follow System) stays at its natural
          size and leaves the trailing space empty instead of stretching each
          card across the whole row. */}
      <div className={styles.gallery}>
        {displayThemes.map((theme) => {
          const previewPalette =
            themePreviewPalettes.get(theme.id) ||
            fallbackThemePreviewPaletteByMode[currentTheme === 'dark' ? 'dark' : 'light'];
          const cardStyle = theme.cover
            ? {
                backgroundImage: `url(${theme.cover})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
                backgroundColor: previewPalette.appBg,
              }
            : { backgroundColor: previewPalette.appBg };
          return (
            <div
              key={theme.id}
              data-testid={`theme-card-${theme.id}`}
              data-active={activeThemeId === theme.id}
              className={styles.card}
            >
              <Button
                type='text'
                className={styles.selectButton}
                aria-label={themeName(theme)}
                aria-pressed={activeThemeId === theme.id}
                onClick={() => void handleSelectTheme(theme)}
              >
                <div className={styles.preview} style={cardStyle}>
                  {theme.id === SYSTEM_THEME_ID ? (
                    <SystemThemePreview />
                  ) : (
                    !theme.cover && <ThemeLayoutPreview palette={previewPalette} />
                  )}
                </div>
                <div className={styles.caption}>
                  <span className={styles.name}>{themeName(theme)}</span>
                  {activeThemeId === theme.id && (
                    <CheckOne size={16} theme='filled' fill='var(--primary)' aria-hidden='true' />
                  )}
                </div>
              </Button>
              {!theme.builtin && (
                <Button
                  type='text'
                  size='mini'
                  className={styles.editButton}
                  aria-label={`${t('common.edit')} ${themeName(theme)}`}
                  icon={<EditTwo size={14} fill='var(--text-secondary)' />}
                  onClick={() => handleEditTheme(theme)}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* 主题编辑弹窗 / Theme edit modal */}
      <CssThemeModal
        visible={modalVisible}
        theme={editingTheme}
        onClose={() => {
          setModalVisible(false);
          setEditingTheme(null);
        }}
        onSave={handleSaveTheme}
        onDelete={editingTheme && !editingTheme.builtin ? () => handleDeleteTheme(editingTheme.id) : undefined}
      />
    </div>
  );
};

export default CssThemeSettings;
