/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@arco-design/web-react';
import { ListCheckbox, Plus } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import styles from '../Sider.module.css';
import { useLocation } from 'react-router-dom';

interface SiderToolbarProps {
  isMobile: boolean;
  isBatchMode: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onNewChat: () => void;
  onToggleBatchMode: () => void;
}

const SiderToolbar: React.FC<SiderToolbarProps> = ({
  isMobile,
  isBatchMode,
  collapsed,
  siderTooltipProps,
  onNewChat,
  onToggleBatchMode,
}) => {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  if (collapsed) {
    return (
      <div className='shrink-0 flex flex-col items-center gap-2px w-full'>
        <Tooltip {...siderTooltipProps} content={t('conversation.welcome.newConversation')} position='right'>
          <Button
            type='text'
            aria-label={t('conversation.welcome.newConversation')}
            aria-current={pathname === '/guid' ? 'page' : undefined}
            className={classNames(
              'sider-nav-entry sider-nav-entry--collapsed',
              'w-full h-34px flex items-center justify-center cursor-pointer transition-colors text-t-primary rd-8px hover:bg-fill-3 active:bg-fill-4',
              styles.newChatTrigger
            )}
            onClick={onNewChat}
          >
            <Plus
              theme='outline'
              size='16'
              fill='currentColor'
              className={classNames('block leading-none', styles.newChatIcon)}
              style={{ lineHeight: 0 }}
            />
          </Button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className='shrink-0 flex items-center gap-8px'>
      <Tooltip {...siderTooltipProps} content={t('conversation.welcome.newConversation')} position='right'>
        <Button
          type='text'
          aria-label={t('conversation.welcome.newConversation')}
          aria-current={pathname === '/guid' ? 'page' : undefined}
          className={classNames(
            'sider-nav-entry',
            styles.newChatTrigger,
            'h-34px flex-1 flex items-center justify-start gap-8px ps-10px pe-8px rd-0.5rem cursor-pointer group transition-all bg-transparent text-t-primary hover:bg-fill-3 active:bg-fill-4',
            isMobile && 'sider-action-btn-mobile'
          )}
          onClick={onNewChat}
        >
          <span className='size-22px rd-6px bg-aou-2 border border-solid border-[var(--color-border-2)] group-hover:bg-fill-3 group-hover:border-transparent flex items-center justify-center shrink-0 transition-colors'>
            <Plus
              theme='outline'
              size='14'
              fill='currentColor'
              className={classNames('block leading-none', styles.newChatIcon)}
              style={{ lineHeight: 0 }}
            />
          </span>
          <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px'>
            {t('conversation.welcome.newConversation')}
          </span>
        </Button>
      </Tooltip>
      <Tooltip
        {...siderTooltipProps}
        content={isBatchMode ? t('conversation.history.batchModeExit') : t('conversation.history.batchManage')}
        position='right'
      >
        <Button
          type='text'
          aria-pressed={isBatchMode}
          aria-label={t('conversation.history.batchManage')}
          className={classNames(
            '!p-0 !w-26px !h-26px size-26px rd-6px flex items-center justify-center cursor-pointer shrink-0 transition-colors border border-solid border-transparent text-t-secondary hover:text-t-primary',
            isMobile && 'sider-action-icon-btn-mobile',
            {
              'hover:bg-fill-3': !isBatchMode,
              'bg-[rgba(var(--primary-6),0.12)] border-[rgba(var(--primary-6),0.24)] !text-primary': isBatchMode,
            }
          )}
          onClick={onToggleBatchMode}
        >
          <ListCheckbox theme='outline' size='14' className='block leading-none shrink-0' style={{ lineHeight: 0 }} />
        </Button>
      </Tooltip>
    </div>
  );
};

export default SiderToolbar;
