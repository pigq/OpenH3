/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: { shell: { openFile: { invoke: vi.fn() } } } }));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('@arco-design/web-react', () => ({
  Message: { useMessage: () => [{ error: vi.fn(), success: vi.fn() }, null] },
}));
vi.mock('@/renderer/pages/conversation/Preview/previewUrls', () => ({
  buildPdfSrc: (ref?: { path: string }, content?: string) => ref?.path || content || '',
}));

import PDFViewer from '@/renderer/pages/conversation/Preview/components/viewers/PDFViewer';
import { reloadViaViewer } from '@/renderer/pages/conversation/Preview/context/tabReloaderRegistry';

afterEach(cleanup);

describe('PDF preview lifecycle', () => {
  it('keeps the loading document mounted and preserves it when the same file is reopened', () => {
    const { container, rerender } = render(<PDFViewer fileRef={{ kind: 'local', path: '/budget.pdf' }} hideToolbar />);
    const webview = container.querySelector('webview')!;
    expect(webview).toBeInTheDocument();
    expect(screen.getByText('preview.loading')).toBeInTheDocument();
    act(() => webview.dispatchEvent(new Event('did-finish-load')));
    expect(screen.queryByText('preview.loading')).not.toBeInTheDocument();

    rerender(<PDFViewer fileRef={{ kind: 'local', path: '/budget.pdf' }} hideToolbar />);
    expect(container.querySelector('webview')).toBe(webview);
    expect(screen.queryByText('preview.loading')).not.toBeInTheDocument();
  });

  it('can refresh a failed document without losing its webview or event listeners', () => {
    const { container, unmount } = render(
      <PDFViewer tabId='pdf-tab' fileRef={{ kind: 'local', path: '/budget.pdf' }} hideToolbar />
    );
    const webview = container.querySelector('webview')!;
    const reload = vi.fn(() => webview.dispatchEvent(new Event('did-start-loading')));
    Object.assign(webview, { reload });
    act(() => webview.dispatchEvent(new Event('did-fail-load')));
    expect(screen.getByText(/preview.pdf.loadFailed/)).toBeInTheDocument();
    act(() => {
      reloadViaViewer('pdf-tab');
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(container.querySelector('webview')).toBe(webview);
    expect(screen.queryByText(/preview.pdf.loadFailed/)).not.toBeInTheDocument();
    act(() => webview.dispatchEvent(new Event('did-finish-load')));
    expect(screen.queryByText('preview.loading')).not.toBeInTheDocument();
    unmount();
    expect(reloadViaViewer('pdf-tab')).toBe(false);
  });

  it('loads a different PDF and reports an absent source', () => {
    const { container, rerender } = render(<PDFViewer content='blob:first' hideToolbar />);
    rerender(<PDFViewer content='blob:second' hideToolbar />);
    const webview = container.querySelector('webview')!;
    expect(webview).toHaveAttribute('src', 'blob:second');
    act(() => webview.dispatchEvent(new Event('did-finish-load')));
    expect(screen.queryByText('preview.loading')).not.toBeInTheDocument();
    rerender(<PDFViewer hideToolbar />);
    expect(screen.getByText(/preview.pdf.pathMissing/)).toBeInTheDocument();
    expect(container.querySelector('webview')).not.toBeInTheDocument();
  });
});
