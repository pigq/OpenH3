import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@arco-design/web-react';
import { Magic } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

export default function SiderCreationEntry({
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
  const label = t('guid.aiCreation');
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
        icon={<Magic theme='outline' size={collapsed ? 20 : 17} />}
      >
        {!collapsed && label}
      </Button>
    </Tooltip>
  );
}
