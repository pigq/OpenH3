import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = path.resolve(
  'core/crates/openh3-app/assets/builtin-skills/xiaohongshu-recruiter/scripts/generate_images.js'
);

function run(config?: object) {
  const writes: string[] = [];
  const drawing = new Proxy(
    { measureText: () => ({ width: 10 }) },
    { get: (target, name) => Reflect.get(target, name) ?? (() => undefined) }
  );
  const context = {
    __dirname: path.dirname(script),
    console: { log: () => {}, warn: () => {} },
    process: { argv: ['node', script, ...(config ? ['job.json', 'artifacts'] : [])], env: {}, cwd: () => '/work' },
    require: (name: string) => {
      if (name === 'canvas')
        return { createCanvas: () => ({ getContext: () => drawing, toBuffer: () => Buffer.from('png') }) };
      if (name === 'path') return path;
      if (name === 'fs')
        return {
          existsSync: () => false,
          readFileSync: () => JSON.stringify(config),
          mkdirSync: () => {},
          writeFileSync: (file: string) => writes.push(file),
        };
      throw new Error(`Unexpected import ${name}`);
    },
  };
  return { execute: () => vm.runInNewContext(readFileSync(script, 'utf8'), context), writes };
}

describe('recruitment artwork inputs', () => {
  it('rejects missing job inputs before writing either image', () => {
    const task = run();
    expect(task.execute).toThrow(/job.*JSON|Usage/i);
    expect(task.writes).toEqual([]);
  });
  it('renders both images from supplied facts into the requested output directory', () => {
    const task = run({
      roleTitle: '前端工程师',
      roleDesc: '开发用户界面',
      responsibilities: ['实现页面'],
      requirements: ['熟悉 TypeScript'],
      contact: '私信联系',
    });
    task.execute();
    expect(task.writes.map((file) => path.basename(file))).toEqual(['cover.png', 'jd_details.png']);
    expect(task.writes.every((file) => path.dirname(file) === path.resolve('artifacts'))).toBe(true);
  });
  it('does not fabricate missing contact details', () => {
    const task = run({ roleTitle: '工程师', roleDesc: '开发界面' });
    expect(task.execute).toThrow(/contact/i);
    expect(task.writes).toEqual([]);
  });
});
