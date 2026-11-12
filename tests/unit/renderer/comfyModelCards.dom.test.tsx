import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import { getComfyModelSetId } from '@/common/chat/document/creation/workflows/identity';
import ComfyModelCards from '@/renderer/pages/guid/components/ComfyModelCards';
import { galleryFixture } from '../contentCatalog/galleryFixture';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, values?: Record<string, string>) =>
      `${key}${values ? `: ${Object.values(values).join(', ')}` : ''}`,
  }),
}));
const profile = (id: string, state: ComfyProfile['state']) =>
  ({ id, name: id, family: 'qwen-edit', kind: 'image', state, version: '2509', quantization: 'FP8' }) as ComfyProfile;

const h3Profile = (id = 'h3-sample') => ({ ...profile(id, 'verified'), family: 'h3', kind: 'video' }) as ComfyProfile;
const omniProfile = (id = 'fasth3-omni-v1') =>
  ({ ...profile(id, 'verified'), family: 'fasth3-omni', kind: 'video' }) as ComfyProfile;

beforeEach(() => vi.stubGlobal('__APP_VERSION__', '3.0.0'));

describe('ComfyUI family cards', () => {
  it('keeps workflow states and repair diagnostics behind one details action', () => {
    const base = {
      ...profile('qwen-verified', 'verified'),
      components: [
        {
          role: 'diffusion',
          name: 'qwen',
          path: 'C:/models/qwen',
          version: '2509',
          precision: 'FP8',
          sha256: 'a'.repeat(64),
        },
      ],
      capabilities: ['image-edit'],
      environment: { root: 'C:/ComfyUI', python: 'C:/python.exe', baseUrl: 'http://127.0.0.1:8188' },
    };
    render(
      <ComfyModelCards
        profiles={[
          base,
          {
            ...base,
            id: 'qwen-broken-route',
            state: 'invalid',
            validation: { checkedAt: 'today', fingerprint: 'broken', error: 'Missing node' },
          },
        ]}
        workflowPreparations={[
          {
            modelSetId: getComfyModelSetId(base),
            profileId: base.id,
            workflowId: 'qwen-inpaint',
            tasks: ['inpaint'],
            reason: 'Mask dependency missing',
            additionalBytes: 2_000_000,
          },
        ]}
        onAction={vi.fn()}
        onUseProfile={vi.fn()}
      />
    );
    const card = within(screen.getByRole('region', { name: 'Qwen-Edit' }));
    expect(card.queryByLabelText('guid.comfy.version: Qwen-Edit')).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: 'guid.comfy.use' })).toBeEnabled();
    expect(card.queryByText(/guid.comfy.workflows.states.needs-repair/)).not.toBeInTheDocument();
    expect(card.queryByText(/guid.comfy.workflows.states.needs-preparation/)).not.toBeInTheDocument();
    expect(card.getAllByRole('status')).toHaveLength(1);
    expect(card.queryByRole('button', { name: 'guid.comfy.actions.repair' })).not.toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'guid.comfy.workflows.details' }));
    fireEvent.click(screen.getByText(/guid.comfy.workflows.tasks.inpaint/));
    expect(screen.getByText('Mask dependency missing')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/guid.comfy.workflows.states.needs-repair/));
    expect(screen.getByText('Missing node')).toBeInTheDocument();
    expect(screen.getByText('guid.comfy.workflows.environment: C:/ComfyUI')).toBeInTheDocument();
  });

  it('retains verified cards and keeps missing cards unknown during a partial scan', () => {
    render(
      <ComfyModelCards
        profiles={[profile('qwen-verified', 'verified')]}
        incomplete
        onAction={vi.fn()}
        onUseProfile={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'guid.comfy.use' })).toBeEnabled();
    expect(screen.queryAllByText('guid.creation.states.not-installed')).toHaveLength(0);
    expect(screen.getAllByText('guid.creation.states.unavailable').length).toBeGreaterThan(0);
  });
  it.each(['empty', 'partial'] as const)(
    'retains supported families and local actions for a %s remote catalog',
    (mode) => {
      const onAction = vi.fn();
      const onUseProfile = vi.fn();
      const installed = h3Profile();
      const card = galleryFixture.models.find((model) => model.family === 'qwen-edit')!;
      render(
        <ComfyModelCards
          catalog={{ ...galleryFixture, releaseSequence: 1, models: mode === 'empty' ? [] : [card] }}
          profiles={[installed]}
          onAction={onAction}
          onUseProfile={onUseProfile}
        />
      );
      expect(screen.getAllByRole('region')).toHaveLength(8);
      const h3 = within(screen.getByRole('region', { name: 'H3' }));
      expect(h3.getByLabelText('guid.comfy.preview.video: H3')).toBeInTheDocument();
      fireEvent.click(h3.getByRole('button', { name: 'guid.comfy.use' }));
      expect(onUseProfile).toHaveBeenCalledWith(installed);
      fireEvent.click(h3.getByRole('button', { name: 'guid.comfy.workflows.details' }));
      fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.actions.repair' }));
      expect(onAction).toHaveBeenCalledWith({ family: 'h3', intent: 'repair', profileId: installed.id });
      fireEvent.click(
        within(screen.getByRole('region', { name: 'Krea 2' })).getByRole('button', {
          name: 'guid.comfy.actions.install',
        })
      );
      expect(onAction).toHaveBeenCalledWith({ family: 'krea2', intent: 'install', profileId: undefined });
    }
  );

  it.each(['h3', 'fasth3-omni'] as const)(
    'keeps the real %s video sample visible when the remote catalog supplies a cover',
    async (family) => {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      const card = galleryFixture.models.find((model) => model.family === family)!;
      const props = { profiles: [], onAction: vi.fn(), onUseProfile: vi.fn() };
      const view = render(<ComfyModelCards {...props} catalog={galleryFixture} />);
      try {
        const region = within(screen.getByRole('region', { name: card.name }));
        const bundled = region.getByLabelText(`guid.comfy.preview.video: ${card.name}`);
        const source = bundled.getAttribute('src');
        const poster = bundled.getAttribute('poster');
        view.rerender(<ComfyModelCards {...props} catalog={{ ...galleryFixture, releaseSequence: 1 }} />);
        expect(screen.getAllByRole('region')).toHaveLength(8);
        const video = region.getByLabelText(`guid.comfy.preview.video: ${card.name}`);
        expect(region.queryByRole('img')).not.toBeInTheDocument();
        fireEvent.mouseEnter(video.parentElement!);
        expect(play).toHaveBeenCalled();
        const sample = family === 'h3' ? 'guid.comfy.preview.projectDemo' : 'guid.comfy.preview.officialSample';
        fireEvent.click(region.getByRole('button', { name: 'guid.comfy.preview.play' }));
        expect(video).toHaveAttribute('src', source);
        expect(video).toHaveAttribute('poster', poster);
        expect(video.getAttribute('poster')).not.toContain('/api/content-catalog/');
        await waitFor(() => expect(play).toHaveBeenCalled());
        expect(region.getByText(sample)).toBeInTheDocument();
        if (family === 'fasth3-omni') {
          expect(region.getByRole('link')).toHaveAttribute('href', 'https://nuvalab.ai/fasth3/');
          expect(region.getByRole('link')).toHaveAttribute(
            'title',
            'guid.comfy.preview.sampleVersion: FastH3-Omni-8-Step-V1'
          );
        }
        view.rerender(<ComfyModelCards {...props} catalog={{ ...galleryFixture, releaseSequence: 2 }} />);
        expect(region.getByLabelText(`guid.comfy.preview.video: ${card.name}`)).toHaveAttribute('src', source);
        expect(region.queryByRole('img')).not.toBeInTheDocument();
      } finally {
        view.unmount();
        play.mockRestore();
      }
    }
  );

  it('does not invent bundled playback for remote image cards or unknown families', () => {
    const imageCards = galleryFixture.models.filter((model) => model.kind === 'image');
    const unknown = {
      ...galleryFixture.models[0],
      id: 'official:model-unknown',
      family: 'unknown-family',
      name: 'Unknown video family',
    };
    const { container } = render(
      <ComfyModelCards
        profiles={[]}
        onAction={vi.fn()}
        onUseProfile={vi.fn()}
        catalog={{ ...galleryFixture, releaseSequence: 1, models: [...imageCards, unknown] }}
      />
    );
    expect(container.querySelectorAll('video')).toHaveLength(2);
    expect(screen.queryAllByRole('button', { name: /guid.comfy.preview.play/ })).toHaveLength(2);
    expect(screen.getAllByRole('region')).toHaveLength(8);
    expect(screen.queryByRole('region', { name: 'Unknown video family' })).not.toBeInTheDocument();
  });

  it('releases and reattaches video observers when switching between local and remote covers', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const observers = new Map<
      Element,
      { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }
    >();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        disconnect = vi.fn();
        constructor(readonly callback: IntersectionObserverCallback) {}
        observe(element: Element) {
          observers.set(element, this);
        }
      }
    );
    const props = { profiles: [], onAction: vi.fn(), onUseProfile: vi.fn() };
    const view = render(<ComfyModelCards {...props} catalog={galleryFixture} />);
    try {
      const preview = () =>
        within(screen.getByRole('region', { name: 'H3' })).getByLabelText('guid.comfy.preview.video: H3');
      const first = preview();
      Object.defineProperty(first, 'paused', { value: false, configurable: true });
      const firstObserver = observers.get(first)!;
      expect(firstObserver).toBeDefined();
      view.rerender(<ComfyModelCards {...props} catalog={{ ...galleryFixture, releaseSequence: 1 }} />);
      expect(firstObserver.disconnect).toHaveBeenCalledOnce();
      expect(pause.mock.instances).toContain(first);

      view.rerender(<ComfyModelCards {...props} catalog={galleryFixture} />);
      const restored = preview();
      Object.defineProperty(restored, 'paused', { value: false, configurable: true });
      expect(restored).not.toBe(first);
      const restoredObserver = observers.get(restored)!;
      expect(restoredObserver).toBeDefined();
      pause.mockClear();
      restoredObserver.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
      expect(pause.mock.instances).toContain(restored);
      view.unmount();
      expect(restoredObserver.disconnect).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
      pause.mockRestore();
    }
  });

  it('preserves every supported family and the real video preview in the offline catalog', () => {
    render(<ComfyModelCards catalog={galleryFixture} profiles={[]} onAction={vi.fn()} onUseProfile={vi.fn()} />);
    expect(screen.getAllByRole('region')).toHaveLength(galleryFixture.models.length);
    expect(
      within(screen.getByRole('region', { name: 'H3' })).getByLabelText('guid.comfy.preview.video: H3')
    ).toBeInTheDocument();
  });

  it('applies remote description and cover metadata without altering the installed model profile', () => {
    const installed = profile('local-qwen', 'verified');
    const onUse = vi.fn();
    const original = structuredClone(installed);
    const card = galleryFixture.models.find((model) => model.family === 'qwen-edit')!;
    const catalog = {
      ...galleryFixture,
      releaseSequence: 10,
      models: [
        { ...card, name: 'Qwen official revision 2', description: { 'zh-CN': 'Updated official introduction' } },
      ],
    };
    render(<ComfyModelCards catalog={catalog} profiles={[installed]} onAction={vi.fn()} onUseProfile={onUse} />);
    const region = within(screen.getByRole('region', { name: 'Qwen official revision 2' }));
    expect(region.getByText('Updated official introduction')).toBeInTheDocument();
    expect(region.getByRole('img', { name: 'guid.comfy.preview.image: Qwen official revision 2' })).toHaveAttribute(
      'src',
      `/api/content-catalog/assets/10/${card.cover}`
    );
    expect(region.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(region.getByRole('button', { name: 'guid.comfy.use' }));
    expect(onUse).toHaveBeenCalledWith(installed);
    expect(installed).toEqual(original);
  });
  it.each([
    ['flux-3-image-klein', 'FLUX 3 Image Klein'],
    ['moss-image-base', 'MOSS-Image-Base'],
    ['moss-image-sft', 'MOSS-Image-SFT'],
    ['krea2', 'Krea 2'],
  ] as const)('routes %s installation and verified use while showing its actual sample', (family, name) => {
    const onAction = vi.fn();
    const onUseProfile = vi.fn();
    const { rerender } = render(<ComfyModelCards profiles={[]} onAction={onAction} onUseProfile={onUseProfile} />);
    const card = within(screen.getByRole('region', { name }));
    expect(card.getByRole('img', { name: `guid.comfy.preview.image: ${name}` })).toHaveAttribute('src');
    expect(card.getByRole('link')).toHaveAttribute(
      'href',
      family === 'moss-image-sft'
        ? 'https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT'
        : expect.stringContaining('Comfy-Org/workflow_templates')
    );
    fireEvent.click(card.getByRole('button', { name: 'guid.comfy.actions.install' }));
    expect(onAction).toHaveBeenCalledWith({ family, intent: 'install', profileId: undefined });
    expect(card.queryByRole('button', { name: 'guid.comfy.use' })).not.toBeInTheDocument();
    const installed = { ...profile(`${family}-local`, 'verified'), family };
    rerender(<ComfyModelCards profiles={[installed]} onAction={onAction} onUseProfile={onUseProfile} />);
    fireEvent.click(card.getByRole('button', { name: 'guid.comfy.use' }));
    expect(onUseProfile).toHaveBeenCalledWith(installed);
  });

  it('shows a muted H3 video preview with an accessible playback toggle', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<ComfyModelCards profiles={[h3Profile()]} onAction={vi.fn()} onUseProfile={vi.fn()} />);

    const preview = within(screen.getByRole('region', { name: 'H3' })).getByLabelText('guid.comfy.preview.video: H3', {
      selector: 'video',
    }) as HTMLVideoElement;
    expect(preview.muted).toBe(true);
    expect(preview.getAttribute('poster')).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('region', { name: 'H3' })).getByRole('button', { name: 'guid.comfy.preview.play' })
    );
    await waitFor(() => expect(play).toHaveBeenCalled());
    play.mockRestore();
  });

  it('falls back to the bundled poster after a video preview fails', () => {
    render(<ComfyModelCards profiles={[h3Profile()]} onAction={vi.fn()} onUseProfile={vi.fn()} />);
    fireEvent.error(
      within(screen.getByRole('region', { name: 'H3' })).getByLabelText('guid.comfy.preview.video: H3', {
        selector: 'video',
      })
    );
    expect(
      within(screen.getByRole('region', { name: 'H3' })).getByRole('img', { name: 'guid.comfy.preview.poster: H3' })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'H3' })).queryByLabelText('guid.comfy.preview.video: H3', {
        selector: 'video',
      })
    ).not.toBeInTheDocument();
  });

  it('plays a muted preview on hover and pauses when the pointer leaves', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    render(<ComfyModelCards profiles={[]} onAction={vi.fn()} onUseProfile={vi.fn()} />);
    const preview = within(screen.getByRole('region', { name: 'H3' })).getByLabelText('guid.comfy.preview.video: H3');
    fireEvent.mouseEnter(preview.parentElement!);
    expect(play).toHaveBeenCalledOnce();
    fireEvent.mouseLeave(preview.parentElement!);
    expect(pause).toHaveBeenCalledOnce();
    play.mockRestore();
    pause.mockRestore();
  });

  it('labels the FastH3-Omni preview as an official Nuva sample and identifies its model version', () => {
    render(<ComfyModelCards profiles={[omniProfile()]} onAction={vi.fn()} onUseProfile={vi.fn()} />);
    expect(screen.getByText('guid.comfy.preview.officialSample')).toBeInTheDocument();
    expect(screen.getByTitle('guid.comfy.preview.sampleVersion: FastH3-Omni-8-Step-V1')).toBeInTheDocument();
    expect(screen.queryByText('guid.comfy.preview.runtimeVersion: 2509')).not.toBeInTheDocument();
  });

  it('pauses a preview when the document becomes hidden', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    render(<ComfyModelCards profiles={[h3Profile()]} onAction={vi.fn()} onUseProfile={vi.fn()} />);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pause).toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    pause.mockRestore();
  });

  it('pauses a preview when it leaves the visible viewport', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    let observeVisibility: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          observeVisibility = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    render(<ComfyModelCards profiles={[h3Profile()]} onAction={vi.fn()} onUseProfile={vi.fn()} />);
    observeVisibility?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(pause).toHaveBeenCalled();
    vi.unstubAllGlobals();
    pause.mockRestore();
  });

  it('shows official outputs of the image models with their source and sample version', () => {
    render(
      <ComfyModelCards profiles={[profile('qwen-sample', 'verified')]} onAction={vi.fn()} onUseProfile={vi.fn()} />
    );
    const card = within(screen.getByRole('region', { name: 'Qwen-Edit' }));
    expect(card.getByRole('img', { name: 'guid.comfy.preview.image: Qwen-Edit' })).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'guid.comfy.preview.officialImageSample: Qwen' })).toHaveAttribute(
      'href',
      expect.stringContaining('Qwen-Image-Edit-2509.md')
    );
    expect(card.getByTitle('guid.comfy.preview.sampleVersion: Qwen-Image-Edit-2509')).toBeInTheDocument();
    const z = within(screen.getByRole('region', { name: 'Z-Image' }));
    expect(z.getByRole('link', { name: 'guid.comfy.preview.officialImageSample: Tongyi-MAI' })).toHaveAttribute(
      'href',
      expect.stringContaining('Tongyi-MAI/Z-Image')
    );
    expect(z.getByTitle('guid.comfy.preview.sampleVersion: Z-Image-Turbo')).toBeInTheDocument();
  });

  it('uses the installation action when no model profile is installed', () => {
    const onAction = vi.fn();
    render(<ComfyModelCards profiles={[]} onAction={onAction} onUseProfile={vi.fn()} />);
    const card = within(screen.getByRole('region', { name: 'FastH3-Omni' }));
    fireEvent.click(card.getByRole('button', { name: 'guid.comfy.actions.install' }));
    expect(onAction).toHaveBeenCalledWith({ family: 'fasth3-omni', intent: 'install', profileId: undefined });
    expect(card.getByRole('status')).toHaveTextContent('guid.creation.states.not-installed');
  });

  it('lets keyboard users play and pause a sample with the native button', async () => {
    const user = userEvent.setup();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    render(<ComfyModelCards profiles={[]} onAction={vi.fn()} onUseProfile={vi.fn()} />);
    const card = within(screen.getByRole('region', { name: 'H3' }));
    card.getByRole('button', { name: 'guid.comfy.preview.play' }).focus();
    await user.keyboard('{Enter}');
    expect(play).toHaveBeenCalled();
    fireEvent.play(card.getByLabelText('guid.comfy.preview.video: H3'));
    await user.keyboard(' ');
    expect(pause).toHaveBeenCalled();
    play.mockRestore();
    pause.mockRestore();
  });

  it('uses the accessible library selector to browse versions and repairs the selected unavailable profile', async () => {
    const onAction = vi.fn();
    const onUse = vi.fn();
    const { container } = render(
      <ComfyModelCards
        profiles={[profile('qwen-verified', 'verified'), profile('qwen-downloaded', 'downloaded')]}
        onAction={onAction}
        onUseProfile={onUse}
      />
    );
    expect(container.querySelector('select')).toBeNull();
    const qwen = within(screen.getByRole('region', { name: 'Qwen-Edit' }));
    fireEvent.click(qwen.getByRole('button', { name: 'guid.comfy.workflows.details' }));
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText(/qwen-downloaded · 2509 · FP8/));
    expect(qwen.getByRole('button', { name: 'guid.comfy.use' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'guid.comfy.actions.repair' }));
    expect(onAction).toHaveBeenCalledWith({ family: 'qwen-edit', intent: 'repair', profileId: 'qwen-downloaded' });
    expect(onUse).not.toHaveBeenCalled();
  });

  it('keeps use unavailable until the inventory check succeeds', () => {
    render(
      <ComfyModelCards
        profiles={[profile('qwen-verified', 'verified')]}
        unavailable
        onAction={vi.fn()}
        onUseProfile={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'guid.comfy.use' })).toBeDisabled();
  });

  it.each(['image', 'video'] as const)(
    'shows an Agent-registered custom %s model and selects it before validation',
    (kind) => {
      const custom = {
        ...profile(`custom-${kind}`, 'downloaded'),
        family: `custom-${kind}`,
        name: `Custom ${kind}`,
        kind,
      };
      const use = vi.fn();
      render(<ComfyModelCards profiles={[custom]} onAction={vi.fn()} onUseProfile={use} />);
      const card = within(screen.getByRole('region', { name: custom.name }));
      expect(card.getByRole('status')).toHaveTextContent('guid.creation.states.installed');
      expect(card.queryByRole('img')).not.toBeInTheDocument();
      fireEvent.click(card.getByRole('button', { name: 'guid.comfy.use' }));
      expect(use).toHaveBeenCalledWith(custom);
    }
  );
});
