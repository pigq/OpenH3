import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import type {
  LocalModelCenterSnapshot,
  LocalModelRecommendation,
} from '@/common/chat/document/creation/workflows/localModels';
import english from '@/renderer/services/i18n/locales/en-US/guid.json';
import LocalModelsPage from '@/renderer/pages/local-models/LocalModelsPage';
import {
  filterModels,
  formatBytes,
  modelAction,
  modelPrecisionGuide,
  usedPercent,
  verifiedPreviewArtifact,
} from '@/renderer/pages/local-models/modelCenterView';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  pick: vi.fn(),
  image: vi.fn(),
  install: vi.fn(),
  use: vi.fn(),
  navigate: vi.fn(),
  user: { id: 'user-a' },
  search: '',
}));
vi.mock('@/common', () => ({
  ipcBridge: { dialog: { showOpen: { invoke: mocks.pick } }, fs: { getImageBase64: { invoke: mocks.image } } },
}));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({ comfyApi: { modelCenter: mocks.load } }));
vi.mock('@/renderer/pages/guid/Creation/modelCenterEntry', () => ({
  startModelCenterInstallation: mocks.install,
  useModelCenterProfile: mocks.use,
}));
vi.mock('@renderer/hooks/context/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ search: mocks.search }),
}));
vi.mock('@/renderer/pages/local-models/ModelPreview', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, args: Record<string, unknown> = {}) => {
      const value = key
        .split('.')
        .slice(1)
        .reduce<unknown>((part, name) => (part as Record<string, unknown>)?.[name], english);
      return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(args[name] ?? name));
    },
  }),
}));

const candidate = (patch: Partial<LocalModelRecommendation> = {}): LocalModelRecommendation => ({
  id: 'unknown-image',
  family: 'z-image',
  name: 'Z-Image',
  kind: 'image',
  purposes: ['image-generation'],
  status: 'unknown',
  reasons: ['hardware-unknown'],
  installed: false,
  profiles: [],
  workflowCount: 0,
  reusedBytes: 0,
  installContext: { checkedAt: '2026-11-11T12:00:00Z', installDirectory: 'D:/models' },
  ...patch,
});
const snapshot = (models = [candidate()]): LocalModelCenterSnapshot => ({
  checkedAt: '2026-11-11T12:00:00Z',
  device: {
    checkedAt: '2026-11-11T12:00:00Z',
    os: 'Windows',
    osRelease: '11',
    arch: 'x64',
    cpu: 'Test CPU',
    totalMemoryBytes: 32 * 1024 ** 3,
    freeMemoryBytes: 20 * 1024 ** 3,
    gpuStatus: 'unknown',
    gpus: [],
    installDirectory: 'D:/models',
  },
  inventory: { profiles: models.flatMap((model) => model.profiles), complete: true, diagnostics: [] },
  recommendations: models.slice(0, 3),
  models,
});

describe('local model center', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    mocks.user.id = 'user-a';
    mocks.search = '';
    mocks.load.mockResolvedValue(snapshot());
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps unknown hardware installable for Agent assessment, without inventing zero capacity', async () => {
    render(<LocalModelsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start installation' }));
    await waitFor(() =>
      expect(mocks.install).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'unknown-image' }),
        expect.objectContaining({ gpuStatus: 'unknown' }),
        mocks.navigate,
        'install'
      )
    );
    expect(screen.getAllByText(/Not measured/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Not measured available')).not.toBeInTheDocument();
    expect(screen.queryByText(/\b0 GB/)).not.toBeInTheDocument();
  });

  it('keeps custom installed families searchable and routes active work back to its conversation', async () => {
    mocks.load.mockResolvedValue(
      snapshot([
        candidate({
          id: 'custom',
          family: 'my-model',
          name: 'Studio model',
          installed: true,
          activity: { conversationId: 'work-1', state: 'running' },
        }),
      ])
    );
    render(<LocalModelsPage />);
    await screen.findByRole('article', { name: 'Studio model' });
    fireEvent.click(screen.getByRole('tab', { name: 'Installed' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models or versions' }), {
      target: { value: 'studio' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'View progress' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/conversation/work-1'));
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('persists only the current account directory and reevaluates the chosen disk', async () => {
    localStorage.setItem('local-models.install-directory:other-user', 'E:/private');
    mocks.pick.mockResolvedValue(['F:/new-models']);
    render(<LocalModelsPage />);
    await screen.findByText('Test CPU');
    expect(mocks.load).toHaveBeenCalledWith(undefined);
    fireEvent.click(screen.getAllByRole('button', { name: 'Choose directory' })[0]);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith('F:/new-models'));
    expect(localStorage.getItem('local-models.install-directory:user-a')).toBe('F:/new-models');
    expect(localStorage.getItem('local-models.install-directory:other-user')).toBe('E:/private');
  });

  it('shows a recoverable load failure and retry loads the actual model library', async () => {
    mocks.load.mockRejectedValueOnce(new Error('offline'));
    render(<LocalModelsPage />);
    await screen.findByText('Could not read local model information.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    await screen.findByRole('article', { name: 'Z-Image' });
    expect(screen.queryByText('Could not read local model information.')).not.toBeInTheDocument();
  });

  it('honors the management link kind filter', async () => {
    mocks.search = '?kind=video';
    mocks.load.mockResolvedValue(
      snapshot([candidate(), candidate({ id: 'video', name: 'Video model', kind: 'video', purposes: ['video'] })])
    );
    render(<LocalModelsPage />);
    await screen.findByRole('article', { name: 'Video model' });
    expect(screen.queryByRole('article', { name: 'Z-Image' })).not.toBeInTheDocument();
  });

  it('ignores a late device response after choosing a different installation disk', async () => {
    let resolveInitial!: (value: LocalModelCenterSnapshot) => void;
    const updated = snapshot();
    updated.device = { ...updated.device, cpu: 'Updated device', installDirectory: 'F:/new-models' };
    mocks.load
      .mockImplementationOnce(
        () =>
          new Promise<LocalModelCenterSnapshot>((resolve) => {
            resolveInitial = resolve;
          })
      )
      .mockResolvedValueOnce(updated);
    mocks.pick.mockResolvedValue(['F:/new-models']);
    render(<LocalModelsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose directory' }));
    await screen.findByText('Updated device');
    await act(async () => {
      resolveInitial(snapshot());
    });
    expect(screen.getByText('Updated device')).toBeInTheDocument();
    expect(screen.queryByText('Test CPU')).not.toBeInTheDocument();
  });

  it('keeps hardware visible during a refresh when returning to the window', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    render(<LocalModelsPage />);
    await screen.findByText('Test CPU');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    mocks.load.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Test CPU')).toBeInTheDocument();
    clock.mockRestore();
  });

  it('keeps workflow details behind the drawer and opens them from a keyboard reachable button', async () => {
    mocks.load.mockResolvedValue(snapshot([candidate({ quantization: 'unconfirmed inspect model metadata' })]));
    render(<LocalModelsPage />);
    const row = await screen.findByRole('article', { name: 'Z-Image' });
    expect(screen.queryByText('Device assessment')).not.toBeInTheDocument();
    expect(screen.queryByText('unconfirmed inspect model metadata')).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'View details' }));
    expect(await screen.findByText('Technical details')).toBeInTheDocument();
    expect(screen.queryByText('Device assessment')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Technical details'));
    expect(await screen.findByText('unconfirmed inspect model metadata')).toBeVisible();
  });
});

describe('model center presentation rules', () => {
  it('distinguishes precisions by registered metadata, including compressed encoders and mixed components', () => {
    for (const [precision, kind] of [
      ['BF16', 'full'],
      ['FP16', 'full'],
      ['FP8', 'fp8'],
      ['INT8-ConvRot', 'int8'],
      ['INT8-ConvRot/W4A8', 'w4a8'],
      ['NVFP4', 'nvfp4'],
      ['INT8 diffusion + NVFP4-AWQ encoder + BF16 lora', 'mixed'],
    ] as const) {
      expect(modelPrecisionGuide(candidate({ quantization: precision }))?.kind).toBe(kind);
    }
    expect(modelPrecisionGuide(candidate({ name: 'model-bf16' }))).toBeUndefined();
    expect(modelPrecisionGuide(candidate({ quantization: 'unconfirmed FP8' }))).toBeUndefined();
  });
  it('uses only a verified local raster artifact for a custom model preview', () => {
    const verified = candidate({
      status: 'verified',
      installed: true,
      verifiedProfileId: 'route-1',
      profiles: [
        {
          id: 'route-1',
          state: 'verified',
          validation: { artifacts: ['https://example.com/sample.png', 'D:/output/clip.mp4', 'D:/output/result.png'] },
        },
      ] as ComfyProfile[],
    });
    expect(verifiedPreviewArtifact(verified)).toBe('D:/output/result.png');
    expect(verifiedPreviewArtifact({ ...verified, status: 'unknown' })).toBeUndefined();
    expect(verifiedPreviewArtifact({ ...verified, verifiedProfileId: 'other-route' })).toBeUndefined();
  });
  it('loads actual custom preview data through sandboxed image IPC and retains fallback on denied reads', async () => {
    const { default: ActualPreview } = await vi.importActual<
      typeof import('@/renderer/pages/local-models/ModelPreview')
    >('@/renderer/pages/local-models/ModelPreview');
    mocks.image
      .mockResolvedValueOnce('data:image/png;base64,iVBORw0KGgo=')
      .mockRejectedValueOnce(new Error('ACCESS_DENIED'));
    const { rerender } = render(
      <ActualPreview family='custom-model' name='Custom' kind='image' artifact='D:/output/result.png' />
    );
    expect(await screen.findByRole('img', { name: 'Custom sample' })).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgo='
    );
    expect(mocks.image).toHaveBeenCalledWith({ path: 'D:/output/result.png' });
    rerender(<ActualPreview family='custom-model' name='Custom' kind='image' artifact='D:/output/missing.png' />);
    await waitFor(() => expect(mocks.image).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('No sample available')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it('lets installed models be used without asking the user to manage validation', () => {
    const profile = { id: 'route-1', state: 'loadable' } as ComfyProfile;
    expect(modelAction(candidate({ installed: true, profiles: [profile] }))).toBe('use');
    expect(
      modelAction(
        candidate({
          status: 'verified',
          verifiedProfileId: 'route-1',
          installed: true,
          profiles: [{ ...profile, state: 'verified' }],
        })
      )
    ).toBe('use');
    expect(modelAction(candidate({ status: 'insufficient' }))).toBe('install');
  });
  it('keeps registered models selectable independently of hardware assessment', () => {
    const profile = { id: 'route-1', state: 'verified' } as ComfyProfile;
    for (const status of ['unknown', 'compatible', 'insufficient'] as const) {
      expect(
        modelAction(candidate({ status, verifiedProfileId: 'route-1', installed: true, profiles: [profile] }))
      ).toBe('use');
    }
    expect(
      modelAction(
        candidate({
          status: 'verified',
          verifiedProfileId: 'route-1',
          installed: true,
          profiles: [{ ...profile, state: 'loadable' }],
        })
      )
    ).toBe('use');
    expect(modelAction(candidate({ status: 'verified', installed: true, profiles: [profile] }))).toBe('use');
    expect(
      modelAction(
        candidate({ status: 'verified', verifiedProfileId: 'missing-route', installed: true, profiles: [profile] })
      )
    ).toBe('use');
  });
  it('searches versions and preserves model grouping without duplicating workflow variants', () => {
    const model = candidate({ profiles: [{ version: 'v2.7' }, { version: 'v2.7' }] as ComfyProfile[] });
    expect(filterModels([model], 'image', 'V2.7')).toEqual([model]);
    expect(filterModels([model], 'video', '')).toEqual([]);
  });
  it('never renders unknown or invalid capacity as zero and clamps measured occupancy', () => {
    expect(formatBytes(undefined, 'en-US', 'unknown')).toBe('unknown');
    expect(formatBytes(NaN, 'en-US', 'unknown')).toBe('unknown');
    expect(usedPercent(undefined, 10)).toBeUndefined();
    expect(usedPercent(100, 25)).toBe(75);
    expect(usedPercent(100, 125)).toBe(0);
  });
});
