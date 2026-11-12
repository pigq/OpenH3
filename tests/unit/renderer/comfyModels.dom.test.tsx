import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreationModels } from '@/renderer/pages/guid/Creation/useCreationModels';

const mocks = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, unknown>>,
  diagnostics: [] as Array<{ code: string; path?: string }>,
  refresh: vi.fn(),
}));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({
  COMFY_INVENTORY_CACHE_KEY: 'creation.comfy-inventory',
  comfyApi: { inventory: vi.fn() },
}));
vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({ default: () => ({ modelListWithImage: [] }) }));
vi.mock('swr', () => ({
  default: (key: string) => ({
    data:
      key === 'creation.comfy-inventory'
        ? { profiles: mocks.profiles, complete: !mocks.diagnostics.length, diagnostics: mocks.diagnostics }
        : undefined,
    mutate: mocks.refresh,
    isLoading: false,
  }),
}));

describe('local ComfyUI profile selection', () => {
  it.each(['image', 'video'] as const)(
    'retains an Agent-registered custom %s in the selector and saved preference',
    (kind) => {
      const custom = {
        id: `custom-${kind}`,
        family: `custom-${kind}`,
        name: `Custom ${kind}`,
        kind,
        state: 'downloaded',
      };
      mocks.profiles = [custom];
      localStorage.setItem(
        'creation.selection',
        JSON.stringify({ source: 'local', kind, modelIds: { [`local-${kind}`]: custom.id } })
      );
      const { result, rerender } = renderHook(() => useCreationModels(true));
      expect(result.current.models).toHaveLength(1);
      expect(result.current.model).toMatchObject({
        profileId: custom.id,
        family: custom.family,
        name: custom.name,
        kind,
      });
      mocks.profiles = [];
      rerender();
      expect(result.current.model).toMatchObject({
        profileId: custom.id,
        family: custom.family,
        name: custom.name,
        state: 'unavailable',
      });
    }
  );
  it('groups proven model bytes once while preserving every workflow and its validation state', () => {
    const recipe = {
      family: 'moss-image-sft',
      name: 'MOSS SFT',
      kind: 'image',
      version: 'v1',
      quantization: 'BF16',
      capabilities: ['text-to-image'],
      environment: { root: 'C:/OpenH3/ComfyUI', python: 'C:/OpenH3/python.exe', baseUrl: 'http://127.0.0.1:8188' },
      components: [
        {
          role: 'diffusion',
          name: 'moss.safetensors',
          path: 'C:/OpenH3/models/moss.safetensors',
          version: 'v1',
          precision: 'BF16',
          sha256: 'b'.repeat(64),
        },
      ],
      nodes: [{ id: 'comfy', version: 'v1' }],
      workflowPath: 'C:/OpenH3/workflows/moss.json',
      workflowSha256: 'a'.repeat(64),
      bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
      defaults: {},
    };
    mocks.profiles = [
      { ...recipe, id: 'moss-verified', state: 'verified' },
      {
        ...recipe,
        id: 'found-moss-copy',
        state: 'downloaded',
        workflowPath: 'C:/OpenH3/workflows/moss-edit.json',
        environment: { ...recipe.environment, baseUrl: 'http://127.0.0.1:18777' },
      },
    ];
    localStorage.setItem(
      'creation.selection',
      JSON.stringify({ source: 'local', kind: 'image', modelIds: { 'local-image': 'found-moss-copy' } })
    );
    const { result } = renderHook(() => useCreationModels(true));
    expect(result.current.models).toHaveLength(1);
    expect(result.current.model).toMatchObject({
      id: 'found-moss-copy',
      state: 'downloaded',
      available: true,
      workflowMode: 'auto',
    });
    expect(result.current.profiles).toHaveLength(2);
    act(() =>
      result.current.setSelection((previous) => ({
        ...previous,
        modelIds: { 'local-image': 'moss-verified' },
      }))
    );
    expect(result.current.selection.modelConstraint?.selectionRevision).toBe(0);
    act(() =>
      result.current.setSelection((previous) => ({
        ...previous,
        modelIds: { 'local-image': 'found-moss-copy' },
      }))
    );
    expect(result.current.selection.modelConstraint?.selectionRevision).toBe(0);
  });
  beforeEach(() => {
    mocks.profiles = [];
    mocks.diagnostics = [];
    localStorage.clear();
  });

  it('retains good models when another directory is incomplete and exposes the affected path', () => {
    mocks.profiles = [{ id: 'moss', family: 'moss-image-sft', name: 'MOSS SFT', kind: 'image', state: 'downloaded' }];
    mocks.diagnostics = [{ code: 'COMFY_INVENTORY_INTERPRETER_UNCONFIRMED', path: 'C:/OpenH3/old-checkout' }];
    const { result } = renderHook(() => useCreationModels(true));
    act(() =>
      result.current.setSelection((previous) => ({ ...previous, kind: 'image', source: 'local', modelIds: {} }))
    );
    expect(result.current.model).toMatchObject({ id: 'moss', state: 'downloaded' });
    expect(result.current.inventoryError).toContain('C:/OpenH3/old-checkout');
    expect(result.current.inventoryError).toContain('COMFY_INVENTORY_INTERPRETER_UNCONFIRMED');
    mocks.profiles = [];
    const next = renderHook(() => useCreationModels(true));
    expect(next.result.current.model.state).toBe('unavailable');
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
