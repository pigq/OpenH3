import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreationModels } from '@/renderer/pages/guid/Creation/useCreationModels';

const mocks = vi.hoisted(() => ({ profiles: [] as Array<Record<string, unknown>>, refresh: vi.fn() }));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({ comfyApi: { profiles: vi.fn() } }));
vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({ default: () => ({ modelListWithImage: [] }) }));
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: key === 'creation.comfy-profiles' ? mocks.profiles : undefined,
    mutate: mocks.refresh,
    isLoading: false,
  }),
}));

describe('local ComfyUI profile selection', () => {
  beforeEach(() => {
    mocks.profiles = [];
    localStorage.clear();
  });

  it('lists only discovered image profiles with their validation states', () => {
    mocks.profiles = [
      {
        id: 'qwen-bf16',
        family: 'qwen-edit',
        name: 'Qwen-Edit BF16',
        kind: 'image',
        state: 'verified',
        version: 'v1',
        quantization: 'bf16',
      },
      {
        id: 'qwen-fp8',
        family: 'qwen-edit',
        name: 'Qwen-Edit FP8',
        kind: 'image',
        state: 'downloaded',
        version: 'v2',
        quantization: 'fp8',
      },
    ];
    const { result } = renderHook(() => useCreationModels(true));
    act(() => result.current.setSelection((previous) => ({ ...previous, kind: 'image', source: 'local' })));
    expect(result.current.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'qwen-bf16',
          family: 'qwen-edit',
          profileId: 'qwen-bf16',
          available: true,
          state: 'verified',
        }),
        expect.objectContaining({ id: 'qwen-fp8', available: false, state: 'downloaded' }),
      ])
    );
    expect(result.current.models).toHaveLength(2);
    expect(result.current.models.some((item) => item.state === 'no-workflow')).toBe(false);
  });

  it('does not advertise H3 families as installed models in an empty inventory', () => {
    localStorage.setItem('creation.selection', JSON.stringify({ source: 'local', kind: 'video', modelIds: {} }));
    const { result } = renderHook(() => useCreationModels(true));
    expect(result.current.models).toEqual([]);
    expect(result.current.model).toMatchObject({ name: '', available: false, state: 'not-installed' });
    expect(result.current.model.profileId).toBeUndefined();
  });

  it('clears an old family-only preference without treating it as a missing installed profile', () => {
    localStorage.setItem(
      'creation.selection',
      JSON.stringify({ source: 'local', kind: 'video', modelIds: { 'local-video': 'h3' } })
    );
    const { result } = renderHook(() => useCreationModels(true));
    expect(result.current.models).toEqual([]);
    expect(result.current.model.profileId).toBeUndefined();
  });

  it('preserves the user profile choice when a new version appears and on remount', () => {
    mocks.profiles = [{ id: 'qwen-fp8', family: 'qwen-edit', name: 'Qwen-Edit FP8', kind: 'image', state: 'verified' }];
    const { result, unmount } = renderHook(() => useCreationModels(true));
    act(() =>
      result.current.setSelection((previous) => ({
        ...previous,
        source: 'local',
        kind: 'image',
        modelIds: { 'local-image': 'qwen-fp8' },
      }))
    );
    expect(result.current.model.id).toBe('qwen-fp8');
    unmount();
    mocks.profiles.unshift({
      id: 'qwen-bf16',
      family: 'qwen-edit',
      name: 'Qwen-Edit BF16',
      kind: 'image',
      state: 'verified',
    });
    const remount = renderHook(() => useCreationModels(true));
    expect(remount.result.current.model.id).toBe('qwen-fp8');
    expect(JSON.parse(localStorage.getItem('creation.selection')!)).toMatchObject({
      modelIds: { 'local-image': 'qwen-fp8' },
    });
  });

  it('keeps a selected missing profile unavailable instead of replacing it with another version', () => {
    mocks.profiles = [{ id: 'qwen-new', family: 'qwen-edit', name: 'Qwen-Edit new', kind: 'image', state: 'verified' }];
    localStorage.setItem(
      'creation.selection',
      JSON.stringify({ source: 'local', kind: 'image', modelIds: { 'local-image': 'qwen-previous' } })
    );
    const { result } = renderHook(() => useCreationModels(true));
    expect(result.current.model).toMatchObject({
      id: 'qwen-previous',
      profileId: 'qwen-previous',
      state: 'unavailable',
      available: false,
    });
  });

  it('retains the family of a selected profile after it disappears from inventory', () => {
    mocks.profiles = [{ id: 'z-prior', family: 'z-image', name: 'Z-Image prior', kind: 'image', state: 'verified' }];
    localStorage.setItem(
      'creation.selection',
      JSON.stringify({ source: 'local', kind: 'image', modelIds: { 'local-image': 'z-prior' } })
    );
    const first = renderHook(() => useCreationModels(true));
    expect(first.result.current.model.family).toBe('z-image');
    first.unmount();
    mocks.profiles = [];
    const next = renderHook(() => useCreationModels(true));
    expect(next.result.current.model).toMatchObject({
      profileId: 'z-prior',
      name: 'Z-Image prior',
      family: 'z-image',
      state: 'unavailable',
    });
  });
});
