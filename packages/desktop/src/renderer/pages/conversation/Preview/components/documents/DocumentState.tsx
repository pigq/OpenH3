import React from 'react';
import { Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

export function DocumentState({ error, errorKey }: { error?: string; errorKey: string }) {
  const { t } = useTranslation();
  return (
    <div className='h-full flex items-center justify-center p-24px text-t-secondary'>
      {error ? (
        <div role='alert'>
          {t(errorKey)}: {error}
        </div>
      ) : (
        <Spin tip={t('preview.loading')} />
      )}
    </div>
  );
}
