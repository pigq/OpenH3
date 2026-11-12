import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import { createInstance } from 'i18next';
import i18nConfig from '@/common/config/i18n-config.json';
import type { ComfyGenerationJob } from '@/common/chat/document/creation/comfy';
import MarkdownView from '@/renderer/components/Markdown';
import { RenderedMediaProvider } from '@/renderer/components/Markdown/RenderedMediaContext';
import ComfyGenerationResult, {
  comfyGenerationTurnResults,
} from '@/renderer/pages/conversation/runtime/Creation/ComfyGenerationResult';
import { resetCurrentConversationForTest } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { resetWorkProgressForTest } from '@/renderer/pages/conversation/PlanBar/workProgress';

const mocks = vi.hoisted(() => ({
  job: vi.fn(),
  cancelJob: vi.fn(),
  jobArtifactUrl: vi.fn(),
  operation: vi.fn(),
  profiles: vi.fn(),
  activity: vi.fn(),
  translate: (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(':')}` : key,
}));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({
  comfyApi: mocks,
  COMFY_INVENTORY_CACHE_KEY: 'creation.comfy-inventory',
}));
vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/renderer/components/Markdown/ShadowView', () => ({
  default: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('@/renderer/components/Markdown/CodeBlock', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/LocalImageView', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));
vi.mock('@/renderer/hooks/chat/useSendBoxDraft', () => ({ requestConversationSendBoxPrefill: vi.fn() }));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({ isProcessing: false, hydrated: true, view: { pendingConfirmations: 0 } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));

const JOB_ID = '12345678-1234-1234-1234-123456789abc';
const CONVERSATION_ID = 'conv-1';
const SECOND_JOB_ID = '87654321-1234-1234-1234-123456789abc';
const output = (id: string) => ({ type: 'tool_group', content: [{ output: JSON.stringify({ comfyJobId: id }) }] });
const job = (
  overrides: Partial<ComfyGenerationJob> & { diagnosticLogPath?: string } = {}
): ComfyGenerationJob & {
  diagnosticLogPath?: string;
} => ({
  id: JOB_ID,
  profileId: 'qwen-edit-2509',
  kind: 'image',
  status: 'queued',
  progress: 0,
  artifacts: [],
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
  ...overrides,
});

async function renderResult(id = JOB_ID) {
  const result = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ComfyGenerationResult id={id} conversationId={CONVERSATION_ID} />
    </SWRConfig>
  );
  await act(async () => {});
  return result;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('ComfyUI generation result', () => {
  it('keeps one preview for completed artifacts while preserving captions, links and other images', async () => {
    mocks.jobArtifactUrl.mockImplementation(
      (id: string, index: number, conversationId: string) =>
        `http://127.0.0.1:33002/api/comfy/jobs/${id}/artifacts/${index}?conversationId=${conversationId}`
    );
    mocks.job.mockResolvedValue(
      job({
        observationOnly: true,
        status: 'succeeded',
        artifacts: [
          { path: 'D:\\生成结果\\final image.png', mimeType: 'image/png' },
          { path: 'D:\\生成结果\\clip.mp4', mimeType: 'video/mp4' },
        ],
      })
    );
    const content = (card: boolean) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <RenderedMediaProvider>
          <MarkdownView
            allowHtml
            onLocalFileLink={vi.fn()}
          >{`Caption\n\n![Generated image](file:///D:/%E7%94%9F%E6%88%90%E7%BB%93%E6%9E%9C/final%20image.png)\n\n![Archived image](http://localhost:33003/api/comfy/jobs/${JOB_ID}/artifacts/0?conversationId=${CONVERSATION_ID})\n\n![Other conversation](http://localhost:33003/api/comfy/jobs/${JOB_ID}/artifacts/0?conversationId=conv-2)\n\n![Other image](D:/other/final%20image.png)\n\n[Open original](D:/%E7%94%9F%E6%88%90%E7%BB%93%E6%9E%9C/final%20image.png)\n\n<video src="D:/生成结果/clip.mp4" controls></video>`}</MarkdownView>
          {card && <ComfyGenerationResult id={JOB_ID} conversationId={CONVERSATION_ID} />}
        </RenderedMediaProvider>
      </SWRConfig>
    );
    const view = render(content(true));
    await act(async () => {});
    expect(screen.queryByRole('img', { name: 'Generated image' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Archived image' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Other conversation' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Other image' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'guid.comfy.generation.artifact:1' })).toBeInTheDocument();
    expect(view.container.querySelectorAll('video')).toHaveLength(1);
    expect(screen.getByText('Caption')).toBeInTheDocument();
    expect(screen.getByText('Generated image')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open original' })).toBeInTheDocument();
    view.rerender(content(false));
    await act(async () => {});
    expect(screen.getByRole('img', { name: 'Generated image' })).toBeInTheDocument();
    expect(view.container.querySelectorAll('video')).toHaveLength(1);
  });
  it('monitors externally submitted prompts and shows results without offering a misleading cancel action', async () => {
    mocks.job.mockResolvedValue(job({ observationOnly: true, status: 'running' }));
    await renderResult();
    expect(screen.queryByText('guid.comfy.generation.cancel')).not.toBeInTheDocument();
    mocks.job.mockResolvedValue(
      job({
        observationOnly: true,
        status: 'succeeded',
        progress: 100,
        artifacts: [{ path: 'C:/OpenH3/saved.png', mimeType: 'image/png' }],
      })
    );
    await advance(1500);
    expect(screen.getByRole('img')).toHaveAttribute('src', `/jobs/${JOB_ID}/0`);
  });
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.translate = (key, values) => (values ? `${key}:${Object.values(values).join(':')}` : key);
    mocks.job.mockReset().mockResolvedValue(job());
    mocks.cancelJob.mockReset().mockResolvedValue(job({ status: 'cancelled' }));
    mocks.jobArtifactUrl.mockReset().mockImplementation((id: string, index: number) => `/jobs/${id}/${index}`);
    mocks.operation.mockReset();
    mocks.profiles.mockReset().mockResolvedValue([]);
    mocks.activity.mockReset().mockResolvedValue({ operations: [], jobs: [], preparations: [] });
  });

  afterEach(() => {
    cleanup();
    resetCurrentConversationForTest();
    resetWorkProgressForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads job IDs from native and ACP outputs and ignores inputs, text, and operation IDs', () => {
    const groups = comfyGenerationTurnResults([
      {
        id: 'native-tool',
        type: 'tool_call',
        position: 'left',
        messages: [
          {
            type: 'tool_call',
            content: {
              args: { comfyJobId: SECOND_JOB_ID },
              result: { content: [{ type: 'text', text: JSON.stringify({ comfyJobId: JOB_ID }) }] },
            },
          },
          { type: 'text', content: JSON.stringify({ comfyJobId: SECOND_JOB_ID }) },
          { type: 'acp_tool_call', content: { output: JSON.stringify({ comfyOperationId: SECOND_JOB_ID }) } },
        ],
      },
      {
        id: 'acp-tool',
        type: 'acp_tool_call',
        position: 'left',
        messages: [
          { type: 'acp_tool_call', content: { output: JSON.stringify({ comfyJobId: SECOND_JOB_ID }) } },
          { type: 'acp_tool_call', content: { output: JSON.stringify({ comfyJobId: '../invalid' }) } },
        ],
      },
      { id: 'assistant-reply', type: 'text', position: 'left' },
    ]);
    expect([...groups.entries()]).toEqual([['assistant-reply', [JOB_ID, SECOND_JOB_ID]]]);
  });

  it('anchors unique generation outputs after each assistant turn', () => {
    const groups = comfyGenerationTurnResults([
      { id: 'tool-1', type: 'tool_group', messages: [output(JOB_ID), output(JOB_ID)] },
      { id: 'reply-1', type: 'text', position: 'left' },
      { id: 'user', type: 'text', position: 'right' },
      { id: 'tool-2', type: 'tool_group', messages: [output(JOB_ID), output(SECOND_JOB_ID)] },
      { id: 'reply-2', type: 'text', position: 'left' },
    ]);
    expect([...groups.entries()]).toEqual([
      ['reply-1', [JOB_ID]],
      ['reply-2', [SECOND_JOB_ID]],
    ]);
  });

  it('renders image and video previews from application artifact URLs', async () => {
    mocks.job.mockResolvedValue(
      job({
        status: 'succeeded',
        progress: 100,
        artifacts: [
          { path: 'D:\\models\\result.png', mimeType: 'image/png' },
          { path: 'D:\\models\\result.mp4', mimeType: 'video/mp4' },
          { path: 'D:\\models\\metadata.json', mimeType: 'application/json' },
        ],
      })
    );
    await renderResult();
    expect(screen.getByRole('img')).toHaveAttribute('src', `/jobs/${JOB_ID}/0`);
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'guid.comfy.generation.artifact:1');
    const video = screen.getByLabelText('guid.comfy.generation.artifact:2');
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('src', `/jobs/${JOB_ID}/1`);
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(mocks.job).toHaveBeenCalledWith(JOB_ID, CONVERSATION_ID);
    expect(mocks.jobArtifactUrl).toHaveBeenCalledWith(JOB_ID, 0, CONVERSATION_ID);
    expect(mocks.jobArtifactUrl).toHaveBeenCalledWith(JOB_ID, 1, CONVERSATION_ID);
    expect(screen.queryByRole('button', { name: 'guid.comfy.generation.cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveStyle({ maxHeight: 'min(420px, 52dvh)', objectFit: 'contain' });
    expect(screen.getByRole('button', { name: /guid.comfy.generation.artifact:1/ })).toHaveAttribute(
      'aria-haspopup',
      'dialog'
    );
  });

  it.each([
    [720, 1280, 236.25],
    [1024, 1024, 420],
    [1920, 1080, 640],
  ])('fits the video card to its %s × %s natural aspect ratio', async (width, height, expectedWidth) => {
    mocks.job.mockResolvedValue(
      job({ status: 'succeeded', kind: 'video', artifacts: [{ path: 'result.mp4', mimeType: 'video/mp4' }] })
    );
    await renderResult();
    const video = screen.getByLabelText('guid.comfy.generation.artifact:1');
    Object.defineProperties(video, {
      videoWidth: { value: width, configurable: true },
      videoHeight: { value: height, configurable: true },
      duration: { value: 5.25, configurable: true },
    });
    fireEvent.loadedMetadata(video);
    const card = screen.getByTestId('comfy-generation-result');
    expect(card.style.width).toBe('calc(var(--comfy-media-width) + 26px)');
    expect(card.style.getPropertyValue('--comfy-media-width')).toContain(`${expectedWidth}px`);
    expect(card.style.getPropertyValue('--comfy-media-width')).toContain(`${(52 * width) / height}dvh`);
    expect(card).toHaveStyle({ maxWidth: '100%', boxSizing: 'border-box' });
    expect(video).toHaveStyle({ aspectRatio: `${width} / ${height}`, objectFit: 'contain', width: '100%' });
  });

  it('sizes an image card to its loaded portrait without losing the image viewer', async () => {
    mocks.job.mockResolvedValue(
      job({ status: 'succeeded', artifacts: [{ path: 'portrait.png', mimeType: 'image/png' }] })
    );
    await renderResult();
    const image = screen.getByRole('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 600, configurable: true },
      naturalHeight: { value: 1200, configurable: true },
    });
    fireEvent.load(image);
    expect(screen.getByTestId('comfy-generation-result').style.getPropertyValue('--comfy-media-width')).toContain(
      '210px'
    );
    expect(screen.getByRole('button', { name: /artifact:1/ })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(image).toHaveStyle({ objectFit: 'contain' });
  });

  it('shows measured video dimensions, duration and elapsed time without inventing metadata', async () => {
    mocks.job.mockResolvedValue(
      job({
        status: 'succeeded',
        kind: 'video',
        updatedAt: '2026-10-14T00:02:05.000Z',
        artifacts: [{ path: 'result.mp4', mimeType: 'video/mp4' }],
      })
    );
    await renderResult();
    const footer = screen.getByTestId('comfy-video-metadata');
    expect(footer).toHaveTextContent('conversation.h3Activity.notRecorded');
    expect(footer).toHaveTextContent('guid.comfy.generation.elapsed:125');
    const video = screen.getByLabelText('guid.comfy.generation.artifact:1');
    Object.defineProperties(video, {
      videoWidth: { value: 1280, configurable: true },
      videoHeight: { value: 720, configurable: true },
      duration: { value: 5.25, configurable: true },
    });
    fireEvent.loadedMetadata(video);
    expect(footer).toHaveTextContent('1280 × 720');
    expect(footer).toHaveTextContent('5.25 s');
  });

  it('does not carry media measurements into another conversation or job', async () => {
    mocks.job.mockResolvedValue(
      job({ status: 'succeeded', kind: 'video', artifacts: [{ path: 'result.mp4', mimeType: 'video/mp4' }] })
    );
    const cache = new Map();
    const content = (conversationId: string) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <ComfyGenerationResult id={JOB_ID} conversationId={conversationId} />
      </SWRConfig>
    );
    const view = render(content(CONVERSATION_ID));
    await act(async () => {});
    const video = screen.getByLabelText('guid.comfy.generation.artifact:1');
    Object.defineProperties(video, {
      videoWidth: { value: 600, configurable: true },
      videoHeight: { value: 1200, configurable: true },
      duration: { value: 6, configurable: true },
    });
    fireEvent.loadedMetadata(video);
    expect(screen.getByTestId('comfy-video-metadata')).toHaveTextContent('600 × 1200');
    view.rerender(content('conv-2'));
    await act(async () => {});
    expect(screen.getByTestId('comfy-video-metadata')).not.toHaveTextContent('600 × 1200');
    expect(screen.getByTestId('comfy-generation-result').style.getPropertyValue('--comfy-media-width')).toBe('');
    expect(mocks.job).toHaveBeenCalledWith(JOB_ID, 'conv-2');
  });

  it('keeps unknown metadata explicit for invalid dimensions, duration and elapsed timestamps', async () => {
    mocks.job.mockResolvedValue(
      job({
        status: 'succeeded',
        kind: 'video',
        updatedAt: 'invalid date',
        artifacts: [{ path: 'unknown.mp4', mimeType: 'video/mp4' }],
      })
    );
    await renderResult();
    const video = screen.getByLabelText('guid.comfy.generation.artifact:1');
    Object.defineProperties(video, {
      videoWidth: { value: Infinity, configurable: true },
      videoHeight: { value: 0, configurable: true },
      duration: { value: NaN, configurable: true },
    });
    fireEvent.loadedMetadata(video);
    const footer = screen.getByTestId('comfy-video-metadata');
    expect(footer).toHaveTextContent('conversation.h3Activity.notRecorded');
    expect(footer).not.toHaveTextContent(/Infinity|NaN|guid.comfy.generation.elapsed:/);
    expect(screen.getByTestId('comfy-generation-result').style.getPropertyValue('--comfy-media-width')).toBe('');
  });

  const locales = import.meta.glob<Record<string, unknown>>(
    '../../../packages/desktop/src/renderer/services/i18n/locales/*/guid.json',
    { eager: true, import: 'default' }
  );
  it.each(i18nConfig.supportedLanguages)('renders elapsed metadata from %s without fallback', async (code) => {
    const guid = locales[`../../../packages/desktop/src/renderer/services/i18n/locales/${code}/guid.json`];
    const i18n = createInstance();
    await i18n.init({ lng: code, fallbackLng: false, resources: { [code]: { translation: { guid } } } });
    mocks.translate = (key, values) => i18n.t(key, values);
    mocks.job.mockImplementation((id: string) =>
      Promise.resolve(
        id === JOB_ID
          ? job({ status: 'failed', recoveredBy: SECOND_JOB_ID, error: 'Earlier failure' })
          : job({
              id: SECOND_JOB_ID,
              status: 'succeeded',
              kind: 'video',
              updatedAt: '2026-10-14T00:02:05.000Z',
              artifacts: [{ path: 'success.mp4', mimeType: 'video/mp4' }],
            })
      )
    );
    await renderResult(SECOND_JOB_ID);
    const translated = i18n.t('guid.comfy.generation.elapsed', { seconds: 125 });
    expect(screen.getByTestId('comfy-video-metadata')).toHaveTextContent(translated);
    expect(translated).toContain('125');
    expect(translated).not.toContain('{{');
    expect(translated).not.toBe('guid.comfy.generation.elapsed');
  });

  it('keeps polling cache and results separate when the same job ID is referenced in another conversation', async () => {
    mocks.job.mockImplementation((_id: string, conversationId: string) =>
      Promise.resolve(job({ status: 'failed', error: conversationId }))
    );
    const cache = new Map();
    const content = (conversationId: string) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <ComfyGenerationResult id={JOB_ID} conversationId={conversationId} />
      </SWRConfig>
    );
    const view = render(content('conv-1'));
    await act(async () => {});
    expect(screen.queryByTestId('comfy-generation-result')).not.toBeInTheDocument();
    view.rerender(content('conv-2'));
    await act(async () => {});
    expect(mocks.job).toHaveBeenCalledWith(JOB_ID, 'conv-2');
    expect(screen.queryByTestId('comfy-generation-result')).not.toBeInTheDocument();
  });

  it('shows bounded parameter changes and the actual generation input', async () => {
    mocks.job.mockResolvedValue(
      job({
        status: 'succeeded',
        adjustments: [{ reason: 'GPU memory budget', input: { prompt: 'a flower', width: 768, height: 512 } }],
      })
    );
    await renderResult();
    expect(screen.getByText('guid.comfy.generation.adjusted')).toBeInTheDocument();
    expect(screen.getByText('GPU memory budget')).toBeInTheDocument();
    fireEvent.click(screen.getByText('guid.comfy.generation.actualInput'));
    expect(screen.getByText(/"width": 768/)).toBeInTheDocument();
    expect(screen.getByText(/"height": 512/)).toBeInTheDocument();
  });

  it('does not render terminal failed attempts as result cards', async () => {
    mocks.job.mockResolvedValue(job({ status: 'failed', error: 'COMFY_INPUT_UNSUPPORTED:width' }));
    await renderResult();
    expect(screen.queryByTestId('comfy-generation-result')).not.toBeInTheDocument();
    expect(screen.queryByText('COMFY_INPUT_UNSUPPORTED:width')).not.toBeInTheDocument();
  });

  it('shows diagnosis and uncertain submission guidance without offering another submission', async () => {
    mocks.job.mockResolvedValue(
      job({
        status: 'failed',
        submissionUncertain: true,
        diagnosis: { category: 'submission', retryable: false, action: 'Inspect queue', nodeId: '12' },
      })
    );
    await renderResult();
    expect(screen.getByText('guid.comfy.generation.submissionUncertain')).toBeInTheDocument();
    expect(screen.getByText(/Inspect queue/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the diagnostic log path without fetching log contents', async () => {
    mocks.job.mockResolvedValue(job({ diagnosticLogPath: 'D:/ComfyUI/logs/job-1.jsonl' }));
    await renderResult();
    fireEvent.click(screen.getByText('guid.comfy.diagnosticLog'));
    expect(screen.getByText('D:/ComfyUI/logs/job-1.jsonl')).toBeInTheDocument();
    expect(screen.queryByText(/raw log|stack trace/i)).not.toBeInTheDocument();
  });

  it('fetches once per polling interval and stops after success', async () => {
    mocks.job
      .mockResolvedValueOnce(job())
      .mockResolvedValueOnce(job({ status: 'running', progress: 35 }))
      .mockResolvedValue(job({ status: 'succeeded', progress: 100 }));
    await renderResult();
    expect(mocks.job).toHaveBeenCalledTimes(1);
    await advance(1500);
    expect(mocks.job).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('guid.comfy.generation.states.running');
    await advance(1500);
    expect(mocks.job).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('status')).toHaveTextContent('guid.comfy.generation.states.succeeded');
    await advance(15_000);
    expect(mocks.job).toHaveBeenCalledTimes(3);
  });

  it.each(['failed', 'cancelled'] as const)('does not poll a %s job', async (status) => {
    mocks.job.mockResolvedValue(job({ status, ...(status === 'failed' ? { error: 'Workflow failed' } : {}) }));
    await renderResult();
    await advance(15_000);
    expect(mocks.job).toHaveBeenCalledTimes(1);
    if (status === 'failed') expect(screen.queryByTestId('comfy-generation-result')).not.toBeInTheDocument();
    else expect(screen.getByRole('status')).toHaveTextContent(`guid.comfy.generation.states.${status}`);
  });

  it('retries an unavailable initial fetch and clears the failure after recovery', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    mocks.job.mockRejectedValueOnce(new Error('Service unavailable')).mockResolvedValue(job({ status: 'succeeded' }));
    await renderResult();
    expect(screen.getByRole('alert')).toHaveTextContent('guid.comfy.generation.unavailable');
    await advance(4000);
    expect(mocks.job).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('guid.comfy.generation.states.succeeded');
  });

  it('cancels the job on request and stops polling', async () => {
    await renderResult();
    expect(mocks.cancelJob).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.generation.cancel' }));
    });
    expect(mocks.cancelJob).toHaveBeenCalledWith(JOB_ID, CONVERSATION_ID);
    expect(screen.getByRole('status')).toHaveTextContent('guid.comfy.generation.states.cancelled');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    await advance(15_000);
    expect(mocks.job).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation errors visible while polling the active job', async () => {
    mocks.cancelJob.mockRejectedValue(new Error('Cancellation failed'));
    await renderResult();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.generation.cancel' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Cancellation failed');
    await advance(1500);
    expect(mocks.job).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'guid.comfy.generation.cancel' })).not.toBeDisabled();
  });

  it('does not let an in-flight poll overwrite a completed cancellation', async () => {
    let resolvePoll: ((value: ComfyGenerationJob) => void) | undefined;
    mocks.job.mockResolvedValueOnce(job()).mockImplementationOnce(
      () =>
        new Promise<ComfyGenerationJob>((resolve) => {
          resolvePoll = resolve;
        })
    );
    await renderResult();
    await advance(1500);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.generation.cancel' }));
    });
    await act(async () => {
      resolvePoll?.(job({ status: 'running' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('guid.comfy.generation.states.cancelled');
    await advance(15_000);
    expect(mocks.job).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the card unmounts', async () => {
    const { unmount } = await renderResult();
    unmount();
    await advance(15_000);
    expect(mocks.job).toHaveBeenCalledTimes(1);
  });
});
