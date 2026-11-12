import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@arco-design/web-react';
import { Ghost } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

export default function SiderAssistantEntry({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}: {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const label = t('settings.assistants');
  return (
    <Tooltip {...siderTooltipProps} content={label} position='right'>
      <Button
        type='text'
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        className={classNames('sider-nav-entry', {
          'sider-nav-entry--collapsed': collapsed,
          'sider-action-btn-mobile': isMobile,
        })}
        onClick={onClick}
        icon={<Ghost theme='outline' size={collapsed ? 20 : 17} />}
      >
        {!collapsed && label}
      </Button>
    </Tooltip>
  );
}
