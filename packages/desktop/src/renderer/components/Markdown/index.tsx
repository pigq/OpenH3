/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';

import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';

// Import KaTeX CSS to make it available in the document
import 'katex/dist/katex.min.css';

import { openExternalUrl } from '@/renderer/utils/platform';
import { parseHttpUrl } from '@/renderer/utils/url';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import classNames from 'classnames';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertLatexDelimiters } from '@renderer/utils/chat/latexDelimiters';
import LocalImageView from '@renderer/components/media/LocalImageView';
import ConversationImage from '@renderer/components/media/ConversationImage';
import CodeBlock from './CodeBlock';
import LocalFileLink from './LocalFileLink';
import ShadowView from './ShadowView';
import { MARKDOWN_REMARK_PLUGINS, MarkdownTable, MarkdownTd } from './markdownComponents';
import { resolveLocalFileLinkPath, resolveLocalFileLinkReference, safeDecodeURIComponent } from './markdownUtils';
import type { LocalFileLinkReference } from './markdownUtils';
import { useRenderedMedia } from './RenderedMediaContext';

const isLocalFilePath = (src: string): boolean => {
  if (src.startsWith('http://') || src.startsWith('https://')) return false;
  if (src.startsWith('data:')) return false;
  return true;
};

function MarkdownImage(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const renderedMedia = useRenderedMedia();
  if (renderedMedia?.contains(props.src || '')) return <>{props.alt}</>;
  if (isLocalFilePath(props.src || ''))
    return (
      <LocalImageView
        src={resolveLocalFileLinkPath(props.src || '') || safeDecodeURIComponent(props.src || '')}
        alt={props.alt || ''}
        className={props.className}
      />
    );
  return <ConversationImage src={props.src || ''} alt={props.alt || ''} className={props.className} />;
}

function MarkdownVideo(props: React.VideoHTMLAttributes<HTMLVideoElement>) {
  const renderedMedia = useRenderedMedia();
  if (renderedMedia?.contains(props.src || '')) return <>{props.children}</>;
  return <video {...props} />;
}

type MarkdownViewProps = {
  children: string;
  hiddenCodeCopyButton?: boolean;
  codeStyle?: React.CSSProperties;
  className?: string;
  onRef?: (el?: HTMLDivElement | null) => void;
  onLocalFileLink?: (path: string, reference?: LocalFileLinkReference) => void | Promise<void>;
  /** Enable raw HTML rendering in markdown content. Use with caution — only for trusted sources. */
  allowHtml?: boolean;
};

const MarkdownView: React.FC<MarkdownViewProps> = React.memo(
  ({ hiddenCodeCopyButton, codeStyle, className, onRef, onLocalFileLink, allowHtml, children: childrenProp }) => {
    const { t } = useTranslation();
    const preview = useOptionalPreviewContext();
    const workspace = useConversationContextSafe()?.workspace;

    const normalizedChildren = useMemo(() => {
      if (typeof childrenProp === 'string') {
        return convertLatexDelimiters(childrenProp);
      }
      return childrenProp;
    }, [childrenProp]);

    const handleLinkClick = useCallback(
      (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const href = (e.currentTarget as HTMLAnchorElement).href;
        if (!href) return;
        // Prefer the built-in browser tab for http(s) links; fall back to the
        // system browser for other schemes or when no Preview panel is available.
        const httpUrl = parseHttpUrl(href);
        if (httpUrl && preview) {
          preview.openBrowserTab(httpUrl);
          return;
        }
        openExternalUrl(href).catch((error: unknown) => {
          console.error(t('messages.openLinkFailed'), error);
        });
      },
      [t, preview]
    );

    // Memoize components so React preserves component identity across re-renders.
    // Without this, every streaming update creates new function references → React
    // unmounts/remounts all custom components → hooks & DOM state are lost.
    const components = useMemo(
      () => ({
        span: ({ node: _node, className: cn, children: ch, ...rest }: Record<string, unknown>) => (
          <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)} className={cn as string}>
            {ch as React.ReactNode}
          </span>
        ),
        code: (props: Record<string, unknown>) => (
          <CodeBlock
            {...(props as Parameters<typeof CodeBlock>[0])}
            codeStyle={codeStyle}
            hiddenCodeCopyButton={hiddenCodeCopyButton}
            diagramPanZoom
          />
        ),
        a: ({ node: _node, ...rest }: Record<string, unknown>) => {
          const anchorProps = rest as React.AnchorHTMLAttributes<HTMLAnchorElement>;
          const rawHref = typeof anchorProps.href === 'string' ? anchorProps.href : '';
          const localFileReference = resolveLocalFileLinkReference(rawHref, undefined, workspace);
          if (localFileReference) {
            return (
              <LocalFileLink reference={localFileReference} onOpen={onLocalFileLink}>
                {anchorProps.children}
              </LocalFileLink>
            );
          }
          return (
            <a {...anchorProps} href={anchorProps.href} target='_blank' rel='noreferrer' onClick={handleLinkClick} />
          );
        },
        table: MarkdownTable,
        td: MarkdownTd,
        img: ({ node: _node, ...rest }: Record<string, unknown>) => {
          return <MarkdownImage {...(rest as React.ImgHTMLAttributes<HTMLImageElement>)} />;
        },
        video: ({ node: _node, ...rest }: Record<string, unknown>) => {
          return <MarkdownVideo {...(rest as React.VideoHTMLAttributes<HTMLVideoElement>)} />;
        },
      }),
      [codeStyle, hiddenCodeCopyButton, handleLinkClick, onLocalFileLink, workspace]
    );

    const rehypePlugins = useMemo(() => (allowHtml ? [rehypeRaw, rehypeKatex] : [rehypeKatex]), [allowHtml]);

    return (
      <div className={classNames('relative w-full', className)}>
        <ShadowView>
          <div ref={onRef} className='markdown-shadow-body'>
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={rehypePlugins}
              components={components}
              urlTransform={(url) =>
                resolveLocalFileLinkReference(url, undefined, workspace) ? url : defaultUrlTransform(url)
              }
            >
              {normalizedChildren}
            </ReactMarkdown>
          </div>
        </ShadowView>
      </div>
    );
  }
);

MarkdownView.displayName = 'MarkdownView';

export default MarkdownView;
