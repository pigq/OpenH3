import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const skillRoot = path.resolve('resources/skills/comfyui-local');

describe('ComfyUI attachment-derived guidance', () => {
  it('allows a bounded general-tool fallback when the managed installer is unavailable', () => {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const adapters = fs.readFileSync(path.join(skillRoot, 'references', 'tooling-adapters.md'), 'utf8');
    expect(skill).toMatch(/preferred product integration, not the only way/i);
    expect(skill).toMatch(/general-tool fallback/i);
    expect(skill).toMatch(/active or unresolved operation/i);
    expect(skill).toMatch(/full automatic mode, do not add a chat confirmation/i);
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
