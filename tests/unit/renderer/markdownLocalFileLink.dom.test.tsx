/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownView from '@/renderer/components/Markdown';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import { RenderedMediaProvider, useRegisterRenderedMedia } from '@/renderer/components/Markdown/RenderedMediaContext';

const copyTextMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/common/adapter/httpBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/adapter/httpBridge')>()),
  getBaseUrl: () => 'http://127.0.0.1:3000',
}));

vi.mock('@/renderer/components/Markdown/ShadowView', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/Markdown/CodeBlock', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <code>{children}</code>,
}));

vi.mock('@/renderer/components/media/LocalImageView', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

vi.mock('@/renderer/utils/chat/latexDelimiters', () => ({
  convertLatexDelimiters: (text: string) => text,
}));

vi.mock('@/renderer/utils/platform', () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({
  copyText: copyTextMock,
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    children,
    icon,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => (
    <button type='button' {...props}>
      {icon}
      {children}
    </button>
  ),
  Message: {
    error: vi.fn(),
  },
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Image: { Preview: ({ src }: { src: string }) => <div role='dialog' data-src={src} /> },
}));

vi.mock('@icon-park/react', () => ({
  Copy: () => <span data-testid='copy-icon' />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('MarkdownView local file links', () => {
  it('opens relative document deliveries using the conversation workspace', () => {
    const onOpen = vi.fn();
    render(
      <ConversationProvider value={{ conversation_id: 'files', type: 'aionrs', workspace: 'C:/项目/活动' }}>
        <MarkdownView onLocalFileLink={onOpen}>{'[下载繁體預算](./交付/經費預算表.docx)'}</MarkdownView>
      </ConversationProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: '下载繁體預算' }));
    expect(onOpen).toHaveBeenCalledWith('C:/项目/活动/交付/經費預算表.docx', expect.any(Object));
  });

  it('keeps encoded hash characters and file URL hosts in clickable deliveries', () => {
    const onOpen = vi.fn();
    render(<MarkdownView onLocalFileLink={onOpen}>{'[预算文件](file://server/share/预算%20%231.docx)'}</MarkdownView>);
    fireEvent.click(screen.getByRole('button', { name: '预算文件' }));
    expect(onOpen).toHaveBeenCalledWith('//server/share/预算 #1.docx', expect.any(Object));
  });

  beforeEach(() => {
    copyTextMock.mockClear();
  });

  it('plays an edited local video link inline through the file stream and retains its file action', () => {
    const path = 'C:/Users/pc05/Documents/生成视频/三款转场 24秒.mp4';
    const onOpen = vi.fn();
    const { container } = render(<MarkdownView onLocalFileLink={onOpen}>{`[播放合成视频](<${path}>)`}</MarkdownView>);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    const url = new URL(video!.getAttribute('src')!);
    expect(url.pathname).toBe('/api/fs/stream');
    expect(url.searchParams.get('path')).toBe(path);
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveStyle({ maxHeight: 'min(420px, 52dvh)', objectFit: 'contain' });
    Object.defineProperties(video!, {
      videoWidth: { value: 608 },
      videoHeight: { value: 352 },
      duration: { value: 24 },
    });
    fireEvent.loadedMetadata(video!);
    expect(screen.getByText(/608 × 352/)).toBeInTheDocument();
    expect(screen.getByText(/24 s/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '播放合成视频' }));
    expect(onOpen).toHaveBeenCalledWith(path, expect.objectContaining({ filePath: path }));
  });

  it('keeps a local video link without a second player when a result card already displays the file', () => {
    const path = 'D:/生成结果/clip.mp4';
    const sources = [path];
    function ExistingCard() {
      useRegisterRenderedMedia('job-1', sources);
      return <video aria-label='existing result' />;
    }
    const { container } = render(
      <RenderedMediaProvider>
        <ExistingCard />
        <MarkdownView onLocalFileLink={vi.fn()}>{`[打开视频](${path})`}</MarkdownView>
      </RenderedMediaProvider>
    );
    expect(container.querySelectorAll('video')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '打开视频' })).toBeInTheDocument();
  });

  it('bounds remote Markdown images and opens their original source for inspection', () => {
    const src = 'https://example.test/portrait.png';
    render(<MarkdownView>{`![portrait](${src})`}</MarkdownView>);
    const image = screen.getByAltText('portrait');
    expect(image).toHaveStyle({ maxHeight: 'min(420px, 52dvh)', width: 'auto', height: 'auto', objectFit: 'contain' });
    fireEvent.click(screen.getByRole('button', { name: /portrait/ }));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-src', src);
  });

  it('renders local file links as app controls instead of browser anchors', () => {
    const onLocalFileLink = vi.fn();

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {'[report.xlsx](/C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx)'}
      </MarkdownView>
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'report.xlsx' }));
    expect(onLocalFileLink).toHaveBeenCalledWith(
      'C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx',
      expect.objectContaining({
        filePath: 'C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx',
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyTextMock).toHaveBeenCalledWith('C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx');
  });

  it('renders line references as file chips and copies the full reference', () => {
    const onLocalFileLink = vi.fn();

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {'[2026-06-19.log](C:/Users/Administrator/AppData/Roaming/AionUi/logs/2026-06-19.log:1421)'}
      </MarkdownView>
    );

    const fileButton = screen.getByRole('button', { name: /2026-06-19\.log\s+L1421/ });
    fireEvent.click(fileButton);

    expect(onLocalFileLink).toHaveBeenCalledWith(
      'C:/Users/Administrator/AppData/Roaming/AionUi/logs/2026-06-19.log',
      expect.objectContaining({
        filePath: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/2026-06-19.log',
        rawReference: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/2026-06-19.log:1421',
        line: 1421,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyTextMock).toHaveBeenCalledWith('C:/Users/Administrator/AppData/Roaming/AionUi/logs/2026-06-19.log:1421');
  });

  it('renders line and column references as file chips and copies the full reference', () => {
    const onLocalFileLink = vi.fn();

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {'[app.log](C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7)'}
      </MarkdownView>
    );

    const fileButton = screen.getByRole('button', { name: /app\.log\s+L1421:7/ });
    fireEvent.click(fileButton);

    expect(onLocalFileLink).toHaveBeenCalledWith(
      'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log',
      expect.objectContaining({
        filePath: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log',
        rawReference: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7',
        line: 1421,
        column: 7,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyTextMock).toHaveBeenCalledWith('C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7');
  });

  it('renders hash range references as file chips and copies normalized local references', () => {
    const onLocalFileLink = vi.fn();

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {'[user.js 1-260行](/Users/demo/project/user.js#L1-L260)'}
      </MarkdownView>
    );

    expect(screen.queryByRole('link', { name: /user\.js/ })).not.toBeInTheDocument();

    const fileButton = screen.getByRole('button', { name: /user\.js 1-260行\s+L1-L260/ });
    fireEvent.click(fileButton);

    expect(onLocalFileLink).toHaveBeenCalledWith(
      '/Users/demo/project/user.js',
      expect.objectContaining({
        filePath: '/Users/demo/project/user.js',
        rawReference: '/Users/demo/project/user.js#L1-L260',
        line: 1,
        endLine: 260,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyTextMock).toHaveBeenCalledWith('/Users/demo/project/user.js#L1-L260');
  });

  it('does not render a no-op open button when no local file handler is provided', () => {
    render(<MarkdownView>{'[report.xlsx](/C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx)'}</MarkdownView>);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'report.xlsx' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyTextMock).toHaveBeenCalledWith('C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx');
  });

  it('keeps ordinary http links as browser anchors', () => {
    render(<MarkdownView>{'[docs](https://aionui.com/docs)'}</MarkdownView>);

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://aionui.com/docs');
  });

  it('keeps http hash links as browser anchors', () => {
    render(<MarkdownView>{'[docs](https://aionui.com/docs#L10)'}</MarkdownView>);

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://aionui.com/docs#L10');
  });

  it('adds empty alt text to external raw HTML images without alt text', () => {
    const { container } = render(
      <MarkdownView allowHtml>{'<img src="https://example.com/generated.png" />'}</MarkdownView>
    );

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'https://example.com/generated.png');
    expect(image).toHaveAttribute('alt', '');
  });
});
