import { galleryFixture as catalog } from '../contentCatalog/galleryFixture';
import type { ContentCatalog } from '@/common/contentCatalog/schema';
import update from '@/renderer/services/i18n/locales/zh-CN/update.json';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import CreationTemplates from '@/renderer/pages/guid/components/CreationTemplates';
import guid from '@/renderer/services/i18n/locales/zh-CN/guid.json';
import { useCreationModels } from '@/renderer/pages/guid/Creation/useCreationModels';

vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useProvidersQuery: () => ({
    data: [
      {
        id: 'gemini-images',
        name: 'Gemini',
        platform: 'gemini',
        base_url: '',
        api_key: 'test-key',
        models: ['gemini-2.5-flash'],
      },
    ],
  }),
}));

const renderTemplates = async (data = catalog) => {
  vi.stubGlobal('__APP_VERSION__', '2.2.2');
  const i18n = createInstance();
  await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: { guid, update } } } });
  const onUseTemplate = vi.fn();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <CreationTemplates catalog={data} onUseTemplate={onUseTemplate} />
    </I18nextProvider>
  );
  return {
    ...view,
    onUseTemplate,
    renderCatalog: (data: ContentCatalog) =>
      view.rerender(
        <I18nextProvider i18n={i18n}>
          <CreationTemplates catalog={data} onUseTemplate={onUseTemplate} />
        </I18nextProvider>
      ),
  };
};

describe('CreationTemplates', () => {
  it.each(['unlinked', 'withdrawn', 'revision-mismatch', 'incompatible'] as const)(
    'does not turn a %s showcase into an executable template',
    async (state) => {
      const template = catalog.entries[0];
      if (template.entryType !== 'template') throw Error('fixture');
      const { prompt: _prompt, parameters: _parameters, requiresReference: _reference, ...base } = template;
      const work = {
        ...base,
        id: 'official:showcase',
        entryType: 'showcase' as const,
        media: template.cover,
        title: { 'zh-CN': '官方展示作品' },
        ...(state === 'unlinked'
          ? {}
          : {
              templateRef: {
                id: template.id,
                revision: state === 'revision-mismatch' ? template.revision + 1 : template.revision,
              },
            }),
      };
      const linked =
        state === 'incompatible' ? { ...template, requiredCapabilities: ['unsupported.capability'] } : template;
      const { onUseTemplate } = await renderTemplates({
        ...catalog,
        entries: state === 'withdrawn' ? [work] : [linked, work],
      });
      fireEvent.click(
        within(screen.getByRole('article', { name: '官方展示作品' })).getByRole('button', { name: '查看官方作品' })
      );
      expect(screen.queryByRole('button', { name: '使用同款模板' })).toBeNull();
      expect(onUseTemplate).not.toHaveBeenCalled();
      if (state !== 'unlinked') expect(screen.getByText(update.content.linkUnavailable)).toBeInTheDocument();
    }
  );
  it('retains the current filter and closes obsolete work details on snapshot adoption', async () => {
    const view = await renderTemplates();
    fireEvent.click(screen.getByRole('button', { name: '视频' }));
    view.renderCatalog({ ...catalog, releaseSequence: 1 });
    expect(screen.getByRole('button', { name: '视频' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('article')).toHaveLength(4);
  });
  it('keeps showcase works view-only and offers a generation action only through an exact compatible template link', async () => {
    const template = catalog.entries[0];
    const {
      prompt: _prompt,
      parameters: _parameters,
      requiresReference: _reference,
      ...base
    } = template as import('@/common/contentCatalog/schema').OfficialTemplate;
    const work = {
      ...base,
      id: 'official:showcase',
      entryType: 'showcase' as const,
      media: template.cover,
      title: { 'zh-CN': '官方展示作品' },
      templateRef: { id: template.id, revision: template.revision },
    };
    const { onUseTemplate } = await renderTemplates({ ...catalog, entries: [template, work] });
    const card = within(screen.getByRole('article', { name: '官方展示作品' }));
    expect(card.queryByRole('button', { name: '做同款' })).toBeNull();
    fireEvent.click(card.getByRole('button', { name: '查看官方作品' }));
    expect(onUseTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '使用同款模板' }));
    expect(onUseTemplate).toHaveBeenCalledTimes(1);
  });
  it('offers the same supplemented cloud image models as the existing tool settings', () => {
    const hook = renderHook(() => useCreationModels(false));
    act(() => hook.result.current.setSelection({ kind: 'image', source: 'cloud', modelIds: {} }));
    expect(hook.result.current.models).toContainEqual(
      expect.objectContaining({
        id: 'gemini-images::gemini-2.5-flash-image',
        available: true,
      })
    );
    act(() => hook.result.current.setSelection({ kind: 'video', source: 'local', modelIds: {} }));
    hook.unmount();
  });
  it('shows image examples and playable videos with local posters without preloading every clip', async () => {
    const { container } = await renderTemplates();

    expect(screen.getAllByRole('article')).toHaveLength(52);
    expect(screen.getAllByRole('img')).toHaveLength(48);
    const videos = Array.from(container.querySelectorAll('video'));
    expect(videos).toHaveLength(4);
    for (const video of videos) {
      expect(screen.getByRole('button', { name: `播放 ${video.getAttribute('aria-label')}` })).toBeInTheDocument();
      expect(video.preload).toBe('none');
      expect(video.getAttribute('poster')).toMatch(/\/api\/content-catalog\/assets\/0\/[a-f0-9]{64}$/);
      expect(video.getAttribute('src')).toMatch(/\/api\/content-catalog\/assets\/0\/[a-f0-9]{64}$/);
      expect(video.getAttribute('src')).not.toContain('githubusercontent');
    }
  });

  it('filters images and videos and restores all templates', async () => {
    await renderTemplates();
    fireEvent.click(screen.getByRole('button', { name: '视频' }));
    expect(screen.getAllByRole('article')).toHaveLength(4);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '视频' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '图片' }));
    expect(screen.getAllByRole('article')).toHaveLength(48);

    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(screen.getAllByRole('article')).toHaveLength(52);
  });

  it('fills the complete image or video prompt when using the corresponding template', async () => {
    const { onUseTemplate } = await renderTemplates();
    const firstImage = screen.getByRole('article', { name: guid.templates.poster.title });
    fireEvent.click(within(firstImage).getByRole('button', { name: '做同款' }));
    expect(onUseTemplate).toHaveBeenLastCalledWith(
      guid.templates.poster.prompt,
      expect.objectContaining({ kind: 'image' })
    );

    fireEvent.click(screen.getByRole('button', { name: '视频' }));
    const firstVideo = screen.getAllByRole('article')[0];
    fireEvent.click(within(firstVideo).getByRole('button', { name: '做同款' }));
    expect(onUseTemplate.mock.calls.at(-1)?.[0]).toContain('6 秒');
    expect(onUseTemplate.mock.calls.at(-1)?.[0]).toContain('视频');
  });

  it('keeps the template usable when its image preview fails', async () => {
    const { onUseTemplate } = await renderTemplates();
    const card = screen.getByRole('article', { name: guid.templates.poster.title });
    fireEvent.error(within(card).getByRole('img'));
    expect(within(card).getByText('预览暂不可用')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: '做同款' }));
    expect(onUseTemplate).toHaveBeenCalledWith(
      guid.templates.poster.prompt,
      expect.objectContaining({ kind: 'image' })
    );
  });

  it('keeps the video prompt available after a playback error', async () => {
    const { onUseTemplate, container } = await renderTemplates();
    fireEvent.click(screen.getByRole('button', { name: '视频' }));
    fireEvent.error(container.querySelector('video')!);
    const card = screen.getAllByRole('article')[0];
    expect(within(card).getByText('预览暂不可用')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: '做同款' }));
    expect(onUseTemplate).toHaveBeenCalledWith(guid.templates.coast.prompt, expect.objectContaining({ kind: 'video' }));
  });

  it('identifies portrait references and fills the complete curated prompt without generating on selection', async () => {
    const { onUseTemplate } = await renderTemplates();
    const card = screen.getByRole('article', { name: 'AI 衣品升级改造报告' });
    expect(within(card).getByText('需参考图')).toBeInTheDocument();
    expect(within(card).getByRole('img').getAttribute('src')).toContain('/api/content-catalog/assets/0/');
    fireEvent.click(within(card).getByRole('button', { name: '做同款' }));
    expect(onUseTemplate).toHaveBeenCalledTimes(1);
    const [prompt, template] = onUseTemplate.mock.calls[0];
    expect(template).toMatchObject({ kind: 'image', ratio: '4:3', requiresReference: true });
    expect(prompt).toContain('若未上传参考图，请先提示我上传');
    expect(prompt).toContain('Before vs After');
    expect(prompt).toContain('9) 总结 / Summary');
    expect(prompt.length).toBeGreaterThan(2000);
  });

  it('keeps the authored 6:7 fantasy composition consistent with the template card', async () => {
    const { onUseTemplate } = await renderTemplates();
    const card = screen.getByRole('article', { name: '月亮邮局' });
    fireEvent.click(within(card).getByRole('button', { name: '做同款' }));
    const [prompt, template] = onUseTemplate.mock.calls[0];
    expect(template.ratio).toBe('6:7');
    expect(prompt).toContain('6:7');
    expect(prompt).toContain('收件人：星河');
    expect(prompt).not.toContain('2:3');
  });
});
