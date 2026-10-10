import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import H3ToolResults, {
  h3ToolJobIds,
  h3TurnResults,
  stripH3PlayerMarkup,
} from '@/renderer/pages/conversation/Messages/components/H3ToolResults';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const mocks = vi.hoisted(() => ({ get: vi.fn(), close: vi.fn(), events: vi.fn(), cancel: vi.fn() }));
vi.mock('@/common/chat/document/h3JobApi', () => ({
  h3JobApi: {
    get: mocks.get,
    events: (id: string, update: unknown) => {
      mocks.events(id, update);
      return { close: mocks.close };
    },
    cancel: mocks.cancel,
    resourceUrl: (p: string) => `http://127.0.0.1:33002${p}`,
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const id = '8ca61811-cd38-4d15-b24b-44fb30175eaa';
const message = { type: 'tool_call', content: { name: 'aionui_h3_job_status', output: JSON.stringify({ id }) } };
it('deduplicates known H3 jobs and ignores malformed or unrelated tool output', () => {
  expect(
    h3ToolJobIds([
      message,
      message,
      { type: 'text', content: message.content },
      { type: 'tool_call', content: { name: 'other', output: JSON.stringify({ id }) } },
      { type: 'tool_call', content: { name: 'aionui_h3_job_status', output: 'incomplete' } },
    ])
  ).toEqual([id]);
});
it('renders the verified local resource and disconnects events on unmount', async () => {
  mocks.get.mockResolvedValue({
    id,
    status: 'succeeded',
    artifacts: [{ filename: 'lake.mp4', mimeType: 'video/mp4', resourcePath: `/api/h3/jobs/${id}/artifacts/0` }],
  });
  const view = render(<H3ToolResults messages={[message]} />);
  await waitFor(() =>
    expect(view.container.querySelector('video')?.src).toBe(`http://127.0.0.1:33002/api/h3/jobs/${id}/artifacts/0`)
  );
  view.unmount();
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('does not render foreign or traversal resource paths', async () => {
  mocks.get.mockResolvedValue({
    id,
    status: 'succeeded',
    artifacts: [{ filename: 'bad', mimeType: 'video/mp4', resourcePath: 'https://example.com/tracker' }],
  });
  const view = render(<H3ToolResults messages={[message]} />);
  await waitFor(() => expect(view.getByTestId('h3-chat-result')).toBeTruthy());
  expect(view.container.querySelector('video')).toBeNull();
});

it('does not subscribe or repeat a result already owned by an earlier tool group', () => {
  const view = render(<H3ToolResults messages={[message]} jobIds={[]} />);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(view.container.querySelector('video')).toBeNull();
});

it('places one result after the final reply and preserves earlier turns', () => {
  const secondId = '293682c6-0caa-4b7a-8e26-a503e3edf019';
  const items = [
    { id: 'user1', type: 'text', position: 'right' },
    { id: 'tools1', type: 'tool_summary', messages: [message] },
    { id: 'tools2', type: 'tool_summary', messages: [message] },
    { id: 'final1', type: 'text', position: 'left' },
    { id: 'user2', type: 'text', position: 'right' },
    {
      id: 'tools3',
      type: 'tool_summary',
      messages: [{ ...message, content: { ...message.content, output: JSON.stringify({ id: secondId }) } }],
    },
  ];
  expect([...h3TurnResults(items)]).toEqual([
    ['final1', [id]],
    ['tools3', [secondId]],
  ]);
  expect([...h3TurnResults([...items, { id: 'final2', type: 'text', position: 'left' }])]).toEqual([
    ['final1', [id]],
    ['final2', [secondId]],
  ]);
});
it('removes known generated HTML without hiding unrelated source examples', () => {
  const markup = '<video controls src="/api/h3/jobs/' + id + '/artifacts/0"></video>';
  expect(stripH3PlayerMarkup('Done\n' + markup, [id])).toBe('Done');
  expect(stripH3PlayerMarkup(markup, [])).toBe(markup);
  expect(stripH3PlayerMarkup('<video src="https://example.com/movie.mp4"></video>', [id])).toContain('example.com');
});

it('keeps an asynchronous video job visible through running and failure even after tool completion', async () => {
  mocks.get.mockResolvedValue({ id, status: 'queued', progress: 0, artifacts: [] });
  const view = render(<H3ToolResults messages={[message]} />);
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('queued'));
  const update = mocks.events.mock.calls[0][1];
  act(() => update({ id, status: 'running', progress: 0.4, artifacts: [] }));
  expect(view.getByRole('status').textContent).toContain('running');
  act(() => update({ id, status: 'failed', progress: 0.4, artifacts: [], error: 'Out of memory' }));
  expect(view.getByRole('alert').textContent).toBe('Out of memory');
});
it('reports unavailable status instead of silently disappearing', async () => {
  mocks.get.mockRejectedValue(new Error('offline'));
  const view = render(<H3ToolResults messages={[message]} />);
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('disconnected'));
});

it('cancels the actual running job and retains its terminal card', async () => {
  mocks.get.mockResolvedValue({ id, status: 'running', progress: 0.2, artifacts: [] });
  mocks.cancel.mockResolvedValue({ id, status: 'cancelled', progress: 0.2, artifacts: [] });
  const view = render(<H3ToolResults messages={[message]} />);
  fireEvent.click(await view.findByRole('button', { name: 'conversation.h3Activity.cancel' }));
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('cancelled'));
  expect(mocks.cancel).toHaveBeenCalledWith(id);
  expect(view.queryByRole('button')).toBeNull();
});

it('shows actual video metadata and persisted elapsed time beneath the player', async () => {
  mocks.get.mockResolvedValue({
    id,
    status: 'succeeded',
    startedAt: '2026-09-22T00:00:00Z',
    finishedAt: '2026-09-22T00:01:05Z',
    artifacts: [{ filename: 'lake.mp4', mimeType: 'video/mp4', resourcePath: '/api/h3/jobs/' + id + '/artifacts/0' }],
  });
  const view = render(<H3ToolResults messages={[message]} />);
  const video = await view.findByLabelText('lake.mp4');
  Object.defineProperties(video, {
    duration: { value: 4.458333 },
    videoWidth: { value: 608 },
    videoHeight: { value: 352 },
  });
  fireEvent.loadedMetadata(video);
  const parameters = view.getByTestId('h3-video-parameters');
  expect(parameters.textContent).toContain('4.46 s');
  expect(parameters.textContent).toContain('608 × 352');
  expect(parameters.textContent).toContain('1 min 5 s');
});
it('does not invent elapsed time for legacy jobs', async () => {
  mocks.get.mockResolvedValue({
    id,
    status: 'succeeded',
    artifacts: [{ filename: 'old.mp4', mimeType: 'video/mp4', resourcePath: '/api/h3/jobs/' + id + '/artifacts/0' }],
  });
  const view = render(<H3ToolResults messages={[message]} />);
  await view.findByLabelText('old.mp4');
  expect(view.getByTestId('h3-video-parameters').textContent).toContain(
    'elapsedLabel conversation.h3Activity.notRecorded'
  );
});

it('does not present a legacy placeholder as a total completion percentage', async () => {
  mocks.get.mockResolvedValue({ id, status: 'running', progress: 0.1, artifacts: [] });
  const view = render(<H3ToolResults messages={[message]} />);
  await view.findByRole('button');
  expect(view.queryByText('10%')).toBeNull();
  expect(view.getByTestId('h3-live-progress').textContent).toContain('waitingProgress');
});
it('labels a measured node fraction instead of total progress', async () => {
  mocks.get.mockResolvedValue({
    id,
    status: 'running',
    progress: 0,
    activity: { phase: 'node-progress', nodeId: '125', value: 2, max: 4, updatedAt: new Date().toISOString() },
    artifacts: [],
  });
  const view = render(<H3ToolResults messages={[message]} />);
  await view.findByText('50%');
  expect(view.getByTestId('h3-live-progress').textContent).toContain('nodeProgress');
});

it('offers remote-stop confirmation for a failed job that still blocks dispatch', async () => {
  mocks.get.mockResolvedValue({
    id,
    status: 'failed',
    remoteUncertain: true,
    artifacts: [],
    error: 'H3_COMFY_HISTORY_TIMEOUT',
  });
  mocks.cancel.mockResolvedValue({ id, status: 'failed', remoteUncertain: false, artifacts: [] });
  const view = render(<H3ToolResults messages={[message]} />);
  const confirm = await view.findByText('conversation.h3Activity.confirmStop');
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(id));
  await waitFor(() => expect(view.queryByText('conversation.h3Activity.confirmStop')).toBeNull());
});
