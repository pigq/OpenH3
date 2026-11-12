import React, { useState } from 'react';
import { Tabs } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { DocumentState } from './DocumentState';
import { renderSpreadsheet } from './documentRendering';
import { useDocumentPreview, type DocumentPreviewProps } from './useDocumentPreview';

export default function SpreadsheetPreview(props: DocumentPreviewProps) {
  const { t } = useTranslation();
  const { value, error } = useDocumentPreview(props, renderSpreadsheet);
  const [selected, setSelected] = useState('0');
  if (value === undefined) return <DocumentState error={error} errorKey='preview.excel.loadFailed' />;
  if (!value.length) return <div className='p-24px text-t-secondary'>{t('preview.excel.noSheets')}</div>;
  const sheet = value[Math.min(Number(selected), value.length - 1)];
  return (
    <div className='h-full flex flex-col'>
      <Tabs type='line' activeTab={selected} onChange={setSelected} className='px-12px flex-shrink-0'>
        {value.map((item, index) => (
          <Tabs.TabPane key={String(index)} title={item.name} />
        ))}
      </Tabs>
      <iframe
        className='w-full flex-1 min-h-0 border-none'
        title={`${t('preview.excel.title')} · ${sheet.name}`}
        sandbox=''
        srcDoc={sheet.html}
      />
    </div>
  );
}
