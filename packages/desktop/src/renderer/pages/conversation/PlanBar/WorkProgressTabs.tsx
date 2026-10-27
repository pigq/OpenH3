import { Button } from '@arco-design/web-react';
import { Checklist, FolderOpen } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

export default function WorkProgressTabs({
  workspaceAvailable,
  progressActive,
  onChange,
}: {
  workspaceAvailable: boolean;
  progressActive: boolean;
  onChange: (progressActive: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className='flex items-center gap-4px min-w-0' role='group' aria-label={t('conversation.workProgress.panel')}>
      {workspaceAvailable && (
        <Button
          size='mini'
          type={progressActive ? 'text' : 'secondary'}
          icon={<FolderOpen size={14} />}
          aria-pressed={!progressActive}
          onClick={() => onChange(false)}
        >
          {t('conversation.workspace.title')}
        </Button>
      )}
      <Button
        size='mini'
        type={progressActive ? 'secondary' : 'text'}
        icon={<Checklist size={14} />}
        aria-pressed={progressActive}
        onClick={() => onChange(true)}
      >
        {t('conversation.workProgress.title')}
      </Button>
    </div>
  );
}
