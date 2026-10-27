/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getClientBusinessSettingMock, mcpServiceMock, waitForBackendMigrationsMock } = vi.hoisted(() => ({
  getClientBusinessSettingMock: vi.fn(),
  waitForBackendMigrationsMock: vi.fn(),
  mcpServiceMock: {
    listServers: { invoke: vi.fn() },
  },
}));

vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: getClientBusinessSettingMock,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: mcpServiceMock,
}));

import { ensureBackendMcpCatalog } from '@/renderer/hooks/mcp/catalog';

describe('ensureBackendMcpCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { waitForBackendMigrations: waitForBackendMigrationsMock },
    });
    waitForBackendMigrationsMock.mockResolvedValue(true);
    getClientBusinessSettingMock.mockResolvedValue([]);
    mcpServiceMock.listServers.invoke.mockResolvedValue([
      {
        id: 'user-1',
        name: 'user one',
        enabled: true,
        transport: { type: 'stdio', command: 'user', args: [] },
        created_at: 2,
        updated_at: 2,
        original_json: '{}',
        builtin: false,
      },
    ]);
  });

  it('waits for desktop MCP bootstrap migrations before reading the catalog', async () => {
    await ensureBackendMcpCatalog();

    expect(waitForBackendMigrationsMock).toHaveBeenCalledTimes(1);
    expect(waitForBackendMigrationsMock.mock.invocationCallOrder[0]).toBeLessThan(
      mcpServiceMock.listServers.invoke.mock.invocationCallOrder[0]
    );
  });

  it('does not read an incomplete catalog while the desktop backend is starting', async () => {
    waitForBackendMigrationsMock.mockResolvedValueOnce(false);

    await expect(ensureBackendMcpCatalog()).rejects.toThrow('BACKEND_MIGRATIONS_NOT_READY');

    expect(getClientBusinessSettingMock).not.toHaveBeenCalled();
    expect(mcpServiceMock.listServers.invoke).not.toHaveBeenCalled();
  });

  it('reads MCP catalog from backend settings without falling back to configService', async () => {
    getClientBusinessSettingMock.mockResolvedValue([
      {
        id: 'builtin-1',
        name: 'builtin one',
        enabled: true,
        transport: { type: 'stdio', command: 'builtin', args: [] },
        created_at: 1,
        updated_at: 1,
        original_json: '{}',
        builtin: true,
      },
    ]);

    const result = await ensureBackendMcpCatalog();

    expect(result.userServers).toHaveLength(1);
    expect(result.builtinServers).toHaveLength(1);
    expect(result.allServers).toHaveLength(2);
    expect(waitForBackendMigrationsMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-import legacy user MCP rows from backend client settings at runtime', async () => {
    getClientBusinessSettingMock.mockResolvedValue([
      {
        id: 'legacy-user-1',
        name: 'legacy user server',
        enabled: true,
        transport: { type: 'stdio', command: 'legacy-user', args: [] },
        created_at: 1,
        updated_at: 1,
        original_json: '{}',
        builtin: false,
      },
    ]);
    mcpServiceMock.listServers.invoke.mockResolvedValue([]);

    const result = await ensureBackendMcpCatalog();

    expect(result.userServers).toEqual([]);
    expect(result.builtinServers).toEqual([]);
    expect(result.allServers).toEqual([]);
  });
});
