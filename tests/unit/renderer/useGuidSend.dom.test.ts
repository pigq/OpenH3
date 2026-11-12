/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { createInstance } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18nConfig from '@/common/config/i18n-config.json';
import type { IMcpServer } from '@/common/config/storage';
import { useGuidSend, type GuidSendDeps } from '@/renderer/pages/guid/hooks/useGuidSend';
import { Message } from '@arco-design/web-react';
import { resetGuidDraft, setGuidTemplateSnapshot, useGuidDraft } from '@/renderer/pages/guid/hooks/useGuidDraft';
import { templateSnapshotFixture } from '../contentCatalog/galleryFixture';
import { ensureBackendMcpCatalog } from '@/renderer/hooks/mcp/catalog';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import { COMFY_FAMILIES } from '@/renderer/pages/guid/Creation/comfyDraft';

const createConversationInvokeMock = vi.fn();
const swrMutateMock = vi.fn();
const bindCreationMock = vi.fn().mockResolvedValue({ ok: true });
const checkCreationToolsMock = vi.fn();
vi.mock('@/common/chat/document/h3JobApi', () => ({
  h3JobApi: { bindCreation: (...args: unknown[]) => bindCreationMock(...args) },
}));
vi.mock('@/renderer/hooks/mcp/catalog', async () => ({
  ...(await vi.importActual<typeof import('@/renderer/hooks/mcp/catalog')>('@/renderer/hooks/mcp/catalog')),
  ensureBackendMcpCatalog: vi.fn().mockResolvedValue({ allServers: [] }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    mcpService: { testMcpConnection: { invoke: (...args: unknown[]) => checkCreationToolsMock(...args) } },
    conversation: {
      create: {
        invoke: (...args: unknown[]) => createConversationInvokeMock(...args),
      },
    },
  },
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    emit: vi.fn(),
  },
}));

vi.mock('swr', () => ({
  mutate: (...args: unknown[]) => swrMutateMock(...args),
}));

vi.mock('@/renderer/utils/workspace/workspaceHistory', () => ({
  updateWorkspaceTime: vi.fn(),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: {
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

const createDeps = (): GuidSendDeps => ({
  input: 'hello',
  setInput: vi.fn(),
  files: [],
  setFiles: vi.fn(),
  dir: '',
  setDir: vi.fn(),
  setLoading: vi.fn(),
  loading: false,
  selectedAssistantId: 'assistant-1',
  selectedAssistantBackend: 'claude',
  selectedMode: 'bypassPermissions',
  selectedAcpModel: 'claude-opus',
  current_model: undefined,
  guidDisabledBuiltinSkills: undefined,
  guidEnabledSkills: undefined,
  assistantDefaultSkillIds: undefined,
  assistantDefaultDisabledBuiltinSkillIds: undefined,
  availableMcpServers: [{ id: 'mcp-user', name: 'User MCP', enabled: true, builtin: false } as IMcpServer],
  selectedMcpServerIds: ['mcp-user'],
  assistantDefaultMcpIds: undefined,
  isGoogleAuth: false,
  setMentionOpen: vi.fn(),
  setMentionQuery: vi.fn(),
  setMentionSelectorOpen: vi.fn(),
  setMentionActiveIndex: vi.fn(),
  navigate: vi.fn(() => Promise.resolve()) as never,
  t: vi.fn((key: string, options?: { defaultValue?: string }) => options?.defaultValue || key) as never,
  localeKey: 'zh-CN',
});
const createGenerationDeps = (): GuidSendDeps => ({
  ...createDeps(),
  creationModel: {
    id: 'qwen-fp8',
    profileId: 'qwen-fp8',
    name: 'Qwen-Edit',
    kind: 'image',
    source: 'local',
    state: 'verified',
    available: true,
    family: 'qwen-edit',
    intent: 'generate',
  },
});

describe('useGuidSend', () => {
  it.each(
    i18nConfig.supportedLanguages.flatMap((language) =>
      ['default', 'bypassPermissions'].map((mode) => ({ language, mode }))
    )
  )('keeps generation repair within the selected approval mode in $language ($mode)', async ({ language, mode }) => {
    const policies: Record<string, { repair: RegExp; approval: RegExp; obsoleteGate: string }> = {
      'zh-CN': { repair: /诊断.*修复/, approval: /当前审批模式/, obsoleteGate: '请先询问我是否安装' },
      'en-US': { repair: /diagnose.*repair/, approval: /current approval mode/, obsoleteGate: 'ask me to install' },
      'ja-JP': { repair: /診断.*修復/, approval: /現在の承認モード/, obsoleteGate: 'インストールまたは設定を依頼' },
      'zh-TW': { repair: /診斷.*修復/, approval: /目前的審批模式/, obsoleteGate: '請先詢問我是否安裝' },
      'ko-KR': { repair: /진단.*복구/, approval: /현재 승인 모드/, obsoleteGate: '설치나 설정을 요청' },
      'tr-TR': {
        repair: /tanıla.*onar/,
        approval: /geçerli onay modu/,
        obsoleteGate: 'yüklememi veya yapılandırmamı iste',
      },
      'ru-RU': {
        repair: /диагностику.*исправление/,
        approval: /текущего режима подтверждений/,
        obsoleteGate: 'попроси меня установить',
      },
      'uk-UA': {
        repair: /діагностику.*виправлення/,
        approval: /поточного режиму підтверджень/,
        obsoleteGate: 'попроси мене встановити',
      },
      'pt-BR': {
        repair: /diagnostique.*repare/,
        approval: /modo de aprovação atual/,
        obsoleteGate: 'peça para eu instalá-lo',
      },
      'de-DE': {
        repair: /diagnostiziere.*repariere/,
        approval: /aktuellen Genehmigungsmodus/,
        obsoleteGate: 'bitte mich um Installation',
      },
      'es-ES': {
        repair: /diagnostica.*repara/,
        approval: /modo de aprobación actual/,
        obsoleteGate: 'pídeme instalarlo',
      },
      'fr-FR': {
        repair: /diagnostique.*répare/,
        approval: /mode d’approbation actuel/,
        obsoleteGate: 'demande-moi de l’installer',
      },
      'fa-IR': { repair: /عیب‌یابی.*تعمیر/, approval: /حالت تأیید فعلی/, obsoleteGate: 'از من بخواه آن را نصب' },
    };
    const guid = JSON.parse(
      fs.readFileSync(path.resolve(`packages/desktop/src/renderer/services/i18n/locales/${language}/guid.json`), 'utf8')
    );
    const translation = createInstance();
    await translation.init({ lng: language, fallbackLng: false, resources: { [language]: { translation: { guid } } } });
    const deps = createGenerationDeps();
    deps.t = translation.t as GuidSendDeps['t'];
    deps.localeKey = language;
    deps.selectedMode = mode;
    deps.input =
      'Use this exact model and precision at 1024x1024. Repair failures without changing those requirements.';
    deps.creationModel = { ...deps.creationModel!, state: 'unavailable', available: false };
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      expect(await result.current.handleSend()).toBe(true);
    });
    const payload = createConversationInvokeMock.mock.calls[0][0];
    const initial = JSON.parse(sessionStorage.getItem('acp_initial_message_conv-1')!);
    expect(initial.input).toMatch(policies[language].repair);
    expect(initial.input).toMatch(policies[language].approval);
    expect(initial.input).not.toContain(policies[language].obsoleteGate);
    const variantTerms: Record<string, RegExp> = {
      'zh-CN': /已验证的修复变体/,
      'en-US': /validated repair variant/,
      'ja-JP': /検証済みの修復バリアント/,
      'zh-TW': /已驗證的修復變體/,
      'ko-KR': /검증된 복구 변형/,
      'tr-TR': /doğrulanmış bir onarım varyantı/,
      'ru-RU': /проверенный исправленный вариант/,
      'uk-UA': /перевірений виправлений варіант/,
      'pt-BR': /variante de reparo validada/,
      'de-DE': /validierte Reparaturvariante/,
      'es-ES': /variante de reparación validada/,
      'fr-FR': /variante de réparation validée/,
      'fa-IR': /نسخهٔ اصلاح‌شده و اعتبارسنجی‌شده/,
    };
    expect(initial.input).toMatch(variantTerms[language]);
    expect(initial.input.startsWith(`${deps.input}\n\n`)).toBe(true);
    expect(initial.input).toContain('qwen-fp8');
    expect(initial.input).not.toContain('{{');
    expect(initial.guidDraft).toBe(deps.input);
    expect(payload.assistant.conversation_overrides.permission).toBe(mode);
    expect(payload.extra.creation_request).toMatchObject({
      profileId: 'qwen-fp8',
      source: 'local',
      intent: 'generate',
    });
  });

  it('clears the submitted install prompt from the persistent home draft', async () => {
    const draft = renderHook(() => useGuidDraft());
    const prompt = '调用 comfyui-local 自动安装 Qwen-Edit';
    act(() => draft.result.current[1](prompt));
    const deps = createDeps();
    deps.input = prompt;
    deps.setInput = draft.result.current[1];
    deps.creationIntent = { family: 'qwen-edit', intent: 'install' };

    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });

    expect(draft.result.current[0]).toBe('');
    expect(JSON.parse(sessionStorage.getItem('acp_initial_message_conv-1')!).input).toBe(prompt);
  });

  it.each(
    COMFY_FAMILIES.flatMap(({ family, name, kind }) =>
      (['install', 'repair', 'install-other'] as const).flatMap((intent) =>
        ['claude', 'aionrs'].map((backend) => ({ family, name, kind, intent, backend }))
      )
    )
  )(
    'keeps the short $family $intent Skill request bound in $backend sessions',
    async ({ family, name, kind, intent, backend }) => {
      const deps = createDeps();
      const profileId = intent === 'repair' ? `${family}-existing` : undefined;
      deps.creationIntent = { family, intent, profileId };
      deps.input = `Use comfyui-local for ${name}.`;
      deps.selectedAssistantBackend = backend;
      deps.current_model = {
        id: 'provider',
        platform: 'openai',
        use_model: 'test-model',
        models: ['test-model'],
      } as GuidSendDeps['current_model'];
      deps.guidEnabledSkills = ['other-skill'];
      deps.guidDisabledBuiltinSkills = ['comfyui-local', 'disabled-skill'];
      const { result } = renderHook(() => useGuidSend(deps));
      await act(async () => {
        expect(await result.current.handleSend()).toBe(true);
      });
      const payload = createConversationInvokeMock.mock.calls[0][0];
      expect(payload.assistant.conversation_overrides).toMatchObject({
        skill_ids: ['other-skill', 'comfyui-local'],
        disabled_builtin_skill_ids: ['disabled-skill'],
        permission: 'bypassPermissions',
      });
      expect(payload.extra.creation_request).toMatchObject({
        family,
        intent,
        profileId,
        name,
        kind,
        source: 'local',
        installationMode: 'agent',
      });
      expect(payload.extra.selected_session_mcp_servers).toHaveLength(1);
      expect(payload.extra.selected_session_mcp_servers[0].transport.env).toMatchObject({
        OPENH3_CREATION_FAMILY: family,
        OPENH3_CREATION_INTENT: intent,
        ...(profileId ? { OPENH3_CREATION_PROFILE: profileId } : {}),
      });
      const storagePrefix = backend === 'aionrs' ? 'aionrs' : 'acp';
      const initial = JSON.parse(sessionStorage.getItem(`${storagePrefix}_initial_message_conv-1`)!);
      expect(initial.guidDraft).toBe(deps.input);
      expect(initial.input).toBe(deps.input);
      expect(initial.creationRequest).toEqual(payload.extra.creation_request);
      expect(initial.creationRequestId).toBe(payload.extra.creation_request.requestId);
    }
  );

  it('refreshes the optional media transport without requiring an Agent tool call for model-card installation', async () => {
    const deps = createDeps();
    deps.creationIntent = { family: 'qwen-edit', intent: 'install' };
    const stale: IMcpServer = {
      id: 'media',
      name: 'openh3-video-media',
      builtin: true,
      transport: { type: 'stdio', command: 'node', args: ['D:/old/media.js'] },
    } as IMcpServer;
    const current = { ...stale, transport: { ...stale.transport, args: ['D:/current/media.js'] } } as IMcpServer;
    deps.availableMcpServers.push(stale);
    deps.selectedMcpServerIds = ['media'];
    vi.mocked(ensureBackendMcpCatalog).mockResolvedValueOnce({
      allServers: [current],
      userServers: [],
      builtinServers: [current],
    });
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });
    const session = createConversationInvokeMock.mock.calls[0][0].extra.selected_session_mcp_servers;
    expect(session).toHaveLength(1);
    expect(session[0].transport.args).toEqual(['D:/current/media.js']);
    expect(session[0].transport.env).toMatchObject({
      OPENH3_CREATION_FAMILY: 'qwen-edit',
      OPENH3_CREATION_INTENT: 'install',
    });
    expect(checkCreationToolsMock).not.toHaveBeenCalled();
  });

  it.each(['missing-install', 'connection-failed'] as const)(
    'keeps the Qwen generation draft when its dedicated tools are %s',
    async (failure) => {
      const deps = createGenerationDeps();
      checkCreationToolsMock.mockResolvedValue(
        failure === 'missing-install'
          ? { success: true, tools: [{ name: 'openh3_comfy_environment' }, { name: 'openh3_comfy_profiles' }] }
          : { success: false, code: 'MCP_COMMAND_START_FAILED' }
      );
      const { result } = renderHook(() => useGuidSend(deps));
      let sent: boolean | undefined;
      await act(async () => {
        sent = await result.current.handleSend();
      });
      expect(sent).toBe(false);
      expect(createConversationInvokeMock).not.toHaveBeenCalled();
      expect(deps.navigate).not.toHaveBeenCalled();
      expect(deps.setInput).not.toHaveBeenCalled();
      expect(Message.error).toHaveBeenCalledWith('guid.creation.toolsCheckFailed');
      expect(deps.t).toHaveBeenCalledWith(
        'guid.creation.toolsCheckFailed',
        expect.objectContaining({
          reason: expect.stringContaining(
            failure === 'missing-install' ? 'openh3_comfy_generate' : 'MCP_COMMAND_START_FAILED'
          ),
        })
      );
    }
  );

  it('accepts legacy AionUi ComfyUI tool aliases from an existing installation', async () => {
    const deps = createGenerationDeps();
    checkCreationToolsMock.mockResolvedValue({
      success: true,
      tools: [
        'aionui_comfy_environment',
        'aionui_comfy_profiles',
        'aionui_comfy_generate',
        'aionui_comfy_job_status',
        'aionui_comfy_cancel_job',
      ].map((name) => ({ name })),
    });

    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      expect(await result.current.handleSend()).toBe(true);
    });

    expect(createConversationInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('reports a structured MCP failure without displaying the transport payload or submitting a chat', async () => {
    const deps = createGenerationDeps();
    checkCreationToolsMock.mockRejectedValue(
      new BackendHttpError({
        method: 'POST',
        path: '/api/mcp/test-connection',
        status: 502,
        body: { code: 'MCP_COMMAND_START_FAILED', error: 'private transport details' },
      })
    );
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });
    expect(createConversationInvokeMock).not.toHaveBeenCalled();
    expect(deps.t).toHaveBeenCalledWith('guid.creation.toolsCheckFailed', { reason: 'MCP_COMMAND_START_FAILED' });
    expect(JSON.stringify(vi.mocked(deps.t).mock.calls)).not.toContain('private transport details');
  });

  it('keeps an editable generation draft when the fresh MCP catalog cannot be loaded', async () => {
    const deps = createGenerationDeps();
    vi.mocked(ensureBackendMcpCatalog).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      expect(await result.current.handleSend()).toBe(false);
    });
    expect(createConversationInvokeMock).not.toHaveBeenCalled();
    expect(checkCreationToolsMock).not.toHaveBeenCalled();
    expect(deps.t).toHaveBeenCalledWith('guid.creation.toolsCheckFailed', { reason: 'COMFY_MCP_CATALOG_UNAVAILABLE' });
  });

  it('reports missing session tools instead of starting a generation conversation', async () => {
    const deps = createGenerationDeps();
    vi.mocked(ensureBackendMcpCatalog).mockResolvedValue({
      allServers: [],
      userServers: [],
      builtinServers: [],
    });

    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      expect(await result.current.handleSend()).toBe(false);
    });

    expect(checkCreationToolsMock).not.toHaveBeenCalled();
    expect(createConversationInvokeMock).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(Message.error).toHaveBeenCalledWith('guid.creation.toolsCheckFailed');
    expect(deps.t).toHaveBeenCalledWith('guid.creation.toolsCheckFailed', {
      reason: 'COMFY_MCP_SERVER_NOT_REGISTERED',
    });
  });

  it.each(['catalog-failed', 'server-missing'] as const)(
    'creates deterministic model-card installation even when the Agent MCP is %s',
    async (failure) => {
      const deps = createDeps();
      deps.creationIntent = { family: 'qwen-edit', intent: 'install' };
      if (failure === 'catalog-failed') vi.mocked(ensureBackendMcpCatalog).mockRejectedValue(new Error('not ready'));
      else
        vi.mocked(ensureBackendMcpCatalog).mockResolvedValue({ allServers: [], userServers: [], builtinServers: [] });

      const { result } = renderHook(() => useGuidSend(deps));
      await act(async () => {
        expect(await result.current.handleSend()).toBe(true);
      });

      expect(createConversationInvokeMock).toHaveBeenCalledOnce();
      expect(deps.navigate).toHaveBeenCalledWith('/conversation/conv-1');
      expect(checkCreationToolsMock).not.toHaveBeenCalled();
      expect(createConversationInvokeMock.mock.calls[0][0].extra.creation_request).toMatchObject({
        family: 'qwen-edit',
        intent: 'install',
        requestId: expect.any(String),
      });
    }
  );

  it('refreshes a transiently missing installation transport and reuses the request identity', async () => {
    const deps = createDeps();
    deps.creationIntent = {
      family: 'qwen-edit',
      intent: 'install',
      requestId: '11111111-1111-4111-8111-111111111111',
    };
    const recovered = {
      id: 'media',
      name: 'openh3-video-media',
      builtin: true,
      transport: { type: 'stdio', command: 'node', args: ['recovered.js'] },
    } as IMcpServer;
    vi.mocked(ensureBackendMcpCatalog).mockResolvedValueOnce({
      allServers: [],
      userServers: [],
      builtinServers: [],
    });
    vi.mocked(ensureBackendMcpCatalog).mockResolvedValueOnce({
      allServers: [recovered],
      userServers: [],
      builtinServers: [recovered],
    });
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => expect(await result.current.handleSend()).toBe(true));
    expect(ensureBackendMcpCatalog).toHaveBeenCalledTimes(2);
    expect(checkCreationToolsMock).not.toHaveBeenCalled();
    const snapshot = createConversationInvokeMock.mock.calls[0][0].extra.creation_request;
    expect(snapshot.requestId).toBe(deps.creationIntent.requestId);
    expect(
      createConversationInvokeMock.mock.calls[0][0].extra.selected_session_mcp_servers[0].transport.env
    ).toMatchObject({ OPENH3_CREATION_REQUEST_ID: deps.creationIntent.requestId });
  });

  it('rechecks tools with the fresh transport after a transient connection failure', async () => {
    const deps = createGenerationDeps();
    checkCreationToolsMock.mockResolvedValueOnce({ success: false, code: 'MCP_COMMAND_START_FAILED' });
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => expect(await result.current.handleSend()).toBe(true));
    expect(checkCreationToolsMock).toHaveBeenCalledTimes(2);
    expect(ensureBackendMcpCatalog).toHaveBeenCalledTimes(2);
    expect(checkCreationToolsMock.mock.calls[0][0].runtime_scope_id).toBe(
      checkCreationToolsMock.mock.calls[1][0].runtime_scope_id
    );
  });

  it('retains the installation request identity after a failed conversation creation', async () => {
    const deps = createDeps();
    deps.creationIntent = { family: 'qwen-edit', intent: 'install' };
    createConversationInvokeMock.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => expect(await result.current.handleSend()).toBe(false));
    await act(async () => expect(await result.current.handleSend()).toBe(true));
    expect(createConversationInvokeMock.mock.calls[0][0].extra.creation_request.requestId).toBe(
      createConversationInvokeMock.mock.calls[1][0].extra.creation_request.requestId
    );
  });
  it('preserves an unsent draft when conversation creation fails', async () => {
    const deps = createDeps();
    createConversationInvokeMock.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      result.current.sendMessageHandler();
    });
    expect(deps.setInput).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('starts cloud video without image credentials or a local ComfyUI skill', async () => {
    const deps = createDeps();
    deps.creationModel = {
      id: 'cloud-video:connection',
      name: 'Cloud H3',
      kind: 'video',
      source: 'cloud',
      state: 'configured',
      available: true,
    };
    const server = {
      id: 'media',
      name: 'openh3-video-media',
      builtin: true,
      transport: { type: 'stdio', command: 'node', args: ['media.js'] },
    } as IMcpServer;
    vi.mocked(ensureBackendMcpCatalog).mockResolvedValue({
      allServers: [server],
      userServers: [],
      builtinServers: [server],
    });
    checkCreationToolsMock.mockResolvedValue({
      success: true,
      tools: [{ name: 'openh3_cloud_video_generate' }, { name: 'openh3_cloud_video_status' }],
    });
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      expect(await result.current.handleSend()).toBe(true);
    });
    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant.conversation_overrides.skill_ids ?? []).not.toContain('comfyui-local');
    expect(payload.extra.creation_request).toMatchObject({
      id: 'cloud-video:connection',
      source: 'cloud',
      kind: 'video',
    });
    expect(JSON.stringify(payload.extra.selected_session_mcp_servers)).not.toContain('API_KEY');
  });

  it('adds the required local tool with a scoped request and navigates to the existing conversation', async () => {
    const deps = createDeps();
    deps.creationModel = {
      id: 'minimax-h3',
      name: 'MiniMax H3',
      kind: 'video',
      source: 'local',
      state: 'not-installed',
      available: false,
    };
    deps.availableMcpServers.push({
      id: 'media',
      name: 'aionui-video-media',
      builtin: true,
      transport: { type: 'stdio', command: 'node', args: ['media.js'] },
    } as IMcpServer);
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });
    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.extra.selected_session_mcp_servers[0]).toMatchObject({
      id: 'media',
      transport: {
        env: { AIONUI_CREATION_KIND: 'video', AIONUI_CREATION_SOURCE: 'local', AIONUI_CREATION_MODEL: 'minimax-h3' },
      },
    });
    expect(payload.extra.selected_session_mcp_servers[0].transport.env.AIONUI_CREATION_REQUEST_ID).toMatch(
      /^[a-f0-9-]{36}$/i
    );
    expect(deps.navigate).toHaveBeenCalledWith('/conversation/conv-1');
    const initial = JSON.parse(sessionStorage.getItem('acp_initial_message_conv-1')!);
    expect(initial.input).toContain('hello');
    expect(initial.guidDraft).toBe('hello');
    expect(initial.guidDraftScope).toEqual(expect.any(String));
    expect(initial.creationRequestId).toBe(
      payload.extra.selected_session_mcp_servers[0].transport.env.AIONUI_CREATION_REQUEST_ID
    );
  });

  it('uses the media tool and local skill for a local image profile and persists its request snapshot', async () => {
    setGuidTemplateSnapshot(templateSnapshotFixture);
    const deps = createDeps();
    deps.creationModel = {
      id: 'qwen-profile',
      name: 'Qwen-Edit BF16',
      kind: 'image',
      source: 'local',
      state: 'verified',
      available: true,
      profileId: 'qwen-profile',
      family: 'qwen-edit',
      modelSetId: 'model:qwen-bf16',
    } as GuidSendDeps['creationModel'];
    deps.creationConstraint = {
      modelSetId: 'model:qwen-bf16',
      selectionRevision: 4,
      workflowMode: 'fixed',
      fixedWorkflowId: 'qwen-edit-route',
    };
    deps.guidEnabledSkills = ['other-skill'];
    deps.guidDisabledBuiltinSkills = ['comfyui-local', 'disabled-skill'];
    deps.availableMcpServers.push({
      id: 'media',
      name: 'aionui-video-media',
      builtin: true,
      transport: { type: 'stdio', command: 'node', args: ['media.js'] },
    } as IMcpServer);
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });
    const payload = createConversationInvokeMock.mock.calls[0]?.[0];
    expect(payload?.assistant.conversation_overrides.skill_ids).toEqual(['other-skill', 'comfyui-local']);
    expect(payload?.assistant.conversation_overrides.disabled_builtin_skill_ids).toEqual(['disabled-skill']);
    expect(payload?.extra.creation_request).toMatchObject({
      family: 'qwen-edit',
      profileId: 'qwen-profile',
      kind: 'image',
      intent: 'generate',
      source: 'local',
      modelConstraint: deps.creationConstraint,
      modelSetId: 'model:qwen-bf16',
      workflowMode: 'fixed',
      fixedWorkflowId: 'qwen-edit-route',
    });
    expect(payload?.extra.selected_session_mcp_servers).toHaveLength(1);
    expect(payload?.extra.selected_session_mcp_servers[0].name).toBe('openh3-video-media');
    const initial = JSON.parse(sessionStorage.getItem('acp_initial_message_conv-1')!);
    expect(initial.creationRequest).toEqual(payload.extra.creation_request);
    expect(initial.creationRequest.templateSnapshot).toEqual(templateSnapshotFixture);
    expect(initial.input).toContain('hello');
    expect(initial.creationRequest.templateSnapshot.prompt).toBe('Original template prompt');
    expect(initial.creationRequestId).toBe(payload.extra.creation_request.requestId);
  });

  it('keeps an explicit cloud image request bound to its source before the first turn', async () => {
    const deps = createDeps();
    deps.creationModel = {
      id: 'cloud::image',
      name: 'cloud-image',
      kind: 'image',
      source: 'cloud',
      state: 'configured',
      available: true,
      provider: {
        id: 'selected-provider',
        name: 'Selected account',
        platform: 'openai',
        base_url: 'https://selected.example/v1',
        api_key: 'selected-test-key',
        models: ['gpt-image-2.5-all'],
        use_model: 'gpt-image-2.5-all',
      },
    };
    deps.availableMcpServers.push({
      id: 'images',
      name: 'aionui-image-generation',
      builtin: true,
      transport: { type: 'stdio', command: 'node' },
    } as IMcpServer);
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });
    const payload = createConversationInvokeMock.mock.calls[0][0];
    const initial = JSON.parse(sessionStorage.getItem('acp_initial_message_conv-1')!);
    expect(initial.creationRequestId).toBe(payload.extra.creation_request.requestId);
    expect(initial.creationRequest.source).toBe('cloud');
    expect(payload.assistant.conversation_overrides.skill_ids ?? []).not.toContain('comfyui-local');
    expect(payload.extra.selected_session_mcp_servers[0].transport.env).toMatchObject({
      AIONUI_IMG_PROVIDER_ID: 'selected-provider',
      AIONUI_IMG_API_KEY: 'selected-test-key',
      AIONUI_IMG_MODEL: 'gpt-image-2.5-all',
    });
    expect(JSON.stringify(initial)).not.toContain('selected-test-key');
  });

  it.each(['not-configured', 'unavailable', 'missing-provider', 'unsupported'] as const)(
    'blocks a %s cloud selection instead of inheriting global image credentials',
    async (state) => {
      const deps = createDeps();
      deps.creationModel = {
        id: 'preset::apiyi',
        name: 'gpt-image-2.5-all',
        kind: state === 'unsupported' ? 'video' : 'image',
        source: 'cloud',
        state: state === 'missing-provider' ? 'configured' : state,
        available: state === 'missing-provider',
      };
      deps.availableMcpServers.push({
        id: 'global-images',
        name: 'aionui-image-generation',
        builtin: true,
        transport: { type: 'stdio', command: 'node', env: { AIONUI_IMG_API_KEY: 'other-account-key' } },
      } as IMcpServer);
      const { result } = renderHook(() => useGuidSend(deps));
      let sent: boolean | undefined;
      await act(async () => {
        sent = await result.current.handleSend();
      });
      expect(sent).toBe(false);
      expect(createConversationInvokeMock).not.toHaveBeenCalled();
      expect(deps.navigate).not.toHaveBeenCalled();
      expect(Message.error).toHaveBeenCalledWith(
        state === 'unsupported' ? 'guid.creation.cloudVideoUnsupported' : 'guid.creation.configureCloud'
      );
    }
  );

  it('keeps the explicit image installation intent when the generation selector is still H3', async () => {
    const deps = createDeps();
    deps.creationModel = {
      id: 'minimax-h3',
      name: 'MiniMax H3',
      kind: 'video',
      source: 'local',
      state: 'installed',
      available: true,
    };
    (deps as GuidSendDeps & { creationIntent: unknown }).creationIntent = {
      family: 'z-image',
      intent: 'install-other',
    };
    deps.input = 'Please install another Z-Image version';
    deps.availableMcpServers.push({
      id: 'media',
      name: 'aionui-video-media',
      builtin: true,
      transport: { type: 'stdio', command: 'node' },
    } as IMcpServer);
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });
    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.extra.creation_request).toMatchObject({
      family: 'z-image',
      intent: 'install-other',
      kind: 'image',
      source: 'local',
    });
    expect(payload.extra.creation_request.id).not.toBe('minimax-h3');
    expect(payload.extra.selected_session_mcp_servers[0].transport.env).toMatchObject({
      AIONUI_CREATION_FAMILY: 'z-image',
      AIONUI_CREATION_INTENT: 'install-other',
    });
  });

  it('does not copy a selected cloud image provider into a local install request', async () => {
    const deps = createDeps();
    deps.creationModel = {
      id: 'cloud::image',
      name: 'cloud-image',
      kind: 'image',
      source: 'cloud',
      state: 'configured',
      available: true,
      provider: {
        id: 'cloud',
        platform: 'openai',
        base_url: 'https://example.com',
        api_key: 'cloud-secret',
        use_model: 'cloud-image',
        models: ['cloud-image'],
      },
    } as GuidSendDeps['creationModel'];
    deps.creationIntent = { family: 'qwen-edit', intent: 'install' };
    deps.availableMcpServers = [
      { id: 'media', name: 'aionui-video-media', builtin: true, transport: { type: 'stdio', command: 'node' } },
      { id: 'images', name: 'aionui-image-generation', builtin: true, transport: { type: 'stdio', command: 'node' } },
    ] as IMcpServer[];
    deps.selectedMcpServerIds = ['images'];
    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });
    const servers = createConversationInvokeMock.mock.calls[0][0].extra.selected_session_mcp_servers;
    expect(JSON.stringify(servers)).not.toContain('cloud-secret');
    expect(servers.find((server: { id: string }) => server.id === 'images').transport.env.AIONUI_CREATION_SOURCE).toBe(
      'local'
    );
  });
  beforeEach(() => {
    resetGuidDraft();
    createConversationInvokeMock.mockReset();
    createConversationInvokeMock.mockResolvedValue({ id: 'conv-1' });
    swrMutateMock.mockReset();
    swrMutateMock.mockResolvedValue(undefined);
    checkCreationToolsMock.mockReset();
    checkCreationToolsMock.mockResolvedValue({
      success: true,
      tools: [
        'openh3_comfy_environment',
        'openh3_comfy_profiles',
        'openh3_comfy_install',
        'openh3_comfy_generate',
        'openh3_comfy_job_status',
        'openh3_comfy_cancel_job',
      ].map((name) => ({ name })),
    });
    const media = {
      id: 'media',
      name: 'openh3-video-media',
      builtin: true,
      transport: { type: 'stdio', command: 'node', args: ['media.js'] },
    } as IMcpServer;
    vi.mocked(ensureBackendMcpCatalog).mockReset();
    vi.mocked(ensureBackendMcpCatalog).mockResolvedValue({
      allServers: [media],
      userServers: [],
      builtinServers: [media],
    });
  });

  it('passes selected mode into assistant conversation overrides when creating a preset ACP conversation', async () => {
    const deps = createDeps();
    deps.selectedThoughtLevelValue = 'high';

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    expect(createConversationInvokeMock).toHaveBeenCalledTimes(1);
    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.type).toBeUndefined();
    expect('model' in payload).toBe(false);
    expect(payload.assistant?.conversation_overrides?.permission).toBe('bypassPermissions');
    expect(payload.assistant?.conversation_overrides?.model).toBe('claude-opus');
    expect(payload.assistant?.conversation_overrides?.thought_level).toBe('high');
    expect(payload.extra.backend).toBeUndefined();
    expect(payload.extra.agent_name).toBeUndefined();
    expect(payload.extra.agent_id).toBeUndefined();
    expect(payload.extra.custom_agent_id).toBeUndefined();
    expect(payload.extra.preset_rules).toBeUndefined();
    expect(payload.extra.preset_context).toBeUndefined();
    expect(payload.extra.session_mode).toBeUndefined();
    expect(payload.extra.current_model_id).toBeUndefined();
    expect(payload.extra.preset_assistant_id).toBeUndefined();
    expect(swrMutateMock).toHaveBeenCalledWith('guid.assistant.detail.assistant-1.zh-CN');
    expect(swrMutateMock).toHaveBeenCalledWith('assistants.list');
  });

  it('falls back to assistant default skill and MCP ids for preset conversations before local Guid overrides exist', async () => {
    const deps = createDeps();
    deps.guidEnabledSkills = undefined;
    deps.guidDisabledBuiltinSkills = undefined;
    deps.assistantDefaultSkillIds = ['assistant-skill'];
    deps.assistantDefaultDisabledBuiltinSkillIds = ['builtin-skill'];
    deps.selectedMcpServerIds = undefined;
    deps.assistantDefaultMcpIds = ['mcp-user'];

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant?.conversation_overrides?.skill_ids).toEqual(['assistant-skill']);
    expect(payload.assistant?.conversation_overrides?.disabled_builtin_skill_ids).toEqual(['builtin-skill']);
    expect(payload.assistant?.conversation_overrides?.mcp_ids).toEqual(['mcp-user']);
    expect(payload.extra.selected_mcp_server_ids).toEqual(['mcp-user']);
  });

  it('preserves builtin MCP ids in assistant overrides while only sending user MCP ids to runtime selection', async () => {
    const deps = createDeps();
    deps.availableMcpServers = [
      { id: 'mcp-user', name: 'User MCP', enabled: true, builtin: false } as IMcpServer,
      { id: 'builtin-mcp', name: 'Builtin MCP', enabled: true, builtin: true } as IMcpServer,
    ];
    deps.selectedMcpServerIds = ['mcp-user', 'builtin-mcp'];

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant?.conversation_overrides?.mcp_ids).toEqual(['mcp-user', 'builtin-mcp']);
    expect(payload.extra.selected_mcp_server_ids).toEqual(['mcp-user']);
    expect(payload.extra.selected_session_mcp_servers).toEqual([expect.objectContaining({ id: 'builtin-mcp' })]);
  });

  it('does not write legacy preset_assistant_id for preset assistant sends', async () => {
    const deps = createDeps();

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant?.id).toBe('assistant-1');
    expect(payload.extra.preset_assistant_id).toBeUndefined();
  });

  it('forwards local skill overrides through assistant conversation overrides for ACP assistants', async () => {
    const deps = createDeps();
    deps.guidEnabledSkills = ['pdf-reader'];
    deps.guidDisabledBuiltinSkills = ['todo-tracker'];

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant?.id).toBe('assistant-1');
    expect(payload.assistant?.conversation_overrides?.skill_ids).toEqual(['pdf-reader']);
    expect(payload.assistant?.conversation_overrides?.disabled_builtin_skill_ids).toEqual(['todo-tracker']);
  });

  it('forwards local skill overrides for generated Aion CLI assistants through assistant conversation overrides', async () => {
    const deps = createDeps();
    deps.selectedAssistantId = 'bare:aionrs';
    deps.selectedAssistantBackend = 'aionrs';
    deps.current_model = { provider_id: 'openai', model: 'gemini-2.5-pro', use_model: 'gemini-2.5-pro' } as never;
    deps.guidEnabledSkills = ['pdf-reader'];
    deps.guidDisabledBuiltinSkills = ['todo-tracker'];

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.type).toBeUndefined();
    expect(payload.model).toBe(deps.current_model);
    expect(payload.assistant?.id).toBe('bare:aionrs');
    expect(payload.assistant?.conversation_overrides?.skill_ids).toEqual(['pdf-reader']);
    expect(payload.assistant?.conversation_overrides?.disabled_builtin_skill_ids).toEqual(['todo-tracker']);
    expect(payload.extra.session_mode).toBeUndefined();
  });

  it('does not write legacy preset_assistant_id for generated Aion CLI assistant conversations', async () => {
    const deps = createDeps();
    deps.selectedAssistantId = 'bare:aionrs';
    deps.selectedAssistantBackend = 'aionrs';
    deps.current_model = { provider_id: 'openai', model: 'gemini-2.5-pro', use_model: 'gemini-2.5-pro' } as never;

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant?.id).toBe('bare:aionrs');
    expect(payload.extra.preset_assistant_id).toBeUndefined();
  });

  it('does not write legacy preset_assistant_id for generated ACP assistant conversations', async () => {
    const deps = createDeps();
    deps.selectedAssistantId = 'bare:claude';
    deps.selectedAssistantBackend = 'claude';
    deps.current_model = { provider_id: 'anthropic', model: 'claude-sonnet', use_model: 'claude-sonnet' } as never;

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant?.id).toBe('bare:claude');
    expect(payload.type).toBeUndefined();
    expect('model' in payload).toBe(false);
    expect(payload.extra.preset_assistant_id).toBeUndefined();
    expect(payload.extra.backend).toBeUndefined();
  });

  it('does not hand a CLI agent the aionrs provider model on its first turn', async () => {
    // Reproduces the first-use failure: before the agent's catalog has been
    // probed there is no ACP model to offer, and the provider selection used to
    // fill the gap. A brand new Antigravity conversation therefore started on
    // `gemini-3.1-pro-preview` — a model agy has never heard of — and the turn
    // died with USER_LLM_PROVIDER_MODEL_NOT_FOUND. Once the catalog landed the
    // earlier option won again, which is why it only ever showed up on a fresh
    // machine.
    const deps = createDeps();
    deps.selectedAssistantBackend = 'antigravity';
    deps.selectedAcpModel = null;
    deps.current_model = { id: 'p1', name: 'Gemini', use_model: 'gemini-3.1-pro-preview' } as never;

    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    // No model at all: the agent then starts on its own default, which is what
    // "the user has not picked one" actually means.
    expect(payload.assistant.conversation_overrides.model).toBeUndefined();
  });

  it('still gives aionrs its provider model', async () => {
    // The fallback exists for aionrs, whose model IS the provider selection.
    const deps = createDeps();
    deps.selectedAssistantBackend = 'aionrs';
    deps.selectedAcpModel = null;
    deps.current_model = { id: 'p1', name: 'Gemini', use_model: 'gemini-3.1-pro-preview' } as never;

    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant.conversation_overrides.model).toBe('gemini-3.1-pro-preview');
  });

  it('sends no model override for a CLI agent when the user has not picked one', async () => {
    // The agent's own catalog is NOT a stand-in for the user's intent. It used to be
    // substituted here, so an unpicked conversation inherited whatever the agent's LAST
    // session had written back — for claude usually its `default` row, which pins the
    // account default and overrides the user's own ANTHROPIC_MODEL. Omitting the override
    // is what lets the agent resolve the model from the user's config, exactly as its CLI
    // does; the aionrs provider model stays gated to aionrs.
    const deps = createDeps();
    deps.selectedAssistantBackend = 'antigravity';
    deps.selectedAcpModel = null;
    deps.current_model = { id: 'p1', name: 'Gemini', use_model: 'gemini-3.1-pro-preview' } as never;

    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    expect(payload.assistant.conversation_overrides.model).toBeUndefined();
  });

  it('sends the model the user actually picked for a CLI agent', async () => {
    const deps = createDeps();
    deps.selectedAssistantBackend = 'claude';
    deps.selectedAcpModel = 'default';
    deps.current_model = { id: 'p1', name: 'Gemini', use_model: 'gemini-3.1-pro-preview' } as never;

    const { result } = renderHook(() => useGuidSend(deps));
    await act(async () => {
      await result.current.handleSend();
    });

    const payload = createConversationInvokeMock.mock.calls[0][0];
    // `default` is a real row of claude's catalog, not a synonym for "unpicked": it must
    // travel so the agent runs the account default the row advertises.
    expect(payload.assistant.conversation_overrides.model).toBe('default');
  });

  it('does not create a conversation without assistant identity', async () => {
    const deps = createDeps();
    deps.selectedAssistantId = null;
    deps.selectedAssistantBackend = 'claude';

    const { result } = renderHook(() => useGuidSend(deps));

    expect(result.current.isButtonDisabled).toBe(true);

    await act(async () => {
      await result.current.handleSend();
    });

    expect(createConversationInvokeMock).not.toHaveBeenCalled();
  });

  it('allows an empty-input start: creates the conversation but stashes no initial ACP message', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const deps = createDeps();
    deps.input = '   '; // whitespace only counts as empty

    const { result } = renderHook(() => useGuidSend(deps));

    // Empty input is no longer gated once an assistant is selected.
    expect(result.current.isButtonDisabled).toBe(false);

    await act(async () => {
      await result.current.handleSend();
    });

    expect(createConversationInvokeMock).toHaveBeenCalledTimes(1);
    expect(deps.navigate).toHaveBeenCalledWith('/conversation/conv-1');
    // No initial message is queued, so the window opens idle on the empty state.
    expect(setItemSpy).not.toHaveBeenCalledWith('acp_initial_message_conv-1', expect.anything());
    setItemSpy.mockRestore();
  });

  it('allows an empty-input start for aionrs without stashing an initial message', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const deps = createDeps();
    deps.input = '';
    deps.selectedAssistantBackend = 'aionrs';
    deps.current_model = { provider_id: 'openai', model: 'gemini-2.5-pro', use_model: 'gemini-2.5-pro' } as never;

    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    expect(createConversationInvokeMock).toHaveBeenCalledTimes(1);
    expect(deps.navigate).toHaveBeenCalledWith('/conversation/conv-1');
    expect(setItemSpy).not.toHaveBeenCalledWith('aionrs_initial_message_conv-1', expect.anything());
    setItemSpy.mockRestore();
  });
});
