import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { joinPath } from '@/common/chat/chatLib';
import { parseHttpUrl } from '@/renderer/utils/url';
import { resolveLocalFileLinkPath } from './markdownUtils';

/** Compare complete paths or scoped job URLs, never just an output filename. */
function mediaIdentity(source: string, workspace?: string): string {
  const httpUrl = source.startsWith('/api/comfy/jobs/')
    ? new URL(source, 'http://127.0.0.1').href
    : parseHttpUrl(source);
  if (httpUrl) {
    const url = new URL(httpUrl);
    const job = /^\/api\/comfy\/jobs\/([a-f0-9-]{36})\/artifacts\/(\d+)$/i.exec(url.pathname);
    const conversation = url.searchParams.get('conversationId');
    if (job && conversation && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      return `comfy:${conversation}:${job[1].toLowerCase()}:${Number(job[2])}`;
    return httpUrl;
  }
  const path =
    resolveLocalFileLinkPath(source) ??
    (workspace && !/^[a-z][a-z0-9+.-]*:/i.test(source) ? resolveLocalFileLinkPath(joinPath(workspace, source)) : null);
  if (!path) return source;
  const normalized = path.replace(/\\/g, '/');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

type RenderedMedia = {
  contains: (source: string) => boolean;
  register: (id: string, sources: readonly string[]) => () => void;
};
const RenderedMediaContext = createContext<RenderedMedia | null>(null);

/** A conversation owns this registry; only mounted result cards contribute media. */
export function RenderedMediaProvider({ children, workspace }: React.PropsWithChildren<{ workspace?: string }>) {
  const [cards, setCards] = useState<Record<string, readonly string[]>>({});
  const register = useCallback((id: string, sources: readonly string[]) => {
    setCards((current) => ({ ...current, [id]: sources }));
    return () => {
      setCards((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    };
  }, []);
  const value = useMemo(() => {
    const sources = new Set(
      Object.values(cards)
        .flat()
        .map((source) => mediaIdentity(source, workspace))
    );
    return { register, contains: (source: string) => sources.has(mediaIdentity(source, workspace)) };
  }, [cards, register, workspace]);
  return <RenderedMediaContext.Provider value={value}>{children}</RenderedMediaContext.Provider>;
}

export function useRenderedMedia() {
  return useContext(RenderedMediaContext);
}

export function useRegisterRenderedMedia(id: string, sources: readonly string[]) {
  const register = useRenderedMedia()?.register;
  useEffect(() => {
    if (!sources.length) return;
    return register?.(id, sources);
  }, [id, register, sources]);
}
