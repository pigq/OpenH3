#!/usr/bin/env node

/**
 * Public OpenH3 release gate.
 *
 * This audit intentionally checks source files and unpacked release output
 * separately. A developer may use a credentialed experience build locally,
 * but a public build must not contain provider bootstrap credentials.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, '.runtime', 'open-source-release-audit.json');
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ps1',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
]);

const secretPatterns = [
  { name: 'OpenAI-style key', regex: /\bsk-[A-Za-z0-9_-]{32,}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
];
const literalAssignmentPattern =
  /(?:api[_-]?key|token|secret)\s*[:=]\s*["'`](?!test|dummy|example|placeholder|provider-key)[^"'`\s]{16,}["'`]/gi;

function isTextFile(filePath) {
  return textExtensions.has(path.extname(filePath).toLowerCase());
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function listSourceFiles() {
  // Include new, untracked source files in the release gate. Ignored build
  // output, runtime state and dependencies remain excluded by git's rules.
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function scanSource() {
  const findings = [];
  for (const entry of listSourceFiles()) {
    const filePath = path.join(root, entry);
    if (!isTextFile(filePath)) continue;
    const content = readText(filePath);
    if (content === null) continue;

    findings.push(...scanSourceText(content, entry));
  }
  return findings;
}

function scanSourceText(content, entry) {
  const findings = [];
  if (/^(tests|test)\//i.test(entry)) return findings;
  for (const pattern of secretPatterns) {
    for (const match of content.matchAll(pattern.regex)) {
      const line = content.slice(0, match.index).split('\n').length;
      findings.push({ file: entry, line, kind: pattern.name, match: '[REDACTED]' });
    }
  }
  for (const match of content.matchAll(literalAssignmentPattern)) {
    const literal = match[0].match(/(["'`])([^"'`]*)\1$/u);
    const value = literal?.[2];
    // Only exact environment identifiers and UUID-generation expressions are
    // non-credentials. Never exempt a secret merely containing these strings.
    if (value && /^(?:OPENH3|AIONUI)_[A-Z0-9_]+_(?:KEY|TOKEN|SECRET)$/u.test(value)) continue;
    if (literal?.[1] === '`' && /^(?:crypto\.randomUUID\(\)|\$\{crypto\.randomUUID\(\)\})$/u.test(value)) continue;
    const line = content.slice(0, match.index).split('\n').length;
    findings.push({
      file: entry,
      line,
      kind: 'literal credential assignment',
      match: match[0].replace(/([:=]\s*["'`]?)[^\s"'`]+/u, '$1[REDACTED]'),
    });
  }
  return findings;
}

function scanArtifacts() {
  const findings = [];
  const artifactRoots = [path.join(root, 'out'), path.join(root, 'dist')].filter(fs.existsSync);
  for (const artifactRoot of artifactRoots) {
    const stack = [artifactRoot];
    while (stack.length) {
      const current = stack.pop();
      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        stack.push(...fs.readdirSync(current).map((name) => path.join(current, name)));
        continue;
      }
      if (path.basename(current) === 'video-provider-bootstrap.json') {
        findings.push({ file: relative(current), kind: 'provider bootstrap in release output' });
        continue;
      }
      if (!isTextFile(current)) continue;
      const content = readText(current);
      if (!content) continue;
      for (const pattern of secretPatterns) {
        if (pattern.regex.test(content)) {
          findings.push({ file: relative(current), kind: `artifact ${pattern.name}` });
        }
        pattern.regex.lastIndex = 0;
      }
    }
  }
  return findings;
}

function collectLicenseFiles() {
  const results = [];
  const stack = [root];
  const ignored = new Set(['node_modules', '.git', '.runtime', 'coverage']);
  while (stack.length) {
    const current = stack.pop();
    const name = path.basename(current);
    if (fs.statSync(current).isDirectory()) {
      if (ignored.has(name)) continue;
      stack.push(...fs.readdirSync(current).map((entry) => path.join(current, entry)));
      continue;
    }
    if (/^(license|licence|notice|copying)(\.|$)/i.test(name)) results.push(relative(current));
  }
  return results.sort();
}

const licenseEvidenceGaps = [
  { component: 'ComfyUI v0.35.0', requirement: 'bundle fixed-revision LICENSE/NOTICE and GPL source offer' },
  { component: 'ComfyUI-MAINodes', requirement: 'bundle GPL-3.0-or-later text and corresponding-source plan' },
  {
    component: 'ComfyUI-PlagueKind-Nodes-only-sparse',
    requirement: 'bundle MIT text and trace inherited upstream code notices',
  },
  { component: 'ComfyUI-KJNodes', requirement: 'bundle GPL-3.0 text and corresponding-source plan' },
  {
    component: 'H3 weights and derived LoRA/conversion files',
    requirement: 'obtain per-file redistribution authorization or keep user-provided',
  },
  {
    component: '7-Zip, Node runtime, and npm/bun dependencies',
    requirement: 'produce release third-party NOTICE inventory',
  },
];
const licenseEvidencePresent = [
  'resources/third-party-licenses/LICENSE.ComfyUI-v0.35.0-LICENSE',
  'resources/third-party-licenses/LICENSE.ComfyUI-MAINodes-f4868b4a-LICENSE',
  'resources/third-party-licenses/LICENSE.ComfyUI-PlagueKind-sparse-fd26ffb-LICENSE',
  'resources/third-party-licenses/LICENSE.ComfyUI-KJNodes-d3cfe216-LICENSE',
  'resources/third-party-licenses/NOTICE.OpenH3.txt',
];

function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    sourceSecretFindings: scanSource(),
    artifactFindings: scanArtifacts(),
    licenseFiles: collectLicenseFiles(),
    licenseEvidencePresent,
    licenseEvidenceGaps,
    publicBuildRules: {
      providerBootstrap: 'forbidden',
      providerKey: 'forbidden',
      modelWeights: 'must be separately licensed or user-provided',
    },
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`OpenH3 release audit: ${reportPath}`);
  console.log(`Source findings: ${report.sourceSecretFindings.length}`);
  console.log(`Artifact findings: ${report.artifactFindings.length}`);
  console.log(`License files found: ${report.licenseFiles.length}`);
  console.log(`License evidence gaps: ${report.licenseEvidenceGaps.length}`);

  if (report.sourceSecretFindings.length || report.artifactFindings.length) {
    for (const finding of [...report.sourceSecretFindings, ...report.artifactFindings])
      console.error(JSON.stringify(finding));
    process.exitCode = 1;
  }
}

module.exports = { scanSourceText };
if (require.main === module) main();
