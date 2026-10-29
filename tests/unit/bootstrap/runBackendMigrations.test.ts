import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_GEN_ENV_KEYS } from '@/common/config/imageGenerationMcpEnv';
import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
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

const browserServer = (overrides: Partial<IMcpServer> = {}): IMcpServer => ({
  ...imageServer(),
  id: 'legacy-browser-id',
  name: 'aionui-browser',
  enabled: false,
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['D:/old-install/out/main/builtin-mcp-browser.js'],
    env: { CUSTOM_BROWSER_SETTING: 'preserve' },
  },
  original_json: '{}',
  ...overrides,
});

function useServerInventory(initial: IMcpServer[]): IMcpServer[] {
  const inventory = structuredClone(initial);
  listServersMock.mockImplementation(async () => structuredClone(inventory));
  batchImportServersMock.mockImplementation(async ({ servers }: { servers: IMcpServer[] }) => {
    for (const server of servers) {
      if (inventory.some((existing) => existing.name === server.name)) throw new Error('Duplicate MCP server name');
      inventory.push({ ...server, id: `imported-${server.name}`, created_at: 2, updated_at: 2 });
    }
    return servers;
  });
  updateServerMock.mockImplementation(async ({ id, data }: { id: string; data: Partial<IMcpServer> }) => {
    const server = inventory.find((candidate) => candidate.id === id)!;
    const conflict = inventory.find((candidate) => candidate.id !== id && candidate.name === data.name);
    if (conflict) {
      // The backend owns controlled built-in alias consolidation; custom rows remain reserved.
      if (!server.builtin || !conflict.builtin) throw new Error('Duplicate MCP server name');
      inventory.splice(inventory.indexOf(conflict), 1);
    }
    Object.assign(server, data);
    return structuredClone(server);
  });
  return inventory;
}

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

describe('built-in browser upgrades', () => {
  it('renames the legacy browser in place without importing a conflicting canonical row and is idempotent', async () => {
    const legacy = browserServer();
    const inventory = useServerInventory([imageServer(), legacy]);

    await runBackendMigrations(configFile as never);

    expect(inventory.filter((server) => server.name.includes('browser'))).toEqual([
      expect.objectContaining({ id: legacy.id, name: BUILTIN_BROWSER_MCP_NAME, enabled: false }),
    ]);
    expect(batchImportServersMock.mock.calls.flatMap(([request]) => request.servers)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: BUILTIN_BROWSER_MCP_NAME })])
    );
    const browser = inventory.find((server) => server.id === legacy.id)!;
    expect(browser.transport).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/mock/builtin-mcp-browser.js'],
      env: { CUSTOM_BROWSER_SETTING: 'preserve' },
    });
    const updateCount = updateServerMock.mock.calls.length;
    const importCount = batchImportServersMock.mock.calls.length;

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).toHaveBeenCalledTimes(updateCount);
    expect(batchImportServersMock).toHaveBeenCalledTimes(importCount);
  });

  it('consolidates an already duplicated built-in browser through the legacy ID regardless of list order', async () => {
    const legacy = browserServer();
    const inventory = useServerInventory([
      imageServer(),
      browserServer({ id: 'new-browser-id', name: BUILTIN_BROWSER_MCP_NAME, enabled: true }),
      legacy,
    ]);

    await runBackendMigrations(configFile as never);

    expect(inventory.filter((server) => server.name.includes('browser'))).toEqual([
      expect.objectContaining({ id: legacy.id, name: BUILTIN_BROWSER_MCP_NAME, enabled: false }),
    ]);
    expect(updateServerMock).toHaveBeenCalledWith({
      id: legacy.id,
      data: expect.objectContaining({ name: BUILTIN_BROWSER_MCP_NAME }),
    });
  });

  it('preserves a user custom service using a historical browser name', async () => {
    const custom = browserServer({ builtin: false, transport: { type: 'http', url: 'https://custom.test/mcp' } });
    const inventory = useServerInventory([imageServer(), custom]);

    await runBackendMigrations(configFile as never);

    expect(inventory.find((server) => server.id === custom.id)).toEqual(custom);
    expect(updateServerMock.mock.calls.some(([request]) => request.id === custom.id)).toBe(false);
  });

  it('leaves both records intact when a custom service owns the canonical browser name', async () => {
    const custom = browserServer({
      id: 'custom-browser-id',
      name: BUILTIN_BROWSER_MCP_NAME,
      builtin: false,
      transport: { type: 'http', url: 'https://custom.test/mcp' },
    });
    const legacy = browserServer();
    const inventory = useServerInventory([imageServer(), custom, legacy]);

    await runBackendMigrations(configFile as never);

    expect(inventory.find((server) => server.id === custom.id)).toEqual(custom);
    expect(inventory.find((server) => server.id === legacy.id)).toEqual(legacy);
    expect(updateServerMock.mock.calls.some(([request]) => request.id === custom.id)).toBe(false);
  });

  it('repairs other built-ins even when the image update fails', async () => {
    const media = { ...imageServer(), id: 'media-id', name: 'aionui-video-media', original_json: '{}' };
    const inventory = useServerInventory([imageServer(), media, browserServer()]);
    const update = updateServerMock.getMockImplementation()!;
    updateServerMock.mockImplementation(async (request) => {
      if (request.id === 'image-server-id') throw new Error('Image update unavailable');
      return update(request);
    });
    inventory[0].original_json = '{}';

    await runBackendMigrations(configFile as never);

    expect(inventory.find((server) => server.id === media.id)?.name).toBe(BUILTIN_VIDEO_MEDIA_NAME);
    expect(inventory.find((server) => server.id === 'legacy-browser-id')?.name).toBe(BUILTIN_BROWSER_MCP_NAME);
  });

  it('repairs existing browser and image entries even when a missing default cannot be imported', async () => {
    const inventory = useServerInventory([{ ...imageServer(), original_json: '{}' }, browserServer()]);
    batchImportServersMock.mockRejectedValue(new Error('Default import unavailable'));

    await runBackendMigrations(configFile as never);

    expect(inventory[0].original_json).toBe(imageServer().original_json);
    expect(inventory.find((server) => server.id === 'legacy-browser-id')?.name).toBe(BUILTIN_BROWSER_MCP_NAME);
    expect(batchImportServersMock.mock.calls.flatMap(([request]) => request.servers)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: BUILTIN_VIDEO_MEDIA_NAME }),
        expect.objectContaining({ name: 'chrome-devtools' }),
      ])
    );
  });
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
