import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CloudVideoSetup from '@/renderer/pages/guid/Creation/CloudVideoSetup';
import CloudVideoResult, { cloudVideoJobIds } from '@/renderer/pages/conversation/runtime/Creation/CloudVideoResult';
import { cloudVideoApi } from '@/common/chat/document/creation/cloudVideoApi';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/common/chat/document/creation/cloudVideoApi', () => ({
  cloudVideoApi: {
    save: vi.fn(),
    connections: vi.fn().mockResolvedValue([]),
    job: vi.fn(),
    artifactUrl: vi.fn(() => 'http://localhost/video.mp4'),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }))
  );
});
describe('cloud video client', () => {
  it('does not display completion while an upstream job is still running', async () => {
    vi.mocked(cloudVideoApi.job).mockResolvedValue({
      id: 'pending-full',
      status: 'running',
      stage: 'generating',
      progress: 100,
      progressKnown: true,
      createdAt: new Date().toISOString(),
    } as Awaited<ReturnType<typeof cloudVideoApi.job>>);
    render(<CloudVideoResult id='pending-full' conversationId='pending-full' />);
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '99');
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.getByTestId('cloud-video-result')).toHaveAttribute('aria-busy', 'true');
  });
  it('shows the real download percentage while the saved artifact is transferring', async () => {
    vi.mocked(cloudVideoApi.job).mockResolvedValue({
      id: 'downloading',
      status: 'running',
      stage: 'downloading',
      progress: 100,
      progressKnown: true,
      downloadBytes: 50,
      downloadTotalBytes: 100,
      createdAt: new Date().toISOString(),
    } as Awaited<ReturnType<typeof cloudVideoApi.job>>);
    render(<CloudVideoResult id='downloading' conversationId='downloading' />);
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByTestId('cloud-video-result')).toHaveAttribute('aria-busy', 'true');
  });
  it('shows background generation with unknown progress instead of a misleading zero percent', async () => {
    vi.mocked(cloudVideoApi.job).mockResolvedValue({
      id: 'unknown',
      status: 'running',
      stage: 'generating',
      progress: 0,
      progressKnown: false,
      createdAt: new Date().toISOString(),
    } as Awaited<ReturnType<typeof cloudVideoApi.job>>);
    render(<CloudVideoResult id='unknown' conversationId='unknown-conversation' />);
    expect(await screen.findByText('guid.creation.cloudVideoSetup.progressUnknown')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getByText('guid.creation.cloudVideoSetup.background')).toBeInTheDocument();
  });
  it.each([
    [768, 1344],
    [768, 768],
    [768, 1024],
    [1344, 768],
  ])('fits the card to actual metadata %s x %s', async (width, height) => {
    const id = 'ratio-' + width + '-' + height;
    vi.mocked(cloudVideoApi.job).mockResolvedValue({ id, status: 'succeeded', model: 'H3' } as Awaited<
      ReturnType<typeof cloudVideoApi.job>
    >);
    render(<CloudVideoResult id={id} conversationId={id} />);
    const video = await screen.findByLabelText('guid.creation.cloudVideo');
    Object.defineProperties(video, { videoWidth: { value: width }, videoHeight: { value: height } });
    fireEvent.loadedMetadata(video);
    expect(screen.getByTestId('cloud-video-result').style.width).toBe(
      Math.min(width, (500 * width) / height) + 26 + 'px'
    );
    expect(video).toHaveStyle({ width: '100%' });
  });
  it('disables save while loading an existing connection to avoid creating a replacement', () => {
    vi.mocked(cloudVideoApi.connections).mockReturnValue(new Promise(() => {}));
    render(
      <CloudVideoSetup
        model={{
          id: 'cloud-video:existing',
          name: 'Existing',
          kind: 'video',
          source: 'cloud',
          state: 'configured',
          available: true,
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  });
  it('saves the H3 deployment without requiring a key and selects the saved connection', async () => {
    vi.mocked(cloudVideoApi.save).mockResolvedValue({ id: 'saved' } as Awaited<ReturnType<typeof cloudVideoApi.save>>);
    const saved = vi.fn();
    render(
      <CloudVideoSetup
        model={{
          id: 'preset::cloud-video',
          name: '',
          kind: 'video',
          source: 'cloud',
          state: 'not-configured',
          available: false,
        }}
        onClose={vi.fn()}
        onSaved={saved}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith('cloud-video:saved'));
    expect(cloudVideoApi.save).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'vllm-h3', baseUrl: 'http://10.1.1.32:8091/v1', model: '' })
    );
    expect(vi.mocked(cloudVideoApi.save).mock.calls[0][0]).not.toHaveProperty('apiKey');
  });
  it('renders the downloaded cloud result using its conversation-scoped artifact URL', async () => {
    vi.mocked(cloudVideoApi.job).mockResolvedValue({ id: 'job-ui', status: 'succeeded', model: 'H3' } as Awaited<
      ReturnType<typeof cloudVideoApi.job>
    >);
    render(<CloudVideoResult id='job-ui' conversationId='conversation-ui' />);
    expect(await screen.findByLabelText('guid.creation.cloudVideo')).toHaveAttribute(
      'src',
      'http://localhost/video.mp4'
    );
    expect(cloudVideoApi.artifactUrl).toHaveBeenCalledWith('job-ui', 'conversation-ui');
  });
  it('extracts submitted job IDs from results without taking IDs from tool arguments', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    expect(cloudVideoJobIds([{ type: 'tool_call', content: { args: { cloudVideoJobId: id } } }])).toEqual([]);
    expect(
      cloudVideoJobIds([{ type: 'tool_call', content: { output: JSON.stringify({ cloudVideoJobId: id }) } }])
    ).toEqual([id]);
  });
});
