import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Finding = { file: string; line: number; kind: string; match: string };
const { scanSourceText } = createRequire(import.meta.url)('../../scripts/open-source-release-audit.js') as {
  scanSourceText: (content: string, entry: string) => Finding[];
};

describe('release source credential audit', () => {
  it('distinguishes documented runtime generation and environment variable names from credentials', () => {
    const source = [
      'auth token=`crypto.randomUUID()`',
      'const token = `${crypto.randomUUID()}`;',
      "apiKey: 'OPENH3_IMG_API_KEY',",
      "apiKey: 'AIONUI_IMG_API_KEY',",
    ].join('\n');
    expect(scanSourceText(source, 'src/config.ts')).toEqual([]);
  });

  it('still detects opaque assignments and does not exempt values containing an environment name', () => {
    const values = ['8fa721d3a51b9c8f3f1a2127', 'prefix-AIONUI_IMG_API_KEY-sensitive'];
    const findings = scanSourceText(values.map((value) => `token = '${value}'`).join('\n'), 'src/config.ts');
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.line)).toEqual([1, 2]);
    for (const value of values) expect(JSON.stringify(findings)).not.toContain(value);
  });

  it('redacts standalone provider keys as well as literal assignments', () => {
    const keys = ['sk-' + 'a'.repeat(40), 'AIza' + 'b'.repeat(35)];
    const findings = scanSourceText(keys.join('\n'), 'resources/config.json');
    expect(findings.map((finding) => finding.kind)).toEqual(['OpenAI-style key', 'Google API key']);
    for (const key of keys) expect(JSON.stringify(findings)).not.toContain(key);
    expect(findings.every((finding) => finding.match === '[REDACTED]')).toBe(true);
  });

  it('does not exempt arbitrary function-like literals or prefixed environment references', () => {
    for (const value of ['crypto.randomUUID()-fixed-secret', 'OTHER_PROVIDER_SECRET', 'AIONUI_IMG_API_KEY_sensitive']) {
      expect(scanSourceText(`secret = '${value}'`, 'src/config.ts')).toHaveLength(1);
    }
  });

  it('keeps test fixtures excluded without excluding production source with test in its name', () => {
    const assignment = "secret = '8fa721d3a51b9c8f3f1a2127'";
    expect(scanSourceText(assignment, 'tests/unit/fixture.ts')).toEqual([]);
    expect(scanSourceText(assignment, 'src/testProvider.ts')).toHaveLength(1);
  });
});
