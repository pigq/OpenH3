import React from 'react';
import JSZip from 'jszip';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import WordPreview from '@/renderer/pages/conversation/Preview/components/viewers/OfficeDocViewer';
vi.mock('@/common/adapter/httpBridge', () => ({ getBaseUrl: () => 'http://localhost:3000' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function documentBytes() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>繁體中文經費預算</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>場地</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>5500</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
  );
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('Word file preview', () => {
  it('reads real DOCX bytes and renders paragraphs and tables without an Office process', async () => {
    const bytes = await documentBytes();
    const fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });
    vi.stubGlobal('fetch', fetch);
    render(<WordPreview file_path='C:/交付/預算.docx' />);
    const frame = await screen.findByTitle('preview.word.title');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('srcdoc')).toContain('繁體中文經費預算');
    expect(frame.getAttribute('srcdoc')).toContain('<table');
    expect(frame.getAttribute('srcdoc')).toContain('5500');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(decodeURIComponent(fetch.mock.calls[0][0])).toContain('path=C:/交付/預算.docx');
  });
  it('shows a read error rather than waiting for an installer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    render(<WordPreview file_path='C:/missing.docx' />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('404'));
  });
});
