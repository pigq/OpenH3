/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import { useAcpInitialMessage } from '@/renderer/pages/conversation/platforms/acp/useAcpInitialMessage';
import { resetGuidDraft, useGuidDraft } from '@/renderer/pages/guid/hooks/useGuidDraft';
import { useComfySelectionPending } from '@/renderer/pages/conversation/runtime/Creation/useComfySelectionPending';
import { templateSnapshotFixture } from '../../contentCatalog/galleryFixture';

const bindCreation = vi.fn();
const bindComfy = vi.fn();
const requestInstall = vi.fn();
vi.mock('@/common/chat/document/creation/comfyApi', () => ({
  comfyApi: {
    bind: (...args: unknown[]) => bindComfy(...args),
    requestInstall: (...args: unknown[]) => requestInstall(...args),
  },
}));
vi.mock('@/common/chat/document/h3JobApi', () => ({
  h3JobApi: { bindCreation: (...args: unknown[]) => bindCreation(...args) },
}));

const { sendMessageInvokeMock, emitterEmitMock, addOrUpdateMessageMock } = vi.hoisted(() => ({
  sendMessageInvokeMock: vi.fn(),
  emitterEmitMock: vi.fn(),
  addOrUpdateMessageMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      sendMessage: {
        invoke: sendMessageInvokeMock,
      },
    },
  },
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    emit: emitterEmitMock,
  },
}));

vi.mock('@/renderer/utils/file/messageFiles', () => ({
  buildDisplayMessage: (input: string) => input,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; reason?: string }) =>
      options?.reason ? `${_key}: ${options.reason}` : (options?.defaultValue ?? _key),
  }),
}));

describe('useAcpInitialMessage', () => {
  const mountInitial = () =>
    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'codex',
        setAiProcessing: vi.fn(),
        resetState: vi.fn(),
        checkAndUpdateTitle: vi.fn(),
        addOrUpdateMessage: addOrUpdateMessageMock,
      })
    );
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    bindCreation.mockResolvedValue({ ok: true });
    bindComfy.mockResolvedValue({ ok: true });
    requestInstall.mockReset().mockResolvedValue({ id: 'install-1', state: 'running' });
  });

  it('clears only the original Guid draft after the first message is accepted', async () => {
    const draft = renderHook(() => useGuidDraft());
    act(() => draft.result.current[1]('Original prompt'));
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({ input: 'Original prompt', guidDraft: 'Original prompt' })
    );
    let acknowledge!: (value: unknown) => void;
    sendMessageInvokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        })
    );
    mountInitial();
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledOnce());
    expect(draft.result.current[0]).toBe('Original prompt');
    await act(async () => acknowledge({ turn_id: 'turn-1', runtime: {} }));
    expect(draft.result.current[0]).toBe('');
  });

  it('does not clear a replacement same-text draft after its scope was reset during an in-flight send', async () => {
    const draft = renderHook(() => useGuidDraft());
    act(() => draft.result.current[1]('Same prompt'));
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({ input: 'Same prompt', guidDraft: 'Same prompt' })
    );
    let acknowledge!: (value: unknown) => void;
    sendMessageInvokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        })
    );
    const first = mountInitial();
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledOnce());
    first.unmount();
    act(() => resetGuidDraft());
    act(() => draft.result.current[1]('Same prompt'));
    await act(async () => acknowledge({ turn_id: 'turn-1', runtime: {} }));
    expect(draft.result.current[0]).toBe('Same prompt');
  });

  it('discards an initial message from an obsolete account scope before binding or sending', async () => {
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({
        input: 'Other account secret',
        guidDraft: 'Other account secret',
        guidDraftScope: 'expired-account-scope',
        creationRequestId: 'request-1',
      })
    );
    mountInitial();
    await act(async () => {});
    expect(bindCreation).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('binds the local tools for an empty creation entry without sending a blank message', async () => {
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: '', creationRequestId: 'request-1' }));
    mountInitial();
    await waitFor(() => expect(bindCreation).toHaveBeenCalledWith('request-1', 'conv-1'));
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('binds local image snapshot family and profile before the first ACP turn', async () => {
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({
        input: 'edit image',
        creationRequestId: 'request-qwen',
        creationRequest: {
          source: 'local',
          kind: 'image',
          profileId: 'qwen-fp8',
          family: 'qwen-edit',
          intent: 'generate',
          templateSnapshot: templateSnapshotFixture,
        },
      })
    );
    sendMessageInvokeMock.mockResolvedValueOnce({ turn_id: 'turn-1', runtime: {} });
    mountInitial();
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledOnce());
    expect(bindComfy).toHaveBeenCalledWith('request-qwen', 'conv-1', 'qwen-fp8', 'qwen-edit', 'generate', {
      source: 'local',
      kind: 'image',
      templateSnapshot: templateSnapshotFixture,
    });
    expect(bindCreation).not.toHaveBeenCalled();
    expect(bindComfy.mock.invocationCallOrder[0]).toBeLessThan(sendMessageInvokeMock.mock.invocationCallOrder[0]);
  });

  it('binds an explicit cloud source before the first ACP image turn', async () => {
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({
        input: 'generate image',
        creationRequestId: 'request-cloud',
        creationRequest: { source: 'cloud', kind: 'image', intent: 'generate' },
      })
    );
    sendMessageInvokeMock.mockResolvedValueOnce({ turn_id: 'turn-1', runtime: {} });
    mountInitial();
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledOnce());
    expect(bindComfy).toHaveBeenCalledWith('request-cloud', 'conv-1', undefined, undefined, 'generate', {
      source: 'cloud',
      kind: 'image',
    });
    expect(bindCreation).not.toHaveBeenCalled();
  });

  it('submits a model-card installation before the Agent turn and forwards its existing operation context', async () => {
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({
        input: 'Install Qwen-Edit with comfyui-local.',
        creationRequestId: 'request-qwen',
        creationRequest: { source: 'local', kind: 'image', family: 'qwen-edit', intent: 'install' },
      })
    );
    sendMessageInvokeMock.mockResolvedValueOnce({ turn_id: 'turn-1', runtime: {} });
    mountInitial();
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledOnce());
    expect(requestInstall).toHaveBeenCalledExactlyOnceWith('request-qwen', 'conv-1', {
      action: 'request',
      family: 'qwen-edit',
      intent: 'install',
      profileId: undefined,
      requestId: 'request-qwen',
    });
    expect(requestInstall.mock.invocationCallOrder[0]).toBeLessThan(sendMessageInvokeMock.mock.invocationCallOrder[0]);
    expect(sendMessageInvokeMock.mock.calls[0][0].input).toBe(
      'Install Qwen-Edit with comfyui-local.\n\nguid.comfy.operation.submittedContext'
    );
  });

  it('keeps the card request for recovery if deterministic submission fails without delegating installation to the Agent', async () => {
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({
        input: 'Install Qwen-Edit.',
        creationRequestId: 'request-qwen',
        creationRequest: { source: 'local', kind: 'image', family: 'qwen-edit', intent: 'install' },
      })
    );
    requestInstall.mockRejectedValueOnce(new Error('COMFY_DETECTION_INCOMPLETE'));
    mountInitial();
    await waitFor(() => expect(requestInstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(sessionStorage.getItem('acp_initial_message_conv-1')).not.toBeNull());
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('shows the exact installation preparation failure without a missing-tools diagnosis or automatic resubmission', async () => {
    const reason = 'COMFY_DEVICE_INSUFFICIENT: Qwen-Edit needs 16 GB VRAM; detected 8 GB';
    const stored = JSON.stringify({
      input: 'Install Qwen-Edit.',
      guidDraft: 'Install Qwen-Edit.',
      creationRequestId: 'request-qwen',
      creationRequest: { source: 'local', kind: 'image', family: 'qwen-edit', intent: 'install' },
    });
    sessionStorage.setItem('acp_initial_message_conv-1', stored);
    requestInstall.mockRejectedValueOnce(new Error(reason));
    const hook = mountInitial();
    await waitFor(() => expect(addOrUpdateMessageMock).toHaveBeenCalledOnce());
    const message = addOrUpdateMessageMock.mock.calls[0][0];
    expect(message.content.content).toBe(`guid.comfy.operation.preparationFailed: ${reason}`);
    expect(message.content.content).not.toContain('guid.creation.toolsUnavailable');
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBe(stored);
    hook.rerender();
    await act(async () => {});
    expect(requestInstall).toHaveBeenCalledOnce();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('retains the prompt after failed binding and retries binding before sending on remount', async () => {
    const draft = renderHook(() => useGuidDraft());
    act(() => draft.result.current[1]('Original prompt'));
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({ input: 'Original prompt', guidDraft: 'Original prompt', creationRequestId: 'request-1' })
    );
    bindCreation.mockRejectedValueOnce(new Error('offline'));
    const first = mountInitial();
    await waitFor(() => expect(bindCreation).toHaveBeenCalledOnce());
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(draft.result.current[0]).toBe('Original prompt');
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).not.toBeNull();
    first.unmount();
    sendMessageInvokeMock.mockResolvedValueOnce({ turn_id: 'turn-1', runtime: {} });
    mountInitial();
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledOnce());
    expect(bindCreation).toHaveBeenCalledTimes(2);
    expect(draft.result.current[0]).toBe('');
  });

  it('keeps direct sends gated until the initial creation binding is accepted', async () => {
    const gate = renderHook(() => useComfySelectionPending('conv-1'));
    let finish!: (value: { ok: boolean }) => void;
    bindComfy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({ input: '', creationRequestId: 'request-1', creationRequest: { source: 'local', kind: 'image' } })
    );
    mountInitial();
    await waitFor(() => expect(bindComfy).toHaveBeenCalledOnce());
    expect(gate.result.current).toBe(true);
    await act(async () => finish({ ok: true }));
    expect(gate.result.current).toBe(false);
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('keeps the draft when first-message send fails after conversation creation', async () => {
    const draft = renderHook(() => useGuidDraft());
    act(() => draft.result.current[1]('Unsent prompt'));
    sessionStorage.setItem(
      'acp_initial_message_conv-1',
      JSON.stringify({ input: 'Unsent prompt', guidDraft: 'Unsent prompt' })
    );
    sendMessageInvokeMock.mockRejectedValueOnce(new Error('runtime unavailable'));
    mountInitial();
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledOnce());
    expect(draft.result.current[0]).toBe('Unsent prompt');
  });

  it('suppresses tips and reset when initial ACP send hits active-turn busy', async () => {
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: 'hello', files: [] }));
    sendMessageInvokeMock.mockRejectedValue(
      new BackendHttpError({
        method: 'POST',
        path: '/api/conversations/conv-1/messages',
        status: 409,
        body: { success: false, code: 'CONFLICT', error: 'conversation conv-1 is already running' },
      })
    );

    const markSendFailed = vi.fn();
    const addOrUpdateMessage = vi.fn();
    const resetState = vi.fn();
    const setAiProcessing = vi.fn();

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'codex',
        workspacePath: '/tmp/workspace',
        setAiProcessing,
        resetState,
        markSendStarted: vi.fn(),
        markSendAccepted: vi.fn(),
        markSendFailed,
        checkAndUpdateTitle: vi.fn(),
        addOrUpdateMessage,
      })
    );

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(markSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'busy_conflict', busyKind: 'active_turn' })
    );
    expect(addOrUpdateMessage).not.toHaveBeenCalled();
    expect(resetState).not.toHaveBeenCalled();
    expect(setAiProcessing).not.toHaveBeenCalledWith(false);
  });

  it('keeps ordinary initial ACP send failures visible and resets loading state', async () => {
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: 'hello', files: [] }));
    sendMessageInvokeMock.mockRejectedValue(new Error('boom'));

    const markSendFailed = vi.fn();
    const addOrUpdateMessage = vi.fn();
    const resetState = vi.fn();
    const setAiProcessing = vi.fn();

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'codex',
        workspacePath: '/tmp/workspace',
        setAiProcessing,
        resetState,
        markSendStarted: vi.fn(),
        markSendAccepted: vi.fn(),
        markSendFailed,
        checkAndUpdateTitle: vi.fn(),
        addOrUpdateMessage,
      })
    );

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(markSendFailed).toHaveBeenCalledWith({ kind: 'ordinary', reason: 'boom' });
    expect(addOrUpdateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tips',
        content: expect.objectContaining({ type: 'error' }),
      }),
      true
    );
    expect(resetState).toHaveBeenCalledTimes(1);
    expect(setAiProcessing).toHaveBeenCalledWith(false);
  });
});
