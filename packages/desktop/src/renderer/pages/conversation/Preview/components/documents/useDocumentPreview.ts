import { useEffect, useState } from 'react';
import type { ChatFileRef } from '@/common/types/chatFile';
import { buildFileStreamUrl } from '@/renderer/utils/file/fileUrls';
import { registerTabReloader } from '../../context/tabReloaderRegistry';

export type DocumentPreviewProps = {
  tabId?: string;
  fileRef?: ChatFileRef;
  file_path?: string;
  content?: string;
  workspace?: string;
};

/** Read the selected file through the existing authorized byte endpoint. */
export function useDocumentPreview<T>(props: DocumentPreviewProps, parse: (bytes: ArrayBuffer) => Promise<T>) {
  const file = props.fileRef ?? (props.file_path ? { kind: 'local' as const, path: props.file_path } : undefined);
  const url = file ? buildFileStreamUrl(file) : undefined;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    if (props.tabId) return registerTabReloader(props.tabId, () => setRevision((current) => current + 1));
  }, [props.tabId]);
  useEffect(() => {
    const abort = new AbortController();
    setState({});
    void (async () => {
      if (!url) throw new Error('Missing file path');
      const response = await fetch(url, { signal: abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await parse(await response.arrayBuffer());
      if (!abort.signal.aborted) setState({ value });
    })().catch((error: Error) => {
      if (!abort.signal.aborted) setState({ error: error.message });
    });
    return () => abort.abort();
  }, [url, revision, parse]);
  return state;
}
