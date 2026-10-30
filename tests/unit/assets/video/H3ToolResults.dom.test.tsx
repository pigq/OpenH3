import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import H3ToolResults, {
  h3ToolJobIds,
  h3TurnResults,
  stripH3PlayerMarkup,
} from '@/renderer/pages/conversation/Messages/components/H3ToolResults';
import { resetH3JobsForTest, useH3Jobs } from '@/renderer/pages/conversation/runtime/Creation/useH3Jobs';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const mocks = vi.hoisted(() => ({ get: vi.fn(), close: vi.fn(), events: vi.fn(), cancel: vi.fn() }));
vi.mock('@/common/chat/document/h3JobApi', () => ({
  h3JobApi: {
    get: mocks.get,
    events: (id: string, update: unknown) => {
      const source = { close: mocks.close, onerror: undefined as (() => void) | undefined };
      mocks.events(id, update, source);
      return source;
    },
    cancel: mocks.cancel,
    resourceUrl: (p: string) => `http://127.0.0.1:33002${p}`,
  },
}));
afterEach(() => {
  cleanup();
  resetH3JobsForTest();
  vi.useRealTimers();
  vi.clearAllMocks();
});
const id = '8ca61811-cd38-4d15-b24b-44fb30175eaa';
const message = { type: 'tool_call', content: { name: 'aionui_h3_job_status', output: JSON.stringify({ id }) } };
it('recognizes canonical OpenH3 tool results alongside old chat records', () => {
  expect(
    h3ToolJobIds([
      message,
      { type: 'tool_call', content: { name: 'openh3_h3_generate_video', output: JSON.stringify({ id }) } },
    ])
  ).toEqual([id]);
});
it('deduplicates known H3 jobs and ignores malformed or unrelated tool output', () => {
  expect(
    h3ToolJobIds([
      message,
      message,
      { type: 'text', content: message.content },
      { type: 'tool_call', content: { name: 'other', output: JSON.stringify({ id }) } },
      { type: 'tool_call', content: {} },
      { type: 'tool_call', content: null },
      { type: 'tool_call', content: { name: 7, output: JSON.stringify({ id }) } },
      { type: 'tool_call', content: { name: 'aionui_h3_job_status', output: 'incomplete' } },
    ])
  ).toEqual([id]);
});
it('finds the initial generation job inside MCP text envelopes without another status request', async () => {
  const queued = { id, status: 'queued', spec: { prompt: 'animate the photo' }, artifacts: [] };
  const envelope = { content: [{ type: 'text', text: JSON.stringify(queued) }] };
  const submitted = {
    type: 'tool_call',
    content: { name: 'aionui_h3_generate_video', status: 'completed', output: JSON.stringify(envelope) },
  };
  expect(h3ToolJobIds([submitted])).toEqual([id]);
  expect(h3ToolJobIds([{ ...submitted, content: { ...submitted.content, output: envelope } }])).toEqual([id]);
  mocks.get.mockResolvedValue(queued);
  const view = render(<H3ToolResults messages={[submitted]} />);
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('queued'));
  expect(mocks.events).toHaveBeenCalledOnce();
  const update = mocks.events.mock.calls[0][1];
  act(() => update({ ...queued, status: 'running' }));
  expect(view.getByRole('status').textContent).toContain('running');
  act(() =>
    update({
      ...queued,
      status: 'succeeded',
      artifacts: [{ filename: 'photo.mp4', mimeType: 'video/mp4', resourcePath: `/api/h3/jobs/${id}/artifacts/0` }],
    })
  );
  expect(view.getByRole('status').textContent).toContain('succeeded');
  expect(view.container.querySelector('video')?.src).toContain(`/api/h3/jobs/${id}/artifacts/0`);
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('ignores input identifiers and unrelated native jobs even when the input resembles an H3 result', () => {
  const output = { id, spec: {}, status: 'queued', artifacts: [] };
  expect(
    h3ToolJobIds([
      { type: 'tool_call', content: { name: 'aionui_h3_generate_video', args: output } },
      { type: 'acp_tool_call', content: { rawInput: JSON.stringify(output) } },
      { type: 'tool_call', content: { name: 'other', output } },
      { type: 'tool_call', content: { name: 'aionui_h3_generate_video', output: { id: 'z'.repeat(36) } } },
    ])
  ).toEqual([]);
  expect(
    h3ToolJobIds([
      {
        type: 'acp_tool_call',
        content: { update: { content: [{ type: 'text', text: JSON.stringify({ content: [output] }) }] } },
      },
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

it('shares the live job connection between result cards and keeps it until the final observer leaves', async () => {
  mocks.get.mockResolvedValue({ id, status: 'running', artifacts: [] });
  const first = render(<H3ToolResults messages={[message]} />);
  const second = render(<H3ToolResults messages={[message]} />);
  await waitFor(() => expect(first.getAllByTestId('h3-live-progress')).toHaveLength(2));
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(mocks.events).toHaveBeenCalledOnce();
  first.unmount();
  expect(mocks.close).not.toHaveBeenCalled();
  second.unmount();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('retains a canonical shared job when history eviction overlaps a changed observer list', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  mocks.get.mockImplementation(async (jobId: string) => ({ id: jobId, status: 'running', artifacts: [] }));
  const first = renderHook(({ watched }) => useH3Jobs(watched), { initialProps: { watched: ids } });
  await waitFor(() => expect(first.result.current[0].job?.status).toBe('running'));
  first.rerender({ watched: [ids[0]] });
  const before = mocks.events.mock.calls.filter(([jobId]) => jobId === ids[0]).length;
  const second = renderHook(() => useH3Jobs([ids[0]]));
  await waitFor(() => expect(second.result.current[0].job?.status).toBe('running'));
  expect(mocks.events.mock.calls.filter(([jobId]) => jobId === ids[0])).toHaveLength(before);
});

it('does not regress live progress when the initial HTTP snapshot arrives after a terminal event', async () => {
  let resolve: (job: unknown) => void = () => {};
  mocks.get.mockReturnValue(new Promise((done) => (resolve = done)));
  const view = render(<H3ToolResults messages={[message]} />);
  const update = mocks.events.mock.calls[0][1];
  act(() => update({ id, status: 'succeeded', artifacts: [] }));
  await act(async () => resolve({ id, status: 'queued', artifacts: [] }));
  expect(view.getByRole('status').textContent).toContain('succeeded');
  expect(mocks.events).toHaveBeenCalledOnce();
});

it('refreshes immediately when the event stream disconnects and shows the completed video', async () => {
  mocks.get.mockResolvedValueOnce({ id, status: 'running', artifacts: [] }).mockResolvedValueOnce({
    id,
    status: 'succeeded',
    artifacts: [{ filename: 'photo.mp4', mimeType: 'video/mp4', resourcePath: `/api/h3/jobs/${id}/artifacts/0` }],
  });
  const view = render(<H3ToolResults messages={[message]} />);
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('running'));
  act(() => mocks.events.mock.calls[0][2].onerror());
  await waitFor(() => expect(view.container.querySelector('video')).not.toBeNull());
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('preserves cancellation acceptance when an older polling response arrives later', async () => {
  let resolve: (job: unknown) => void = () => {};
  mocks.get
    .mockResolvedValueOnce({ id, status: 'running', artifacts: [] })
    .mockReturnValueOnce(new Promise((done) => (resolve = done)));
  mocks.cancel.mockResolvedValue({ id, status: 'running', cancelRequested: true, artifacts: [] });
  const view = render(<H3ToolResults messages={[message]} />);
  await view.findByRole('button', { name: 'conversation.h3Activity.cancel' });
  act(() => mocks.events.mock.calls[0][2].onerror());
  expect(mocks.get).toHaveBeenCalledTimes(2);
  fireEvent.click(view.getByRole('button', { name: 'conversation.h3Activity.cancel' }));
  expect(await view.findByRole('button', { name: 'conversation.h3Activity.cancelling' })).toBeDisabled();
  await act(async () => resolve({ id, status: 'running', artifacts: [] }));
  expect(view.getByRole('button', { name: 'conversation.h3Activity.cancelling' })).toBeDisabled();
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
