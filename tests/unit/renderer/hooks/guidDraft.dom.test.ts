import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  clearGuidDraftIfMatches,
  useGuidDraft,
  setGuidTemplateSnapshot,
  getGuidTemplateSnapshot,
} from '@/renderer/pages/guid/hooks/useGuidDraft';

describe('useGuidDraft', () => {
  it('restores plain-text legacy drafts and reloads the persisted template copy', async () => {
    localStorage.setItem('openh3.guid-draft.v1', JSON.stringify('Legacy draft'));
    vi.resetModules();
    const fresh = await import('@/renderer/pages/guid/hooks/useGuidDraft');
    const hook = renderHook(() => fresh.useGuidDraft());
    expect(hook.result.current[0]).toBe('Legacy draft');
    act(() =>
      fresh.setGuidTemplateSnapshot({
        templateId: 'official:test',
        templateRevision: 1,
        releaseSequence: 1,
        locale: 'en-US',
        title: 'Title',
        prompt: 'Original',
        parameters: {},
        requiresReference: false,
      })
    );
    hook.unmount();
    vi.resetModules();
    const again = await import('@/renderer/pages/guid/hooks/useGuidDraft');
    expect(again.getGuidTemplateSnapshot()?.prompt).toBe('Original');
    again.resetGuidDraft();
  });
  it('persists an independent template revision with the editable draft and removes it on reset', () => {
    const hook = renderHook(() => useGuidDraft());
    act(() => hook.result.current[1]('Editable prompt'));
    const snapshot = {
      templateId: 'official:test',
      templateRevision: 1,
      releaseSequence: 2,
      locale: 'en-US',
      title: 'Title',
      prompt: 'Original',
      parameters: { width: 768 },
      requiresReference: false,
    };
    act(() => setGuidTemplateSnapshot(snapshot));
    snapshot.parameters.width = 1;
    expect(getGuidTemplateSnapshot()?.parameters.width).toBe(768);
    act(() => hook.result.current[1]('Edited prompt'));
    expect(JSON.parse(localStorage.getItem('openh3.guid-draft.v1')!).templateSnapshot.prompt).toBe('Original');
    act(() => clearGuidDraftIfMatches('Edited prompt'));
    expect(getGuidTemplateSnapshot()).toBeUndefined();
    hook.unmount();
  });
  it('clears the sent draft after navigation has unmounted its composer', () => {
    const first = renderHook(() => useGuidDraft());
    act(() => first.result.current[1]('Sent prompt'));
    const staleSetter = first.result.current[1];
    first.unmount();
    act(() => staleSetter(''));
    const second = renderHook(() => useGuidDraft());
    expect(second.result.current[0]).toBe('');
    second.unmount();
  });

  it('does not discard a newer draft when an earlier send is acknowledged', () => {
    const hook = renderHook(() => useGuidDraft());
    act(() => hook.result.current[1]('New draft'));
    act(() => clearGuidDraftIfMatches('Earlier send'));
    expect(hook.result.current[0]).toBe('New draft');
    act(() => clearGuidDraftIfMatches('New draft'));
    expect(hook.result.current[0]).toBe('');
    hook.unmount();
  });

  it('keeps the new-chat draft when the Guid surface is unmounted and mounted again', () => {
    const first = renderHook(() => useGuidDraft());
    act(() => first.result.current[1]('A prompt I am still working on'));
    first.unmount();

    const second = renderHook(() => useGuidDraft());
    expect(second.result.current[0]).toBe('A prompt I am still working on');
    second.unmount();
  });
});
