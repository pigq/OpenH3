import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useModelCenterEntry } from '@/renderer/pages/guid/Creation/useModelCenterEntry';
import type { ComfyDraftIntent } from '@/renderer/pages/guid/Creation/comfyDraft';
import { useModelCenterProfile, type ModelCenterEntry } from '@/renderer/pages/guid/Creation/modelCenterEntry';
import type { LocalModelRecommendation } from '@/common/chat/document/creation/workflows/localModels';

describe('model center handoff', () => {
  it('selects a registered model needing repair without altering its validation or starting installation', () => {
    const model = {
      status: 'unknown',
      profiles: [{ id: 'h3', kind: 'video', state: 'invalid' }],
    } as LocalModelRecommendation;
    const navigate = vi.fn();
    useModelCenterProfile(model, navigate);
    expect(navigate).toHaveBeenCalledWith('/ai-creation', {
      state: {
        modelCenterEntry: {
          token: expect.any(String),
          action: 'use',
          profileId: 'h3',
          kind: 'video',
        },
      },
    });
    expect(model.profiles[0].state).toBe('invalid');
    expect(model.status).toBe('unknown');
  });
  it('waits for a prepared real message and sends exactly once when ready', async () => {
    const entry: ModelCenterEntry = {
      token: 'click',
      action: 'install',
      intent: {
        family: 'moss-image-sft',
        intent: 'install',
        requestId: 'request',
        installContext: { checkedAt: 'now', installDirectory: 'E:/Models' },
      },
    };
    const send = vi.fn(),
      consume = vi.fn();
    const { rerender } = renderHook(
      ({ ready }) => {
        const [intent, setIntent] = useState<ComfyDraftIntent>();
        const [input, setInput] = useState('unrelated draft');
        useModelCenterEntry({
          entry,
          ready,
          intent,
          input,
          prompt: 'Install selected model',
          setIntent,
          setInput,
          resetAttachments: () => {},
          selectProfile: () => {},
          consume,
          send,
        });
        return { intent, input };
      },
      { initialProps: { ready: false } }
    );
    expect(send).not.toHaveBeenCalled();
    rerender({ ready: true });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    rerender({ ready: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it('selects a usable model without sending a generation request', () => {
    const send = vi.fn(),
      selectProfile = vi.fn(),
      consume = vi.fn();
    renderHook(() =>
      useModelCenterEntry({
        entry: { token: 'use', action: 'use', kind: 'video', profileId: 'h3' },
        ready: true,
        input: '',
        prompt: '',
        setInput: vi.fn(),
        setIntent: vi.fn(),
        resetAttachments: vi.fn(),
        selectProfile,
        consume,
        send,
      })
    );
    expect(selectProfile).toHaveBeenCalledWith('h3', 'video');
    expect(send).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
  });
});
