import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ComfyOperationResult, {
  comfyTurnResults,
} from '@/renderer/pages/conversation/runtime/Creation/ComfyOperationResult';

const mocks = vi.hoisted(() => ({
  operation: {
    id: '12345678-1234-1234-1234-123456789abc',
    conversationId: 'conv-1',
    requestId: 'request-1',
    state: 'awaiting-consent',
    profileId: 'qwen-fp8',
    plan: {
      family: 'qwen-edit',
      name: 'Qwen-Edit',
      version: '2509',
      quantization: 'FP8',
      targetRoot: 'D:\\models',
      downloadBytes: 1024 ** 3,
      requiredBytes: 4 * 1024 ** 3,
      reason: 'Suitable for this GPU',
      evidence: ['Official pinned workflow'],
      components: [
        {
          name: 'Diffusion',
          url: 'https://example.com/model',
          path: 'D:/ComfyUI/models/qwen.safetensors',
          sha256: 'b'.repeat(64),
          sizeBytes: 2 * 1024 ** 3,
        },
      ],
      nodes: [{ id: 'Loader', version: 'abc123' }],
      capabilities: ['image-edit'],
      diagnosticLogPath: undefined,
      environment: {
        root: 'D:/ComfyUI',
        python: 'D:/venv/python.exe',
        baseUrl: 'http://127.0.0.1:8188',
        launchArgs: ['--lowvram', '--port', '8188'],
      },
      workflowPath: 'D:/workflows/qwen.api.json',
      workflowSha256: 'a'.repeat(64),
      commands: [
        {
          executable: 'git',
          args: ['checkout', 'abc123'],
          cwd: 'D:/ComfyUI',
          stage: 'prepare',
          label: 'Pin ComfyUI',
          revision: 'abc123',
        },
      ],
    },
  },
  authorize: vi.fn(),
  cancel: vi.fn(),
  mutate: vi.fn(),
  globalMutate: vi.fn(),
  send: vi.fn(),
  isProcessing: false,
  started: vi.fn(),
  accepted: vi.fn(),
  failed: vi.fn(),
  profiles: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  bind: vi.fn(),
  prefill: vi.fn(),
  swr: vi.fn(),
  operationFetch: vi.fn(),
  cachedProfiles: [{ id: 'qwen-fp8', state: 'verified' }],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('swr', () => ({
  default: mocks.swr,
  mutate: mocks.globalMutate,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { sendMessage: { invoke: mocks.send }, get: { invoke: mocks.get }, update: { invoke: mocks.update } },
  },
}));
vi.mock('@/renderer/hooks/chat/useSendBoxDraft', () => ({ requestConversationSendBoxPrefill: mocks.prefill }));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({
  comfyApi: {
    operation: mocks.operationFetch,
    authorize: mocks.authorize,
    cancel: mocks.cancel,
    profiles: mocks.profiles,
    bind: mocks.bind,
  },
}));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({
    isProcessing: mocks.isProcessing,
    markSendStarted: mocks.started,
    markSendAccepted: mocks.accepted,
    markSendFailed: mocks.failed,
  }),
}));

describe('ComfyUI installation approval card', () => {
  beforeEach(() => {
    mocks.operation.state = 'awaiting-consent';
    mocks.operation.conversationId = 'conv-1';
    mocks.isProcessing = false;
    [
      mocks.authorize,
      mocks.cancel,
      mocks.mutate,
      mocks.globalMutate,
      mocks.send,
      mocks.started,
      mocks.accepted,
      mocks.failed,
      mocks.profiles,
      mocks.get,
      mocks.update,
      mocks.bind,
      mocks.prefill,
    ].forEach((fn) => fn.mockReset());
    mocks.authorize.mockResolvedValue({ ...mocks.operation, state: 'authorized' });
    mocks.send.mockResolvedValue({ turn_id: 'turn-2', runtime: {}, msg_id: 'msg-2' });
    mocks.profiles.mockResolvedValue([
      { id: 'qwen-fp8', name: 'Qwen-Edit', family: 'qwen-edit', kind: 'image', state: 'verified' },
    ]);
    mocks.get.mockResolvedValue({
      id: 'conv-1',
      extra: { creation_request: { requestId: 'request-1', family: 'qwen-edit', kind: 'image', intent: 'install' } },
    });
    mocks.update.mockResolvedValue(true);
    mocks.bind.mockResolvedValue({ ok: true });
    mocks.operationFetch.mockReset().mockResolvedValue(mocks.operation);
    mocks.cachedProfiles = [{ id: 'qwen-fp8', state: 'verified' }];
    mocks.swr.mockReset().mockImplementation((key, fetcher) => {
      if (!key) return { data: undefined };
      if (key === 'creation.comfy-profiles') return { data: mocks.cachedProfiles };
      void fetcher();
      return { data: mocks.operation, mutate: mocks.mutate };
    });
  });

  it('starts the reviewed plan through the UI authorization request without another LLM turn', async () => {
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    expect(screen.getByText('Qwen-Edit')).toBeInTheDocument();
    expect(screen.getByText('D:\\models')).toBeInTheDocument();
    expect(screen.getByText('1.00 GiB')).toBeInTheDocument();
    expect(screen.getByText('4.00 GiB')).toBeInTheDocument();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.swr.mock.calls[0][0]).toEqual(['comfy.operation', 'conv-1', mocks.operation.id]);
    expect(mocks.operationFetch).toHaveBeenCalledWith(mocks.operation.id, 'conv-1');
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.operation.authorize' }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(mocks.authorize).toHaveBeenCalledWith(mocks.operation.id, 'conv-1');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.started).not.toHaveBeenCalled();
  });

  it('resumes a previously authorized operation through the same UI action without model involvement', async () => {
    mocks.operation.state = 'authorized';
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.operation.continue' }));
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith(mocks.operation.id, 'conv-1'));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('shows the diagnostic log path without reading or exposing raw log contents', () => {
    mocks.operation.diagnosticLogPath = 'D:/ComfyUI/logs/operation-1.jsonl';
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByText('guid.comfy.diagnosticLog'));
    expect(screen.getByText('D:/ComfyUI/logs/operation-1.jsonl')).toBeInTheDocument();
    expect(screen.queryByText(/raw log|stack trace/i)).not.toBeInTheDocument();
  });

  it('shows the interpreter, runtime, workflow, component integrity, and command execution locations for approval', () => {
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByText('guid.comfy.operation.details'));
    expect(screen.getAllByText('D:/ComfyUI').length).toBeGreaterThan(0);
    expect(screen.getByText('D:/venv/python.exe')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:8188')).toBeInTheDocument();
    expect(screen.getByText('["--lowvram","--port","8188"]')).toBeInTheDocument();
    expect(screen.getByText('D:/workflows/qwen.api.json')).toBeInTheDocument();
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('D:/ComfyUI/models/qwen.safetensors')).toBeInTheDocument();
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('2.00 GiB')).toBeInTheDocument();
    expect(screen.getByText('prepare')).toBeInTheDocument();
  });

  it('scopes cancellation to the rendered conversation', async () => {
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.operation.cancel' }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(mocks.operation.id, 'conv-1'));
  });

  it('does not render or authorize operations from a different conversation', () => {
    mocks.operation.conversationId = 'other';
    const { container } = render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('keeps a denied authorization from sending a resume turn', async () => {
    mocks.authorize.mockRejectedValue(new Error('Plan has changed'));
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.operation.authorize' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Plan has changed'));
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.started).not.toHaveBeenCalled();
  });

  it('waits for the current assistant turn before allowing authorization', () => {
    mocks.isProcessing = true;
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    expect(screen.getByRole('button', { name: 'guid.comfy.operation.authorize' })).toBeDisabled();
  });

  it('refreshes profile inventory when verification completes', async () => {
    mocks.operation.state = 'completed';
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    await waitFor(() => expect(mocks.globalMutate).toHaveBeenCalledWith('creation.comfy-profiles'));
    expect(screen.queryByRole('button', { name: 'guid.comfy.operation.authorize' })).not.toBeInTheDocument();
  });

  it('lets a completed installation explicitly select its verified profile for generation', async () => {
    mocks.operation.state = 'completed';
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.use' }));
    await waitFor(() =>
      expect(mocks.bind).toHaveBeenCalledWith('request-1', 'conv-1', 'qwen-fp8', 'qwen-edit', 'generate', {
        source: 'local',
        kind: 'image',
      })
    );
    expect(mocks.update.mock.calls[0][0].updates.extra.creation_request).toMatchObject({
      requestId: 'request-1',
      state: 'verified',
      profileId: 'qwen-fp8',
      intent: 'generate',
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not label a historical completed installation as usable when its current profile is invalid', () => {
    mocks.operation.state = 'completed';
    mocks.cachedProfiles = [{ id: 'qwen-fp8', state: 'invalid' }];
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    expect(screen.getByRole('status')).toHaveTextContent('guid.creation.states.invalid');
    expect(screen.queryByText('guid.comfy.operation.completedHint')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'guid.comfy.use' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'guid.comfy.actions.repair' })).not.toBeDisabled();
  });

  it('fills completed-profile repair requests as editable drafts with explicit intent and no assistant turn', async () => {
    mocks.operation.state = 'completed';
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.actions.repair' }));
    await waitFor(() =>
      expect(mocks.prefill).toHaveBeenCalledWith('conv-1', expect.stringContaining('guid.comfy.prompts.repair'))
    );
    expect(mocks.bind).toHaveBeenCalledWith('request-1', 'conv-1', 'qwen-fp8', 'qwen-edit', 'repair', {
      source: 'local',
      kind: 'image',
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('drafts another version without carrying the installed profile into the new target', async () => {
    mocks.operation.state = 'completed';
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.actions.install-other' }));
    await waitFor(() =>
      expect(mocks.prefill).toHaveBeenCalledWith('conv-1', expect.stringContaining('guid.comfy.prompts.install-other'))
    );
    expect(mocks.bind).toHaveBeenCalledWith('request-1', 'conv-1', undefined, 'qwen-edit', 'install-other', {
      source: 'local',
      kind: 'image',
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('keeps a completed profile unavailable for use if its latest verification is invalid', async () => {
    mocks.operation.state = 'completed';
    mocks.profiles.mockResolvedValue([{ id: 'qwen-fp8', state: 'invalid' }]);
    render(<ComfyOperationResult id={mocks.operation.id} conversationId='conv-1' />);
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.use' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('guid.comfy.operation.unavailable'));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('anchors duplicate ComfyUI operation outputs once after their assistant turn', () => {
    const message = {
      type: 'acp_tool_call',
      content: { output: JSON.stringify({ comfyOperationId: mocks.operation.id }) },
    };
    const groups = comfyTurnResults([
      { id: 'tool', type: 'acp_tool_call', position: 'left', messages: [message] },
      { id: 'reply', type: 'text', position: 'left', messages: [message] },
      { id: 'user', type: 'text', position: 'right' },
    ]);
    expect([...groups.entries()]).toEqual([['reply', [mocks.operation.id]]]);
  });
});
