import { Button } from '@arco-design/web-react';
import { WORKSPACE_HEADER_HEIGHT } from '@/renderer/pages/conversation/utils/layoutCalc';
import { ExpandLeft, ExpandRight } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import WorkProgressTabs from '@/renderer/pages/conversation/PlanBar/WorkProgressTabs';
import WorkspaceOpenButton from './WorkspaceOpenButton';

type WorkspaceHeaderProps = {
  children?: React.ReactNode;
  showToggle?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  togglePlacement?: 'left' | 'right';
  workspacePath?: string;
  isTemporaryWorkspace?: boolean;
  progressAvailable?: boolean;
  workspaceAvailable?: boolean;
  progressActive?: boolean;
  onProgressChange?: (active: boolean) => void;
};

const WorkspacePanelHeader: React.FC<WorkspaceHeaderProps> = ({
  children,
  showToggle = false,
  collapsed,
  onToggle,
  togglePlacement = 'right',
  workspacePath,
  isTemporaryWorkspace = false,
  progressAvailable = false,
  workspaceAvailable = true,
  progressActive = false,
  onProgressChange,
}) => {
  const { t } = useTranslation();
  const toggle = (
    <Button
      type='text'
      size='mini'
      className='workspace-header__toggle'
      aria-label={collapsed ? t('common.expandMore') : t('common.collapse')}
      onClick={onToggle}
      icon={collapsed ? <ExpandRight size={16} /> : <ExpandLeft size={16} />}
    />
  );
  return (
    <div
      className='workspace-panel-header flex items-center justify-start px-12px py-4px gap-8px border-b border-[var(--bg-3)]'
      style={{ height: WORKSPACE_HEADER_HEIGHT, minHeight: WORKSPACE_HEADER_HEIGHT }}
    >
      {showToggle && togglePlacement === 'left' && toggle}
      <div className='flex-1 min-w-0'>
        {progressAvailable && onProgressChange ? (
          <WorkProgressTabs
            workspaceAvailable={workspaceAvailable}
            progressActive={progressActive}
            onChange={onProgressChange}
          />
        ) : (
          children
        )}
      </div>
      {workspacePath && !collapsed && !progressActive && (
        <WorkspaceOpenButton workspacePath={workspacePath} isTemporary={isTemporaryWorkspace} />
      )}
      {showToggle && togglePlacement === 'right' && toggle}
    </div>
  );
};
export default WorkspacePanelHeader;
