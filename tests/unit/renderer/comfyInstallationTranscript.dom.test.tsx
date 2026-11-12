import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ComfyInstallationTranscript } from '@/renderer/pages/conversation/runtime/Creation/ComfyInstallationTranscript';
import useSWR, { SWRConfig } from 'swr';

const mocks = vi.hoisted(() => ({
  activity: { operations: [] as Array<Record<string, unknown>>, preparations: [] as Array<Record<string, unknown>> },
  prepare: vi.fn(),
  mutate: vi.fn(),
  live: false,
  activityFetch: vi.fn(),
  send: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, args?: { reason?: string }) => args?.reason ?? key }),
}));
vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr');
  return {
    ...actual,
    default: (...args: Parameters<typeof actual.default>) =>
      mocks.live
        ? actual.default(...args)
        : Array.isArray(args[0]) && args[0][0] === 'comfy.installation-transcript'
          ? { data: mocks.activity, isLoading: true }
          : {},
    mutate: mocks.mutate,
  };
});
vi.mock('@/common', () => ({ ipcBridge: { conversation: { sendMessage: { invoke: mocks.send } } } }));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({
    isProcessing: false,
    markSendStarted: vi.fn(),
    markSendAccepted: vi.fn(),
    markSendFailed: vi.fn(),
  }),
}));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({ comfyApi: { activity: mocks.activityFetch } }));
vi.mock('@/renderer/pages/conversation/runtime/Creation/prepareCreationEntry', () => ({
  prepareCreationEntry: mocks.prepare,
}));
vi.mock('@/renderer/pages/conversation/runtime/Creation/ComfyOperationResult', () => ({
  default: ({ id }: { id: string }) => <div>{id}</div>,
}));
const snapshot = {
  id: 'qwen-edit',
  name: 'Qwen-Edit',
  family: 'qwen-edit' as const,
  kind: 'image' as const,
  source: 'local' as const,
  intent: 'install' as const,
  state: 'not-installed' as const,
  requestId: 'request-1',
  installationInput: 'Install Qwen-Edit',
};
beforeEach(() => {
  mocks.live = false;
  mocks.activity = { operations: [], preparations: [] };
  mocks.prepare.mockReset().mockResolvedValue(undefined);
  mocks.mutate.mockResolvedValue(undefined);
  mocks.send.mockReset().mockResolvedValue({ turn_id: 'turn-1' });
});
it('keeps the raw transcript activity separate from the work-progress cache shape', async () => {
  mocks.live = true;
  mocks.activityFetch.mockResolvedValue({
    operations: [],
    preparations: [{ requestId: 'request-1', conversationId: 'conv-1', status: 'detecting' }],
    jobs: [],
  });
  function ProgressConsumer() {
    const { data } = useSWR(['comfy.activity', 'conv-1'], async () => ({
      operations: [],
      preparations: [],
      jobs: [],
      unavailable: [],
    }));
    return <div data-testid='progress-reader'>{data ? data.unavailable.length : 'loading'}</div>;
  }
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ComfyInstallationTranscript conversationId='conv-1' snapshot={snapshot} showRequest />
      <ProgressConsumer />
    </SWRConfig>
  );
  await waitFor(() => expect(screen.getByTestId('progress-reader').textContent).toBe('0'));
  expect(screen.getByText('Install Qwen-Edit')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('conversation.workProgress.detecting');
});
it('shows the submitted request waiting for Agent rather than claiming detection already started', () => {
  render(<ComfyInstallationTranscript conversationId='conv-1' snapshot={snapshot} showRequest />);
  expect(screen.getByText('Install Qwen-Edit')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('guid.comfy.operation.agentPreparing');
});
it('recovers a persisted error and retries only the same installation on explicit click', async () => {
  render(
    <ComfyInstallationTranscript
      conversationId='conv-1'
      snapshot={{ ...snapshot, installationError: 'metadata unavailable' }}
      showRequest
    />
  );
  expect(screen.getByRole('alert').textContent).toContain('metadata unavailable');
  expect(mocks.prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  expect(mocks.prepare.mock.calls[0].slice(0, 2)).toEqual(['request-1', 'conv-1']);
  expect(mocks.send).toHaveBeenCalledOnce();
});
it('shows the operation consent in the transcript without depending on an LLM tool result', () => {
  mocks.activity.operations = [{ id: 'operation-1', requestId: 'request-1', conversationId: 'conv-1' }];
  render(<ComfyInstallationTranscript conversationId='conv-1' snapshot={snapshot} showRequest={false} />);
  expect(screen.getByText('operation-1')).toBeTruthy();
  expect(screen.queryByText('Install Qwen-Edit')).toBeNull();
});

it('does not show a waiting-for-installer banner for an ordinary Agent conversation', () => {
  render(<ComfyInstallationTranscript conversationId='conv-1' snapshot={snapshot} showRequest={false} />);
  expect(screen.queryByTestId('comfy-installation-transcript')).toBeNull();
});
