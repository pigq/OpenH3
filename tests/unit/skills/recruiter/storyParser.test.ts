import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('reports unsupported WebP metadata before PNG dependencies and does not suggest lossy conversion', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'story-parser-'));
  const source = path.join(dir, 'card.webp');
  const script = path.resolve(
    'core/crates/openh3-app/assets/builtin-skills/story-roleplay/scripts/parse-character-card.js'
  );
  writeFileSync(source, 'RIFF0000WEBP');
  try {
    expect(() =>
      execFileSync(process.execPath, [script, source, path.join(dir, 'out.json')], { cwd: dir, stdio: 'pipe' })
    ).toThrow(/WebP metadata|metadata parser/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
