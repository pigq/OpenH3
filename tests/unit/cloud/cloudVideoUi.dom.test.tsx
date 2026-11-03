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
