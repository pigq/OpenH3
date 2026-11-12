import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import { getComfyModelSetId } from '@/common/chat/document/creation/workflows/identity';
import type { TChatConversation } from '@/common/config/storage';
import ComfySessionProfile from '@/renderer/pages/conversation/runtime/Creation/ComfySessionProfile';

const mocks = vi.hoisted(() => ({
  profiles: [
    { id: 'h3-fp8', family: 'h3', name: 'H3', kind: 'video', state: 'verified', version: 'v1', quantization: 'FP8' },
    {
      id: 'qwen-bf16',
      family: 'qwen-edit',
      name: 'Qwen-Edit',
      kind: 'image',
      state: 'verified',
      version: '2509',
      quantization: 'BF16',
    },
    {
      id: 'qwen-fp8',
      family: 'qwen-edit',
      name: 'Qwen-Edit FP8',
      kind: 'image',
      state: 'downloaded',
      version: '2509',
      quantization: 'FP8',
    },
  ] as ComfyProfile[],
  update: vi.fn(),
  bind: vi.fn(),
  refresh: vi.fn(),
  restart: vi.fn(),
  catalog: vi.fn(),
  processing: false,
  started: vi.fn(),
  succeeded: vi.fn(),
  failed: vi.fn(),
  selection: undefined as Record<string, unknown> | undefined,
  get: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('swr', () => ({
  default: (key: unknown) => ({ data: Array.isArray(key) ? mocks.selection : mocks.profiles }),
  mutate: mocks.refresh,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      get: { invoke: mocks.get },
      update: { invoke: mocks.update },
      restartRuntime: { invoke: mocks.restart },
    },
  },
}));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({ comfyApi: { profiles: vi.fn(), bind: mocks.bind } }));
vi.mock('@/renderer/hooks/mcp/catalog', () => ({
  ensureBackendMcpCatalog: mocks.catalog,
  toSessionMcpServer: (server: unknown) => server,
}));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({
    isProcessing: mocks.processing,
    markRestartStarted: mocks.started,
    markRestartSucceeded: mocks.succeeded,
    markRestartFailed: mocks.failed,
  }),
}));
vi.mock('@arco-design/web-react', () => ({
  Button: ({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Select: ({
    options,
    onChange,
    disabled,
    value,
  }: {
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    onChange: (id: string) => void;
    disabled?: boolean;
    value?: string;
  }) => (
    <div data-selected={value}>
      {options.map((option) => (
        <button key={option.value} disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

const snapshot = {
  requestId: 'original-request',
  id: 'h3-fp8',
  name: 'H3',
  kind: 'video',
  source: 'local',
  state: 'verified',
  family: 'h3',
  profileId: 'h3-fp8',
  intent: 'generate',
};
const conversation = (request: Record<string, unknown> = snapshot) =>
  ({
    id: 'conv-1',
    type: 'acp',
    extra: {
      workspace: 'D:\\project',
      creation_request: request,
      session_mcp_servers: [
        {
          id: 'media',
          name: 'aionui-video-media',
          transport: { type: 'stdio', command: 'node', env: { OTHER: 'kept' } },
        },
      ],
    },
  }) as unknown as TChatConversation;

describe('conversation local profile selection', () => {
  it('groups routes under one model and switches between automatic and fixed workflow selection', async () => {
    const originalProfiles = mocks.profiles;
    const base = {
      ...originalProfiles[0],
      components: [
        {
          role: 'diffusion',
          name: 'h3',
          path: 'C:/models/h3',
          version: 'v1',
          precision: 'FP8',
          sha256: 'a'.repeat(64),
        },
      ],
    };
    const edit = {
      ...base,
      id: 'h3-edit',
      state: 'invalid' as const,
      name: 'H3 edit route',
      workflowPath: 'C:/workflows/edit.json',
    };
    mocks.profiles = [base, edit];
    try {
      render(<ComfySessionProfile conversation={conversation()} />);
      expect(screen.getAllByRole('button', { name: /H3 ·/ })).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.workflows.advanced' }));
      expect(screen.getByRole('button', { name: 'guid.comfy.workflows.auto' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: /guid.comfy.workflows.fixed · h3-edit/ }));
      await waitFor(() =>
        expect(mocks.bind).toHaveBeenCalledWith(
          'original-request',
          'conv-1',
          'h3-edit',
          'h3',
          'generate',
          expect.objectContaining({
            modelSetId: getComfyModelSetId(base),
            workflowMode: 'fixed',
            fixedWorkflowId: 'h3-edit',
            selectionRevision: 1,
          })
        )
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'guid.comfy.workflows.auto' })).toBeEnabled());
      expect(mocks.update.mock.calls[0][0].updates.extra.creation_request.name).toBe('H3');
      fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.workflows.auto' }));
      await waitFor(() =>
        expect(mocks.bind).toHaveBeenLastCalledWith(
          'original-request',
          'conv-1',
          'h3-edit',
          'h3',
          'generate',
          expect.objectContaining({
            workflowMode: 'auto',
            fixedWorkflowId: undefined,
            selectionRevision: 2,
          })
        )
      );
    } finally {
      mocks.profiles = originalProfiles;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processing = false;
    mocks.refresh.mockResolvedValue(undefined);
    mocks.selection = undefined;
    mocks.get.mockResolvedValue(conversation());
    mocks.update.mockResolvedValue(true);
    mocks.bind.mockResolvedValue({ ok: true });
    mocks.restart.mockResolvedValue({ runtime: {} });
  });

  it('shows and persists an Agent-adopted workflow without rebinding the old profile', async () => {
    mocks.selection = {
      ...snapshot,
      conversationId: 'conv-1',
      profileId: 'qwen-bf16',
      family: 'qwen-edit',
      kind: 'image',
    };
    render(<ComfySessionProfile conversation={conversation()} />);
    await waitFor(() =>
      expect(document.querySelector('[data-selected]')).toHaveAttribute('data-selected', 'qwen-bf16')
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: {
          extra: { creation_request: expect.objectContaining({ profileId: 'qwen-bf16', name: 'Qwen-Edit' }) },
        },
        merge_extra: true,
      })
    );
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('does not persist a polled selection over a newer conversation request', async () => {
    mocks.selection = {
      ...snapshot,
      conversationId: 'conv-1',
      profileId: 'qwen-bf16',
      family: 'qwen-edit',
      kind: 'image',
    };
    mocks.get.mockResolvedValue(conversation({ ...snapshot, requestId: 'new-request' }));
    render(<ComfySessionProfile conversation={conversation()} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('binds an explicitly chosen verified profile with the original request ID and saves the turn context', async () => {
    render(<ComfySessionProfile conversation={conversation()} />);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Qwen-Edit ·/ }));
    await waitFor(() =>
      expect(mocks.bind).toHaveBeenCalledWith(
        'original-request',
        'conv-1',
        'qwen-bf16',
        'qwen-edit',
        'generate',
        expect.objectContaining({
          source: 'local',
          kind: 'image',
          workflowMode: 'auto',
          selectionRevision: 1,
        })
      )
    );
    expect(mocks.update).toHaveBeenCalledWith({
      id: 'conv-1',
      updates: {
        extra: {
          creation_request: {
            ...snapshot,
            id: 'qwen-bf16',
            name: 'Qwen-Edit',
            kind: 'image',
            family: 'qwen-edit',
            profileId: 'qwen-bf16',
            modelSetId: 'profile:qwen-bf16',
            workflowMode: 'auto',
            fixedWorkflowId: undefined,
            modelConstraint: {
              modelSetId: 'profile:qwen-bf16',
              selectionRevision: 1,
              workflowMode: 'auto',
              fixedWorkflowId: undefined,
            },
          },
        },
      },
      merge_extra: true,
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledWith('conversation/conv-1');
  });

  it('prevents unavailable profiles or an active assistant turn from changing selection', () => {
    mocks.processing = true;
    render(<ComfySessionProfile conversation={conversation()} />);
    expect(screen.getByRole('button', { name: /Qwen-Edit ·/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Qwen-Edit FP8/ })).toBeDisabled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('lets a downloaded profile validate through generation without starting repair', async () => {
    render(<ComfySessionProfile conversation={conversation()} />);
    const option = screen.getByRole('button', { name: /Qwen-Edit FP8/ });
    expect(option).toBeEnabled();
    fireEvent.click(option);
    await waitFor(() =>
      expect(mocks.bind).toHaveBeenCalledWith(
        'original-request',
        'conv-1',
        'qwen-fp8',
        'qwen-edit',
        'generate',
        expect.objectContaining({
          source: 'local',
          kind: 'image',
          workflowMode: 'auto',
          selectionRevision: 1,
        })
      )
    );
    expect(mocks.update.mock.calls[0][0].updates.extra.creation_request).toMatchObject({
      profileId: 'qwen-fp8',
      state: 'downloaded',
      intent: 'generate',
    });
  });

  it('explicitly activates a repaired profile even when it is already selected', async () => {
    render(<ComfySessionProfile conversation={conversation({ ...snapshot, intent: 'repair' })} />);
    expect(screen.queryByText('guid.comfy.session.hint')).toBeNull();
    expect(screen.queryByRole('button', { name: /Qwen-Edit ·/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.use' }));
    await waitFor(() =>
      expect(mocks.bind).toHaveBeenCalledWith(
        'original-request',
        'conv-1',
        'h3-fp8',
        'h3',
        'generate',
        expect.objectContaining({
          source: 'local',
          kind: 'video',
          workflowMode: 'auto',
          selectionRevision: 1,
        })
      )
    );
    expect(mocks.update.mock.calls[0][0].updates.extra.creation_request.intent).toBe('generate');
  });

  it('rolls back the persisted selection when binding fails and keeps the old profile visible', async () => {
    mocks.bind.mockRejectedValueOnce(new Error('service offline'));
    render(<ComfySessionProfile conversation={conversation()} />);
    fireEvent.click(screen.getByRole('button', { name: /Qwen-Edit ·/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('service offline'));
    expect(mocks.update.mock.calls[1][0]).toMatchObject({
      updates: { extra: { creation_request: snapshot } },
      merge_extra: true,
    });
    expect(document.querySelector('[data-selected]')).toHaveAttribute('data-selected', 'h3-fp8');
  });

  it('preserves the selected binding when only the conversation cache refresh fails', async () => {
    mocks.refresh.mockRejectedValueOnce(new Error('cache refresh offline'));
    render(<ComfySessionProfile conversation={conversation()} />);
    fireEvent.click(screen.getByRole('button', { name: /Qwen-Edit ·/ }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith('conversation/conv-1'));
    expect(mocks.bind).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-selected]')).toHaveAttribute('data-selected', 'qwen-bf16');
  });

  it('reports a rejected rollback and does not rebind an old snapshot that was not restored', async () => {
    mocks.update.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.bind.mockRejectedValueOnce(new Error('service offline'));
    render(<ComfySessionProfile conversation={conversation()} />);
    fireEvent.click(screen.getByRole('button', { name: /Qwen-Edit ·/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('guid.comfy.session.saveFailed'));
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });

  it('adds a request binding and restarts legacy sessions so their MCP transport receives the new ID', async () => {
    render(<ComfySessionProfile conversation={conversation({ ...snapshot, requestId: undefined })} />);
    fireEvent.click(screen.getByRole('button', { name: /Qwen-Edit ·/ }));
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledWith({ conversation_id: 'conv-1' }));
    const request = mocks.update.mock.calls[0][0].updates.extra.creation_request;
    expect(request.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(mocks.update.mock.calls[0][0].updates.extra.session_mcp_servers[0].transport.env).toMatchObject({
      OTHER: 'kept',
      AIONUI_CREATION_REQUEST_ID: request.requestId,
      AIONUI_CREATION_FAMILY: 'qwen-edit',
      AIONUI_CREATION_PROFILE: 'qwen-bf16',
      AIONUI_CREATION_KIND: 'image',
    });
    expect(mocks.bind).toHaveBeenCalledWith(
      request.requestId,
      'conv-1',
      'qwen-bf16',
      'qwen-edit',
      'generate',
      expect.objectContaining({
        source: 'local',
        kind: 'image',
        workflowMode: 'auto',
        selectionRevision: 1,
      })
    );
    expect(mocks.started).toHaveBeenCalledOnce();
    expect(mocks.succeeded).toHaveBeenCalledWith({});
  });

  it('does not introduce a local selection into a cloud conversation', () => {
    const { container } = render(<ComfySessionProfile conversation={conversation({ ...snapshot, source: 'cloud' })} />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.bind).not.toHaveBeenCalled();
  });
});
