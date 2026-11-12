// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import useSWR, { SWRConfig } from 'swr';
import { afterEach, expect, it, vi } from 'vitest';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import { useCreationModels } from '@/renderer/pages/guid/Creation/useCreationModels';
import ComfyOperationResult from '@/renderer/pages/conversation/runtime/Creation/ComfyOperationResult';

vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({ default: () => ({ modelListWithImage: [] }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({
    isProcessing: false,
    markSendStarted: vi.fn(),
    markSendAccepted: vi.fn(),
    markSendFailed: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/runtime/Creation/useComfySelectionPending', () => ({
  useComfySelectionPending: () => false,
  beginComfySelectionChange: () => vi.fn(),
}));
const profiles = [{ id: 'moss-sft', family: 'moss-image-sft', name: 'MOSS SFT', kind: 'image', state: 'downloaded' }];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
const provider =
  (cache = new Map()) =>
  ({ children }: { children: React.ReactNode }) =>
    React.createElement(SWRConfig, { value: { provider: () => cache, dedupingInterval: 60_000 } }, children);

it('opens AI creation after a profile-array consumer without reading that array as an inventory envelope', async () => {
  const cache = new Map();
  const wrapper = provider(cache);
  vi.spyOn(comfyApi, 'profiles').mockResolvedValue(profiles as never);
  vi.spyOn(comfyApi, 'inventory').mockResolvedValue({ profiles, complete: true, diagnostics: [] } as never);
  const previous = renderHook(() => useSWR('creation.comfy-profiles', () => comfyApi.profiles()), { wrapper });
  await waitFor(() => expect(previous.result.current.data).toHaveLength(1));
  previous.unmount();
  const creation = renderHook(() => useCreationModels(true), { wrapper });
  await waitFor(() => expect(creation.result.current.profiles).toHaveLength(1));
  act(() =>
    creation.result.current.setSelection((selection) => ({
      ...selection,
      kind: 'image',
      source: 'local',
      modelIds: {},
    }))
  );
  expect(creation.result.current.model.id).toBe('moss-sft');
});

it('opens a repair conversation after AI creation without reading its inventory object as a profile array', async () => {
  const wrapper = provider();
  vi.spyOn(comfyApi, 'profiles').mockResolvedValue(profiles as never);
  vi.spyOn(comfyApi, 'inventory').mockResolvedValue({ profiles, complete: true, diagnostics: [] } as never);
  const creation = renderHook(() => useCreationModels(true), { wrapper });
  await waitFor(() => expect(creation.result.current.profiles).toHaveLength(1));
  creation.unmount();
  const conversation = renderHook(
    () => {
      const { data = [] } = useSWR('creation.comfy-profiles', () => comfyApi.profiles());
      return data.map((profile) => profile.id);
    },
    { wrapper }
  );
  await waitFor(() => expect(conversation.result.current).toEqual(['moss-sft']));
});

it('refreshes both independent cache contracts on real SWR when installation completes', async () => {
  const cache = new Map();
  const wrapper = provider(cache);
  const calls = { profiles: 0, inventories: 0 };
  vi.spyOn(comfyApi, 'profiles').mockImplementation(async () => {
    calls.profiles++;
    return profiles as never;
  });
  vi.spyOn(comfyApi, 'inventory').mockImplementation(async () => {
    calls.inventories++;
    return { profiles, complete: true, diagnostics: [] } as never;
  });
  vi.spyOn(comfyApi, 'operation').mockResolvedValue({
    id: '12345678-1234-1234-1234-123456789abc',
    requestId: 'request-1',
    conversationId: 'chat',
    family: 'moss-image-sft',
    profileId: 'moss-sft',
    state: 'completed',
    updatedAt: new Date().toISOString(),
    plan: {
      ...profiles[0],
      environment: { root: 'C:/OpenH3/ComfyUI', python: 'C:/OpenH3/python.exe', baseUrl: 'http://127.0.0.1:8188' },
      components: [
        {
          role: 'diffusion',
          name: 'moss.safetensors',
          path: 'C:/OpenH3/models/moss.safetensors',
          version: 'v1',
          precision: 'BF16',
        },
      ],
      nodes: [{ id: 'comfy', version: 'v1' }],
      workflowPath: 'C:/OpenH3/workflow.json',
      workflowSha256: 'a'.repeat(64),
      bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
      defaults: {},
      quantization: 'BF16',
      version: 'v1',
      capabilities: ['text-to-image'],
      targetRoot: 'C:/OpenH3',
      downloadBytes: 0,
      requiredBytes: 0,
      reason: 'fixture',
      evidence: ['fixture'],
      workflow: { '1': { class_type: 'SaveImage', inputs: { text: '' } } },
      commands: [],
    },
  } as never);
  function BothContracts(): React.ReactElement {
    useSWR('creation.comfy-profiles', () => comfyApi.profiles());
    useSWR('creation.comfy-inventory', () => comfyApi.inventory());
    return React.createElement(ComfyOperationResult, {
      id: '12345678-1234-1234-1234-123456789abc',
      conversationId: 'chat',
    });
  }
  render(React.createElement(BothContracts), { wrapper });
  await waitFor(() => expect(calls.profiles).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(calls.inventories).toBeGreaterThanOrEqual(2));
  expect((cache.get('creation.comfy-profiles') as { data: unknown }).data).toEqual(profiles);
  expect(
    (cache.get('creation.comfy-inventory') as { data: { profiles: unknown[]; complete: boolean } }).data
  ).toMatchObject({ profiles, complete: true });
});
