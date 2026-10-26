import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { comfyFamilyRecipeKey } from '@/renderer/pages/guid/Creation/comfyDraft';

const localeRoot = path.resolve('packages/desktop/src/renderer/services/i18n/locales');
const locales = fs
  .readdirSync(localeRoot)
  .filter((locale) => fs.existsSync(path.join(localeRoot, locale, 'guid.json')));
const load = (locale: string) =>
  JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'guid.json'), 'utf8')) as {
    comfy: {
      prompts: Record<'install' | 'repair' | 'install-other', string>;
      intentSummary: string;
      recipes: Record<string, string>;
      families: Record<string, string>;
    };
  };

describe('ComfyUI install prompts', () => {
  it('makes approval conditional on the active session mode in every install and repair prompt', () => {
    const phrases: Record<string, string> = {
      'zh-CN': '全自动审批',
      'zh-TW': '全自動核准',
      'en-US': 'full automatic approval',
      'de-DE': 'vollautomatischer Freigabe',
      'es-ES': 'aprobación totalmente automática',
      'fa-IR': 'تأیید کاملاً خودکار',
      'fr-FR': 'approbation entièrement automatique',
      'ja-JP': '完全自動承認',
      'ko-KR': '완전 자동 승인',
      'pt-BR': 'aprovação totalmente automática',
      'ru-RU': 'полностью автоматическом одобрении',
      'tr-TR': 'tam otomatik onay',
      'uk-UA': 'повністю автоматичному схваленні',
    };
    for (const locale of locales)
      for (const prompt of Object.values(load(locale).comfy.prompts)) {
        expect(prompt, locale).toContain(phrases[locale]);
      }
  });
  it('keeps every locale focused on the chosen family and an actionable installation handoff', () => {
    expect(locales.length).toBeGreaterThanOrEqual(13);
    for (const locale of locales) {
      const { comfy } = load(locale);
      for (const intent of ['install', 'repair', 'install-other'] as const) {
        const prompt = comfy.prompts[intent];
        const label = `${locale} ${intent}`;
        for (const token of [
          '{{family}}',
          'comfyui-local',
          'openh3_comfy_environment',
          'openh3_comfy_install',
          'action=request',
          'comfyOperationId',
          'SHA-256',
          'ModelScope',
        ]) {
          expect(prompt, label).toContain(token);
        }
        // Family-specific details belong to the selected Skill guide, not every card.
        expect(prompt, label).not.toMatch(/FastH3-Omni|NVFP4|Turbo LoRA|H3.*Z-Image/);
        expect(prompt.length, label).toBeLessThan(1600);
      }
      expect(comfy.intentSummary.length, locale).toBeLessThan(450);
    }
  });

  it('preserves the new image families and their specific component/workflow recipes', () => {
    const families = ['flux-3-image-klein', 'moss-image-base', 'moss-image-sft', 'krea2'] as const;
    for (const locale of locales) {
      const { comfy } = load(locale);
      for (const family of families) {
        expect(comfyFamilyRecipeKey(family)).toBe(`guid.comfy.recipes.${family}`);
        expect(comfy.families[family]?.length, `${locale} ${family}`).toBeGreaterThan(1);
        expect(comfy.recipes[family], `${locale} ${family}`).toContain('comfyui-local');
        expect(comfy.recipes[family], `${locale} ${family}`).toContain(`references/z-image.md#${family}`);
        expect(comfy.recipes[family], `${locale} ${family}`).toContain('BF16');
        expect(comfy.recipes[family], `${locale} ${family}`).toContain('INT8-ConvRot');
      }
      expect(comfy.recipes['flux-3-image-klein']).toContain('steps=16');
      expect(comfy.recipes['moss-image-base']).toContain('moss_image');
      expect(comfy.recipes['moss-image-sft']).toContain('moss_image');
      expect(comfy.recipes.krea2).toContain('steps=8');
    }
  });

  it('does not add a second verbal confirmation through the Chinese installation summary', () => {
    const { comfy } = load('zh-CN');
    expect(comfy.intentSummary).not.toMatch(/等待我确认|等我确认|先制定/);
    expect(comfy.prompts.install).toContain('安装卡');
    expect(comfy.prompts.install).toContain('安装后');
  });
});
