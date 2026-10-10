import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ upload: vi.fn(), payload: vi.fn(), open: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/services/FileService', () => ({ uploadFileViaHttp: h.upload }));
vi.mock('@/renderer/utils/file/previewPayload', () => ({ resolvePreviewPayload: h.payload }));
vi.mock('@/renderer/pages/conversation/Preview', () => ({ usePreviewContext: () => ({ openPreview: h.open }) }));
import VideoImportButton from '@/renderer/pages/conversation/Preview/components/Video/VideoImportButton';
beforeEach(() => {
  h.upload.mockReset();
  h.open.mockReset();
  h.payload.mockResolvedValue({ lastModified: 10 });
});
describe('video import', () => {
  it('uses the authenticated upload pipeline then opens a reference-only preview', async () => {
    h.upload.mockResolvedValue('/managed/clip.mp4');
    const { container } = render(<VideoImportButton conversationId='chat' />);
    expect(container.querySelector('.sendbox-video-import-btn')).toBeTruthy();
    expect(container.querySelector('.sendbox-video-import-btn svg')).toBeTruthy();
    fireEvent.change(container.querySelector('input[type=file]')!, {
      target: { files: [new File(['data'], 'clip.mp4')] },
    });
    await waitFor(() =>
      expect(h.open).toHaveBeenCalledWith(
        '',
        'video',
        expect.objectContaining({ fileRef: { kind: 'upload', path: '/managed/clip.mp4' }, editable: false })
      )
    );
  });
  it('aborts an upload and ignores its late result when the conversation unmounts', async () => {
    let finish!: (path: string) => void;
    h.upload.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const { container, unmount } = render(<VideoImportButton conversationId='chat' />);
    fireEvent.change(container.querySelector('input[type=file]')!, {
      target: { files: [new File(['data'], 'clip.mp4')] },
    });
    await waitFor(() => expect(h.upload).toHaveBeenCalled());
    expect(container.querySelector('.sendbox-video-import-btn--cancel')).toBeTruthy();
    const signal = h.upload.mock.calls[0][4].signal as AbortSignal;
    unmount();
    finish('/managed/clip.mp4');
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(h.payload).toHaveBeenCalled());
    expect(h.open).not.toHaveBeenCalled();
  });
});
