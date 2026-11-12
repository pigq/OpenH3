import React from 'react';
import { utils, write } from 'xlsx-republish';
import JSZip from 'jszip';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import ExcelPreview from '@/renderer/pages/conversation/Preview/components/viewers/ExcelViewer';
import ArchivePreview from '@/renderer/pages/conversation/Preview/components/documents/ArchivePreview';
vi.mock('@/common/adapter/httpBridge', () => ({ getBaseUrl: () => 'http://localhost:3000' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('Local binary document previews', () => {
  it('renders actual XLSX values, merged cells and multiple sheets', async () => {
    const book = utils.book_new();
    const sheet = utils.aoa_to_sheet([['經費預算'], ['場地', 3000], ['合計', 5500], ['<script>alert(1)</script>']]);
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    utils.book_append_sheet(book, sheet, '預算');
    utils.book_append_sheet(book, utils.aoa_to_sheet([['備註', '已核對']]), '備註');
    const bytes = write(book, { type: 'array', bookType: 'xlsx' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes }));
    render(<ExcelPreview fileRef={{ kind: 'local', path: 'C:/預算.xlsx' }} />);
    const frame = await screen.findByTitle('preview.excel.title · 預算');
    expect(frame.getAttribute('srcdoc')).toContain('5500');
    expect(frame.getAttribute('srcdoc')).toContain('colspan="2"');
    expect(frame.getAttribute('srcdoc')).not.toContain('<script>');
    fireEvent.click(screen.getByRole('tab', { name: '備註' }));
    expect((await screen.findByTitle('preview.excel.title · 備註')).getAttribute('srcdoc')).toContain('已核對');
  });
  it('shows a real ZIP directory without decoding its binary as text or extracting files', async () => {
    const zip = new JSZip();
    zip.file('交付/預算.md', '# 預算');
    zip.file('交付/預算.pdf', '%PDF-test');
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes }));
    render(<ArchivePreview file_path='C:/預算.zip' />);
    expect(await screen.findByText('交付/預算.md')).toBeVisible();
    expect(screen.getByText('交付/預算.pdf')).toBeVisible();
  });
});
