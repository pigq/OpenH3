import React, { useEffect, useRef, useState } from 'react';
import { Button, Message, Tooltip, Upload } from '@arco-design/web-react';
import { Close, VideoFile } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { uploadFileViaHttp } from '@/renderer/services/FileService';
import { uploadFileRef } from '@/common/types/chatFile';
import { resolvePreviewPayload } from '@/renderer/utils/file/previewPayload';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';

export default function VideoImportButton({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const { openPreview } = usePreviewContext();
  const abort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [conversationId]
  );
  const importFile = async (file: File): Promise<boolean> => {
    if (abort.current) return false;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    try {
      const path = await uploadFileViaHttp(file, conversationId, undefined, undefined, { signal: controller.signal });
      const fileRef = uploadFileRef(path);
      const payload = await resolvePreviewPayload(fileRef, 'video');
      if (!controller.signal.aborted)
        openPreview('', 'video', {
          fileRef,
          title: file.name,
          file_name: file.name,
          editable: false,
          lastModified: payload.lastModified,
        });
    } catch {
      if (!controller.signal.aborted) Message.error(t('preview.video.loadFailed'));
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setBusy(false);
      }
    }
    return false;
  };
  return (
    <>
      <Upload accept='.mp4,.webm,.mov,.m4v,.ogv' showUploadList={false} beforeUpload={importFile} disabled={busy}>
        <Tooltip content={t('preview.video.import')}>
          <Button
            aria-label={t('preview.video.import')}
            type='text'
            className='sendbox-video-import-btn'
            icon={<VideoFile theme='outline' size='16' strokeWidth={2.4} />}
            loading={busy}
          />
        </Tooltip>
      </Upload>
      {busy && (
        <Tooltip content={t('common.cancel')}>
          <Button
            type='text'
            className='sendbox-video-import-btn sendbox-video-import-btn--cancel'
            aria-label={t('common.cancel')}
            icon={<Close theme='outline' size='16' strokeWidth={2.6} />}
            onClick={() => abort.current?.abort()}
          />
        </Tooltip>
      )}
    </>
  );
}
