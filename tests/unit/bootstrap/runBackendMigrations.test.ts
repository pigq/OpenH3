import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_GEN_ENV_KEYS } from '@/common/config/imageGenerationMcpEnv';
import {
  BUILTIN_IMAGE_GEN_NAME,
  BUILTIN_VIDEO_MEDIA_NAME,
  type IMcpServer,
  type IProvider,
} from '@/common/config/storage';
import {
  enforceOpenH3AssistantDefault,
  resolveImageGenerationMigrationConfig,
  runBackendMigrations,
} from '@/process/utils/runBackendMigrations';

const {
  batchImportServersMock,
  configFileGetMock,
  configFileSetMock,
  httpRequestMock,
  listServersMock,
  testMcpConnectionMock,
  updateServerMock,
  assistantListMock,
  assistantSetStateMock,
} = vi.hoisted(() => ({
  batchImportServersMock: vi.fn(),
  configFileGetMock: vi.fn(),
  configFileSetMock: vi.fn(),
  httpRequestMock: vi.fn(),
  listServersMock: vi.fn(),
  testMcpConnectionMock: vi.fn(),
  updateServerMock: vi.fn(),
  assistantListMock: vi.fn(),
  assistantSetStateMock: vi.fn(),
}));

vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: httpRequestMock,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {
    listServers: { invoke: listServersMock },
    batchImportServers: { invoke: batchImportServersMock },
    updateServer: { invoke: updateServerMock },
    testMcpConnection: { invoke: testMcpConnectionMock },
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      list: { invoke: assistantListMock },
      setState: { invoke: assistantSetStateMock },
    },
  },
}));

vi.mock('@/common/config/configMigration', () => ({
  migrateConfigStorage: vi.fn().mockResolvedValue(undefined),
  migrateLegacyMcpConfigToDb: vi.fn().mockResolvedValue(undefined),
  migrateProviders: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/process/utils/initStorage', () => ({
  getBuiltinMcpScriptPath: (name: string) => `/mock/${name}.js`,
}));

vi.mock('@/process/utils/migrateAssistants', () => ({
  migrateAssistantsToBackend: vi.fn().mockResolvedValue(true),
}));

const provider: IProvider = {
  id: 'provider-1',
  platform: 'gemini',
  name: 'Gemini',
  base_url: 'https://generativelanguage.googleapis.com',
  api_key: 'provider-key',
  models: ['gemini-image'],
  enabled: true,
};

const imageEnv = {
  [IMAGE_GEN_ENV_KEYS.providerId]: 'provider-1',
  [IMAGE_GEN_ENV_KEYS.platform]: 'gemini',
  [IMAGE_GEN_ENV_KEYS.baseUrl]: 'https://generativelanguage.googleapis.com',
  [IMAGE_GEN_ENV_KEYS.apiKey]: 'provider-key',
  [IMAGE_GEN_ENV_KEYS.model]: 'gemini-image',
};

const imageServer = (): IMcpServer => ({
  id: 'image-server-id',
  name: BUILTIN_IMAGE_GEN_NAME,
  description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
  enabled: true,
  builtin: true,
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['/mock/builtin-mcp-image-gen.js'],
    env: imageEnv,
  },
  created_at: 1,
  updated_at: 1,
  original_json: JSON.stringify(
    {
      mcpServers: {
        [BUILTIN_IMAGE_GEN_NAME]: {
          command: 'node',
          args: ['/mock/builtin-mcp-image-gen.js'],
          env: imageEnv,
        },
      },
    },
    null,
    2
  ),
});

const configFile = {
  get: configFileGetMock,
  set: configFileSetMock,
};

beforeEach(() => {
  vi.clearAllMocks();
  configFileGetMock.mockResolvedValue(undefined);
  configFileSetMock.mockResolvedValue(undefined);
  batchImportServersMock.mockResolvedValue([]);
  updateServerMock.mockImplementation(async ({ id, data }) => ({
    ...imageServer(),
    id,
    ...data,
  }));
  testMcpConnectionMock.mockResolvedValue({ success: false, error: 'Command not found: npx' });
  assistantListMock.mockResolvedValue([]);
  assistantSetStateMock.mockResolvedValue(undefined);
  httpRequestMock.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === '/api/settings/client') {
      return {
        'tools.imageGenerationModel': {
          id: 'provider-1',
          name: 'Gemini',
          platform: 'gemini',
          use_model: 'gemini-image',
        },
      };
    }
    if (method === 'GET' && path === '/api/providers') {
      return [provider];
    }
    return undefined;
  });
});

describe('resolveImageGenerationMigrationConfig', () => {
  it('uses backend client preference when local config file no longer has the image model', () => {
    const backendConfig = {
      id: 'gemini',
      name: 'Gemini',
      platform: 'gemini',
      base_url: 'https://example.test',
      api_key: 'backend-key',
      use_model: 'gemini-image',
    };

    expect(resolveImageGenerationMigrationConfig({ 'tools.imageGenerationModel': backendConfig }, undefined)).toEqual(
      backendConfig
    );
  });
});

describe('built-in ComfyUI tool upgrades', () => {
  it.each(['aionui-video-media', BUILTIN_VIDEO_MEDIA_NAME])(
    'repairs the stale media entrypoint for %s while preserving its ID and user environment',
    async (name) => {
      const existing = {
        ...imageServer(),
        id: 'media-server-id',
        name,
        enabled: false,
        transport: {
          type: 'stdio' as const,
          command: 'node',
          args: ['D:/old-install/out/main/builtin-mcp-video-media.js'],
          env: { OPENH3_MEDIA_PORT: '33019', CUSTOM_SETTING: 'preserve' },
        },
        original_json: '{}',
      };
      listServersMock.mockResolvedValue([imageServer(), existing]);

      await runBackendMigrations(configFile as never);

      const update = updateServerMock.mock.calls.find(([request]) => request.id === existing.id)?.[0];
      expect(update).toMatchObject({
        id: existing.id,
        data: {
          name: BUILTIN_VIDEO_MEDIA_NAME,
          builtin: true,
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['/mock/builtin-mcp-video-media.js'],
            env: existing.transport.env,
          },
        },
      });
      expect(update.data).not.toHaveProperty('enabled');
      expect(JSON.parse(update.data.original_json).mcpServers[BUILTIN_VIDEO_MEDIA_NAME]).toEqual({
        command: 'node',
        args: ['/mock/builtin-mcp-video-media.js'],
        env: existing.transport.env,
      });
    }
  );
});

describe('runBackendMigrations', () => {
  it('continues startup migrations when the bundled ComfyUI skill cannot be provisioned', async () => {
    listServersMock.mockResolvedValue([imageServer()]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const existingRequest = httpRequestMock.getMockImplementation();
    const skillFailure = new Error('skill inventory unavailable');
    httpRequestMock.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'GET' && args[1] === '/api/skills') throw skillFailure;
      return existingRequest?.(...args);
    });

    await expect(runBackendMigrations(configFile as never)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Backend migration step failed: provisionComfySkill'),
      skillFailure
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Backend migration step completed: syncBuiltinMcpConfig')
    );
    expect(httpRequestMock).not.toHaveBeenCalledWith('POST', '/api/skills/import', expect.anything());
  });

  it('enables only the native OpenH3 assistant on first run', async () => {
    assistantListMock.mockResolvedValue([
      {
        id: 'bare-aionrs',
        source: 'generated',
        agent: { type: 'aionrs' },
      },
      {
        id: 'builtin-aionrs-template',
        source: 'builtin',
        agent: { type: 'aionrs' },
      },
      {
        id: 'builtin-writer',
        source: 'builtin',
        agent: { type: 'acp', acp_backend: 'claude' },
      },
      {
        id: 'user-research',
        source: 'user',
        agent: { type: 'acp', acp_backend: 'gemini' },
      },
    ]);

    const completed = await enforceOpenH3AssistantDefault();

    expect(completed).toBe(true);
    expect(assistantSetStateMock).toHaveBeenCalledWith({ id: 'bare-aionrs', enabled: true });
    expect(assistantSetStateMock).toHaveBeenCalledWith({ id: 'builtin-aionrs-template', enabled: false });
    expect(assistantSetStateMock).toHaveBeenCalledWith({ id: 'builtin-writer', enabled: false });
    expect(assistantSetStateMock).not.toHaveBeenCalledWith({ id: 'user-research', enabled: false });
    expect(httpRequestMock).toHaveBeenCalledWith('PUT', '/api/settings/client', {
      'migration.openH3AssistantDefault_v1': true,
    });
  });

  it('does not change assistant state when client preferences cannot be read', async () => {
    assistantListMock.mockResolvedValue([{ id: 'openh3', source: 'generated', agent: { type: 'aionrs' } }]);
    httpRequestMock.mockRejectedValueOnce(new Error('backend unavailable'));

    await expect(enforceOpenH3AssistantDefault()).rejects.toThrow('backend unavailable');

    expect(assistantSetStateMock).not.toHaveBeenCalled();
  });

  it('does not write image generation business config back to local config storage', async () => {
    listServersMock.mockResolvedValue([imageServer()]);
    configFileGetMock.mockImplementation(async (key: string) => {
      if (key === 'tools.imageGenerationModel') {
        return {
          id: 'provider-1',
          name: 'Gemini',
          platform: 'gemini',
          use_model: 'gemini-image',
          switch: true,
        };
      }
      return undefined;
    });
    httpRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/settings/client') {
        return {};
      }
      if (method === 'GET' && path === '/api/providers') {
        return [provider];
      }
      return undefined;
    });

    await runBackendMigrations(configFile as never);

    expect(configFileSetMock).not.toHaveBeenCalledWith('tools.imageGenerationModel', expect.anything());
  });

  it('does not sync the built-in image MCP server when bootstrap makes no effective change', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([imageServer()]);

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).not.toHaveBeenCalled();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      'image-server-id',
      'no',
      'no',
      'no'
    );
  });

  it('does not sync agents when only the stored image MCP JSON representation differs', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([
      {
        ...imageServer(),
        original_json: '{"legacy":true}',
      },
    ]);

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).toHaveBeenCalledOnce();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      'image-server-id',
      'no',
      'yes',
      'yes'
    );
  });
});
