/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useSyncExternalStore } from 'react';
import {
  getSidebarUpdateState,
  subscribeSidebarUpdateState,
  requestSidebarUpdateAction,
} from '@/renderer/components/settings/updateReadyState';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@arco-design/web-react';
import { ArrowCircleLeft, CloseOne, Download, Moon, SettingTwo, SunOne } from '@icon-park/react';
import classNames from 'classnames';
import { iconColors } from '@renderer/styles/colors';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import styles from './Sider.module.css';

interface SiderFooterProps {
  isMobile: boolean;
  isSettings: boolean;
  collapsed?: boolean;
  theme: string;
  siderTooltipProps: SiderTooltipProps;
  onSettingsClick: () => void;
  onThemeToggle: () => void;
  showLogout?: boolean;
  onLogoutClick?: () => void;
}

const SiderFooter: React.FC<SiderFooterProps> = ({
  isMobile,
  isSettings,
  collapsed = false,
  theme,
  siderTooltipProps,
  onSettingsClick,
  onThemeToggle,
  showLogout = false,
  onLogoutClick,
}) => {
  const { t } = useTranslation();
  const update = useSyncExternalStore(subscribeSidebarUpdateState, getSidebarUpdateState);
  const showUpdate =
    isElectronDesktop() &&
    update &&
    ['available', 'downloading', 'downloaded', 'preparing-install', 'error'].includes(update.status) &&
    Boolean(update.autoUpdateInfo?.version || update.updateInfo?.version);
  const updateLabel =
    update?.status === 'downloading'
      ? t('update.sidebarDownloading', { percent: update.progress.percent })
      : update?.status === 'downloaded'
        ? t(update.downloadPath ? 'update.openInstaller' : 'update.sidebarWaitingForIdle')
        : update?.status === 'preparing-install'
          ? t('update.preparingInstall')
          : update?.status === 'error'
            ? t('update.sidebarRetry')
            : t('update.sidebarAvailable');

  const settingsIcon = isSettings ? (
    <ArrowCircleLeft
      theme='outline'
      size='16'
      fill='currentColor'
      className='block leading-none'
      style={{ lineHeight: 0 }}
    />
  ) : (
    <SettingTwo
      theme='outline'
      size='16'
      fill='currentColor'
      className='block leading-none'
      style={{ lineHeight: 0 }}
    />
  );
  const showThemeToggle = isSettings && !collapsed;
  const themeTooltip = theme === 'dark' ? t('settings.lightMode') : t('settings.darkMode');

  return (
    <div className='shrink-0 sider-footer mt-auto pt-8px pb-8px border-t border-solid border-[var(--color-border-2)] border-s-0 border-e-0 border-b-0'>
      <div className={classNames('flex', collapsed ? 'flex-col gap-2px' : 'items-center gap-2px')}>
        <Tooltip {...siderTooltipProps} content={isSettings ? t('common.back') : t('common.settings')} position='right'>
          <div
            onClick={onSettingsClick}
            className={classNames(
              'group h-34px flex items-center rd-0.5rem cursor-pointer transition-colors',
              collapsed ? 'w-full justify-center' : 'flex-1 min-w-0 justify-start gap-8px ps-10px pe-8px',
              isMobile && 'sider-footer-btn-mobile',
              {
                'bg-fill-3': isSettings,
                'hover:bg-fill-3 active:bg-fill-4': !isSettings,
              }
            )}
          >
            <span className='size-22px flex items-center justify-center shrink-0 text-t-secondary'>{settingsIcon}</span>
            <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px truncate'>
              {isSettings ? t('common.back') : t('common.settings')}
            </span>
          </div>
        </Tooltip>
        {showUpdate && (
          <Tooltip
            className={siderTooltipProps.className}
            getPopupContainer={siderTooltipProps.getPopupContainer}
            unmountOnExit
            popupHoverStay={false}
            trigger={['hover', 'focus']}
            content={updateLabel}
            position='top'
          >
            <Button
              type='text'
              size='small'
              shape='circle'
              aria-label={updateLabel}
              aria-busy={update.status === 'downloading' || update.status === 'preparing-install'}
              aria-disabled={update.status === 'preparing-install'}
              data-update-status={update.status}
              onClick={update.status === 'preparing-install' ? undefined : requestSidebarUpdateAction}
              className={classNames(
                'sider-update-button shrink-0 !h-34px !w-34px !p-0',
                styles.updateButton,
                collapsed && '!self-center'
              )}
              icon={
                <span aria-hidden='true' className='relative inline-flex'>
                  <Download size='16' strokeWidth={3} fill='currentColor' />
                  {update.status === 'available' && <span aria-hidden='true' className={styles.updateDot} />}
                </span>
              }
            />
          </Tooltip>
        )}
        {showLogout && onLogoutClick && (
          <Tooltip {...siderTooltipProps} content={t('settings.googleLogout')} position='right'>
            <div
              onClick={onLogoutClick}
              className={classNames(
                'h-32px flex items-center rd-0.5rem cursor-pointer transition-colors hover:bg-[rgba(var(--primary-6),0.14)] active:bg-fill-2',
                collapsed ? 'w-full justify-center' : 'flex-1 min-w-0 justify-start gap-10px px-14px',
                isMobile && 'sider-footer-btn-mobile'
              )}
            >
              <span className='size-20px flex items-center justify-center shrink-0'>
                <CloseOne
                  theme='outline'
                  size='16'
                  fill={iconColors.primary}
                  className='block leading-none'
                  style={{ lineHeight: 0 }}
                />
              </span>
              <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px truncate'>
                {t('settings.googleLogout')}
              </span>
            </div>
          </Tooltip>
        )}
        {/* Theme toggle — lightweight icon button, only while inside Settings page (not in collapsed mode) */}
        {showThemeToggle && (
          <Tooltip {...siderTooltipProps} content={themeTooltip} position='right'>
            <div
              onClick={onThemeToggle}
              data-testid='theme-toggle'
              className={classNames(
                'h-32px w-40px shrink-0 flex items-center justify-center cursor-pointer rd-0.5rem transition-colors text-t-secondary hover:bg-fill-2 hover:text-t-primary active:bg-fill-3',
                isMobile && 'sider-footer-btn-mobile'
              )}
              aria-label={themeTooltip}
            >
              <span className='w-28px h-28px flex items-center justify-center shrink-0'>
                {theme === 'dark' ? (
                  <SunOne theme='outline' size='18' fill='currentColor' className='block leading-none' />
                ) : (
                  <Moon theme='outline' size='18' fill='currentColor' className='block leading-none' />
                )}
              </span>
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

export default SiderFooter;
