import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const skillRoot = path.resolve('resources/skills/comfyui-local');

describe('ComfyUI attachment-derived guidance', () => {
  it('routes missing reference capabilities through diagnosis and a validated variant in the same conversation', () => {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/baseline.*not.*capability ceiling/i);
    expect(skill).toMatch(/registered variants.*local workflow/i);
    expect(skill).toMatch(/original request and references/i);
    expect(skill).toContain('action=adopt-repair');
    expect(skill).toMatch(/Merely adding LoadImage does not create.*identity preservation/i);
    expect(skill).toMatch(/native.*video\/audio.*Omni/i);
    expect(skill).toMatch(/do not remove.*rejection|do not bypass.*rejection/i);
    expect(skill).toMatch(/general-tool.*openh3_comfy_observe_prompt/i);
  });

  it('provides sourced Z-Image capability routes without promising structural control preserves identity', () => {
    const guide = fs.readFileSync(path.join(skillRoot, 'references', 'z-image.md'), 'utf8');
    expect(guide).toContain('ZImageImg2ImgPipeline');
    expect(guide).toContain('image_z_image_turbo_fun_union_controlnet');
    expect(guide).toContain('ModelPatchLoader');
    expect(guide).toContain('QwenImageDiffsynthControlnet');
    expect(guide).toContain('https://docs.comfy.org/tutorials/image/z-image/z-image-turbo');
    expect(guide).toContain('https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.0');
    expect(guide).toMatch(/structural control.*not.*identity preservation/i);
    expect(guide).toMatch(/Z-Image-Edit.*release.*availability/i);
    expect(guide).toMatch(/original request.*references.*aspect ratio/i);
    expect(guide).not.toContain('Inspect capability and input schemas before accepting that request.');
  });

  it('continues the real goal through runtime diagnosis instead of yielding or repeating a failed submission', () => {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const h3 = fs.readFileSync(path.join(skillRoot, 'references', 'h3.md'), 'utf8');
    expect(skill).not.toMatch(/yield while it runs/i);
    expect(skill).toMatch(/same operation.*spaced.*status|status.*same operation.*spaced/i);
    expect(skill).toMatch(/stopPolling.*failed attempt.*goal/i);
    expect(skill).toMatch(/unchanged.*error.*diagnos|diagnos.*unchanged.*error/i);
    expect(h3).toContain('H3_ACCELERATION_DEPENDENCIES_MISSING');
    expect(h3).toContain('ACCELERATION_INSTALL_FAILED');
    expect(h3).toContain('openh3_h3_acceleration_status');
    expect(h3).toMatch(/diagnosticLogPath|diagnostic log/i);
    expect(h3).toMatch(/dense.*does not prove|does not prove.*dense/i);
    expect(h3).toMatch(/actual.*interpreter|selected.*Python/i);
    expect(h3).toMatch(/continue.*repair|repair.*continue/i);
  });
  it('requires raw ComfyUI generation to be handed back to chat before ending the turn', () => {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const adapters = fs.readFileSync(path.join(skillRoot, 'references', 'tooling-adapters.md'), 'utf8');
    for (const text of [skill, adapters]) {
      expect(text).toContain('openh3_comfy_observe_prompt');
      expect(text).toMatch(/do not end the turn.*raw.*submission/i);
      expect(text).toMatch(/same prompt/i);
      expect(text).toMatch(/absolute.*path/i);
    }
  });
  it('keeps general-tool execution available without preferring the managed installer in a supporting reference', () => {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const adapters = fs.readFileSync(path.join(skillRoot, 'references', 'tooling-adapters.md'), 'utf8');
    expect(skill).toMatch(/same reasoning and execution strategy as a direct chat request/i);
    expect(skill).toMatch(/fixed installer is an optional executor/i);
    expect(skill).toMatch(/Confirm terminal state before taking over/i);
    expect(skill).toMatch(/Full automatic mode needs no extra chat confirmation/i);
    expect(adapters).not.toMatch(/Prefer OpenH3's managed installation/i);
    expect(adapters).toMatch(/not a prerequisite for general tools/i);
    expect(adapters).toMatch(/equivalent permitted HTTPS probes/i);
    expect(adapters).toMatch(/bounded parallel transfers/i);
    expect(adapters).toMatch(/timeout does not prove that a process stopped/i);
    expect(adapters).toMatch(/do not invent OpenH3 operation\/job IDs/i);
  });

  it('includes safe local-generation preflight and bounded OOM guidance', () => {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const operations = fs.readFileSync(path.join(skillRoot, 'references', 'environment-and-repair.md'), 'utf8');
    expect(skill).toMatch(/queue|队列/i);
    expect(skill).toMatch(/object_info/i);
    expect(operations).toMatch(/one image|single image|单张|逐张/i);
    expect(operations).toMatch(/OOM|显存不足/i);
    expect(operations).toMatch(/retry OOM once|最多重试一次/i);
    expect(operations).toMatch(/history|输出文件|output/i);
  });

  it('keeps attachment-specific paths and unsafe download shortcuts out of the bundled skill', () => {
    const files = fs
      .readdirSync(skillRoot, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? fs.readdirSync(path.join(skillRoot, entry.name)).map((child) => path.join(skillRoot, entry.name, child))
          : [path.join(skillRoot, entry.name)]
      )
      .filter((file) => fs.statSync(file).isFile());
    const content = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(content).not.toContain('C:\\Users\\zhang\\AppData\\Local\\Comfy-Desktop');
    expect(content).not.toContain('D:\\ComfyUI-Qwen21-extract');
    expect(content).not.toMatch(/curl\.exe\s+-L\s+--fail/i);
    expect(content).not.toMatch(/uv\.exe\s+pip\s+install/i);
  });

  it('documents the Qwen family boundary and source-evidence requirement', () => {
    const adoption = fs.readFileSync(path.join(skillRoot, 'references', 'attachment-adoption.md'), 'utf8');
    expect(adoption).toMatch(/Qwen Image 2\.1.*不是 Qwen-Edit/s);
    expect(adoption).toMatch(/hf-mirror\.com/);
    expect(adoption).toMatch(/固定仓库.*revision.*SHA-256/s);
    expect(adoption).toMatch(/最多重试一次|at most one/i);
  });
});
