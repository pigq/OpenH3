/** Untrusted document HTML is displayed in a scriptless, network-free frame. */
export function documentHtml(body: string, styles = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html{color-scheme:light}body{margin:16px;color:#202124;background:#fff;font:14px system-ui,sans-serif}table{border-collapse:collapse}td,th{border:1px solid #dfe1e5;padding:7px 12px;white-space:pre-wrap}a{color:inherit;pointer-events:none}img{max-width:100%}</style>${styles}</head><body>${body}</body></html>`;
}

export async function renderWord(bytes: ArrayBuffer): Promise<string> {
  const { renderAsync } = await import('docx-preview');
  const body = document.createElement('div');
  const styles = document.createElement('div');
  await renderAsync(bytes, body, styles, {
    inWrapper: true,
    ignoreWidth: true,
    ignoreHeight: true,
    useBase64URL: true,
    renderAltChunks: false,
  });
  const responsiveStyles = `<style>
    .docx-wrapper{padding:0;background:transparent;align-items:stretch}
    .docx-wrapper section.docx{width:100%!important;min-width:0;box-sizing:border-box;padding:20px!important}
    .docx-wrapper table{width:100%!important;table-layout:fixed}
    .docx-wrapper col{width:auto!important}
    .docx-wrapper td,.docx-wrapper th{overflow-wrap:anywhere}
  </style>`;
  return documentHtml(body.innerHTML, styles.innerHTML + responsiveStyles);
}

export async function renderSpreadsheet(bytes: ArrayBuffer): Promise<Array<{ name: string; html: string }>> {
  const xlsx = await import('xlsx-republish');
  const workbook = xlsx.read(bytes, { type: 'array', cellDates: true });
  return workbook.SheetNames.map((name) => ({
    name,
    html: documentHtml(xlsx.utils.sheet_to_html(workbook.Sheets[name], { header: '', footer: '' })),
  }));
}

export async function readArchive(bytes: ArrayBuffer): Promise<Array<{ name: string; directory: boolean }>> {
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(bytes);
  return Object.values(archive.files).map((entry) => ({ name: entry.name, directory: entry.dir }));
}
