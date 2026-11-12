import React from 'react';
import { FileText, FolderOpen } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { DocumentState } from './DocumentState';
import { readArchive } from './documentRendering';
import { useDocumentPreview, type DocumentPreviewProps } from './useDocumentPreview';

export default function ArchivePreview(props: DocumentPreviewProps) {
  const { t } = useTranslation();
  const { value, error } = useDocumentPreview(props, readArchive);
  if (value === undefined) return <DocumentState error={error} errorKey='preview.archive.loadFailed' />;
  return (
    <div className='h-full overflow-auto p-20px'>
      <div className='font-medium mb-12px'>{t('preview.archive.entries', { count: value.length })}</div>
      <ul className='list-none m-0 p-0'>
        {value.map((entry) => (
          <li key={entry.name} className='flex items-start gap-8px py-10px border-b border-border-1'>
            {entry.directory ? (
              <FolderOpen className='flex-shrink-0 mt-3px' />
            ) : (
              <FileText className='flex-shrink-0 mt-3px' />
            )}
            <span className='break-all'>{entry.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
