import { Button } from '@arco-design/web-react';
import { Checklist, FolderOpen } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './WorkProgress.module.css';

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
    <div className={styles.tabs} role='group' aria-label={t('conversation.workProgress.panel')}>
      {workspaceAvailable && (
        <Button
          size='mini'
          type='text'
          className={styles.tab}
          icon={<FolderOpen size={14} />}
          aria-pressed={!progressActive}
          onClick={() => onChange(false)}
        >
          {t('conversation.workspace.title')}
        </Button>
      )}
      <Button
        size='mini'
        type='text'
        className={styles.tab}
        icon={<Checklist size={14} />}
        aria-pressed={progressActive}
        onClick={() => onChange(true)}
      >
        {t('conversation.workProgress.title')}
      </Button>
    </div>
  );
}
