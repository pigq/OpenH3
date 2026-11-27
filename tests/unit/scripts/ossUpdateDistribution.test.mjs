import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? process.env.BASH_EXE : 'bash';
const roots = new Set();
const shellPath = (value) =>
  value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const workflow = yaml.load(fs.readFileSync('.github/workflows/release-distribute.yml', 'utf8'));
const publishStep = workflow.jobs['distribute-oss'].steps.find((step) => step.name.startsWith('Upload verified'));

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openh3-oss-publish-'));
  roots.add(root);
  for (const name of ['dist', 'bin', 'remote', 'temp']) fs.mkdirSync(path.join(root, name));
  const artifact = 'OpenH3-3.0.8-win-x64.exe';
  const bytes = Buffer.from('same verified release bytes');
  fs.writeFileSync(path.join(root, 'dist', artifact), bytes);
  fs.writeFileSync(path.join(root, 'dist', `${artifact}.blockmap`), 'test blockmap');
  fs.writeFileSync(path.join(root, 'dist', 'latest.yml'), 'version: 3.0.8\n');
  fs.writeFileSync(path.join(root, 'dist', 'release-api.json'), '{}');
  fs.writeFileSync(path.join(root, 'dist', 'releases.json'), JSON.stringify({ release: { version: '3.0.8' } }));
  fs.writeFileSync(path.join(root, 'publish.sh'), publishStep.run);
  fs.writeFileSync(
    path.join(root, 'bin', 'ossutil'),
    `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"; shift
if [[ "$cmd" == ls ]]; then
  prefix="\${1#oss://bohuauhd/}"
  if [[ -d "$MOCK_ROOT/remote/$prefix" ]]; then
    find "$MOCK_ROOT/remote/$prefix" -type f ! -name '*.digest' ! -name '*.headers' | while IFS= read -r file; do
      printf 'oss://bohuauhd/%s\\n' "\${file#"$MOCK_ROOT/remote/"}"
    done
  fi
  exit 0
fi
source=""; destination="\${1#oss://bohuauhd/}"
if [[ "$cmd" == cp ]]; then source="$1"; destination="\${2#oss://bohuauhd/}"; shift; fi
[[ "$cmd" == cp || "$cmd" == set-props ]]
shift
digest=""; force=false; content_type=""; disposition=""; cache=""; directive=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --metadata) digest="\${2#sha256=}"; shift 2 ;;
    --content-type) content_type="$2"; shift 2 ;;
    --content-disposition) disposition="$2"; shift 2 ;;
    --cache-control) cache="$2"; shift 2 ;;
    --metadata-directive) directive="$2"; shift 2 ;;
    --force) force=true; shift ;;
    *) echo "Unsupported ossutil v2 option: $1" >&2; exit 2 ;;
  esac
done
[[ "$destination" != "\${MOCK_FAIL_OBJECT:-}" ]] || exit 7
target="$MOCK_ROOT/remote/$destination"
if [[ "$cmd" == set-props ]]; then
  [[ -f "$target" && "$force" == true ]] || exit 9
  [[ "$destination" != "\${MOCK_FAIL_METADATA_OBJECT:-}" ]] || exit 10
  if [[ "$directive" != update ]]; then : > "$target.headers"; fi
  touch "$target.headers"
  awk 'tolower($0) !~ /^content-type:|^content-disposition:/' "$target.headers" > "$target.headers.tmp"
  mv "$target.headers.tmp" "$target.headers"
  printf 'Content-Type: %s\\nContent-Disposition: %s\\n' "$content_type" "$disposition" >> "$target.headers"
  if [[ "$destination" == "\${MOCK_CORRUPT_METADATA_OBJECT:-}" ]]; then printf X | dd of="$target" bs=1 count=1 conv=notrunc status=none; fi
  if [[ "$destination" == "\${MOCK_CHANGE_CACHE_OBJECT:-}" ]]; then sed -i 's/^Cache-Control:.*/Cache-Control: no-store/' "$target.headers"; fi
  printf '%s\\n' "$destination" >> "$MOCK_ROOT/metadata.log"
  exit 0
fi
if [[ -f "$target" && "$force" != true ]]; then exit 8; fi
mkdir -p "$(dirname "$target")"
cp "$source" "$target"
printf 'Content-Type: %s\\nContent-Disposition: %s\\nCache-Control: %s\\n' "$content_type" "$disposition" "$cache" > "$target.headers"
if [[ "$destination" == "\${MOCK_MISSING_DISPOSITION_OBJECT:-}" ]]; then sed -i '/^Content-Disposition:/d' "$target.headers"; fi
[[ -z "$digest" ]] || printf '%s' "$digest" > "$target.digest"
printf '%s\\n' "$destination" >> "$MOCK_ROOT/uploads.log"
`
  );
  fs.writeFileSync(
    path.join(root, 'bin', 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
key="\${url#https://openh3-download.bohuauhd.top/}"
target="$MOCK_ROOT/remote/$key"
if [[ " $* " == *" --head "* ]]; then
  [[ -f "$target.digest" ]] || exit 22
  printf 'x-oss-meta-sha256: %s\\r\\n' "$(cat "$target.digest")"
  printf 'Content-Length: %s\\r\\n' "$(wc -c < "$target" | tr -d '[:space:]')"
  printf 'x-oss-hash-crc64ecma: %s\\r\\n' "$(cksum < "$target" | awk '{print $1}')"
  if [[ -f "$target.headers" ]]; then cat "$target.headers"; fi
  exit 0
fi
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output="$2"; shift 2; else shift; fi
done
if [[ -f "$target" ]]; then cp "$target" "$output"; printf 200; else printf 404; fi
`
  );
  if (process.platform !== 'win32') {
    for (const name of ['ossutil', 'curl']) fs.chmodSync(path.join(root, 'bin', name), 0o755);
  }
  const run = (extra = {}) =>
    spawnSync(
      bash,
      ['--noprofile', '--norc', '-c', 'export PATH="$MOCK_ROOT/bin:$PATH"; bash "$MOCK_ROOT/publish.sh"'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          MOCK_ROOT: shellPath(root),
          RUNNER_TEMP: shellPath(path.join(root, 'temp')),
          OSS_STABLE_PREFIX: 'updates/stable',
          OSS_BUCKET_NAME: 'bohuauhd',
          OSS_ENDPOINT: 'https://oss-cn-shenzhen.aliyuncs.com',
          OSS_PUBLIC_BASE: 'https://openh3-download.bohuauhd.top',
          VERSION: '3.0.8',
          ...extra,
        },
      }
    );
  return {
    root,
    artifact,
    bytes,
    run,
    properties: (name) => fs.readFileSync(path.join(root, 'remote/updates/stable/3.0.8', `${name}.headers`), 'utf8'),
    metadataUpdates: () =>
      fs.existsSync(path.join(root, 'metadata.log'))
        ? fs.readFileSync(path.join(root, 'metadata.log'), 'utf8').trim().split('\n')
        : [],
    uploads: () =>
      fs.existsSync(path.join(root, 'uploads.log'))
        ? fs.readFileSync(path.join(root, 'uploads.log'), 'utf8').trim().split('\n')
        : [],
  };
};

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe.skipIf(!bash)('OSS publication using isolated local command fixtures', () => {
  it('sets explicit download types and attachment filenames for immutable assets', () => {
    const f = fixture();
    const types = {
      [f.artifact]: 'application/vnd.microsoft.portable-executable',
      [`${f.artifact}.blockmap`]: 'application/octet-stream',
      'OpenH3.msi': 'application/x-msi',
      'OpenH3.dmg': 'application/x-apple-diskimage',
      'OpenH3.zip': 'application/zip',
      'OpenH3.deb': 'application/vnd.debian.binary-package',
      'OpenH3.rpm': 'application/x-rpm',
    };
    for (const name of Object.keys(types)) fs.writeFileSync(path.join(f.root, 'dist', name), f.bytes);
    expect(f.run().status).toBe(0);
    for (const [name, type] of Object.entries(types)) {
      expect(f.properties(name)).toContain(`Content-Type: ${type}\n`);
      expect(f.properties(name)).toContain(`Content-Disposition: attachment; filename="${name}"\n`);
    }
  });

  it('repairs existing download headers without uploading bytes or replacing other metadata', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const target = path.join(f.root, 'remote/updates/stable/3.0.8', f.artifact);
    const original = fs.readFileSync(target);
    const digest = fs.readFileSync(`${target}.digest`, 'utf8');
    fs.writeFileSync(
      `${target}.headers`,
      'Content-Type: text/plain\nCache-Control: public, max-age=1234\nX-Oss-Meta-Custom: preserved\n'
    );
    const before = f.uploads().length;
    const result = f.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(f.uploads().slice(before)).toEqual(['updates/stable/latest.yml', 'updates/stable/releases.json']);
    expect(f.metadataUpdates()).toEqual([`updates/stable/3.0.8/${f.artifact}`]);
    expect(fs.readFileSync(target)).toEqual(original);
    expect(fs.readFileSync(`${target}.digest`, 'utf8')).toBe(digest);
    expect(f.properties(f.artifact)).toContain('Cache-Control: public, max-age=1234\n');
    expect(f.properties(f.artifact)).toContain('X-Oss-Meta-Custom: preserved\n');
    expect(f.properties(f.artifact)).toContain(`Content-Disposition: attachment; filename="${f.artifact}"\n`);
  });

  it.each(['failure', 'changed bytes', 'changed cache policy'])(
    'does not publish stable metadata after a metadata repair has %s',
    (problem) => {
      const f = fixture();
      expect(f.run().status).toBe(0);
      const key = `updates/stable/3.0.8/${f.artifact}`;
      fs.writeFileSync(
        path.join(f.root, 'remote', `${key}.headers`),
        'Content-Type: text/plain\nCache-Control: immutable\n'
      );
      const before = f.uploads().length;
      const extra =
        problem === 'failure'
          ? { MOCK_FAIL_METADATA_OBJECT: key }
          : problem === 'changed bytes'
            ? { MOCK_CORRUPT_METADATA_OBJECT: key }
            : { MOCK_CHANGE_CACHE_OBJECT: key };
      expect(f.run(extra).status).not.toBe(0);
      expect(f.uploads().slice(before)).toEqual([]);
    }
  );

  it('refuses to publish stable metadata when an uploaded object does not serve its download headers', () => {
    const f = fixture();
    expect(f.run({ MOCK_MISSING_DISPOSITION_OBJECT: `updates/stable/3.0.8/${f.artifact}` }).status).not.toBe(0);
    expect(f.uploads()).not.toContain('updates/stable/latest.yml');
    expect(f.uploads()).not.toContain('updates/stable/releases.json');
  });

  it('publishes metadata only after all immutable assets and supports exact-match reruns', () => {
    const f = fixture();
    const result = f.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(f.uploads().slice(-2)).toEqual(['updates/stable/latest.yml', 'updates/stable/releases.json']);
    expect(
      f
        .uploads()
        .slice(0, -2)
        .every((key) => key.startsWith('updates/stable/3.0.8/'))
    ).toBe(true);
    const before = f.uploads().length;
    expect(f.run().status).toBe(0);
    expect(f.uploads().slice(before)).toEqual(['updates/stable/latest.yml', 'updates/stable/releases.json']);
    expect(f.metadataUpdates()).toEqual([]);
  });

  it.each(['unexpected object', 'digest mismatch'])('rejects an immutable prefix containing %s', (problem) => {
    const f = fixture();
    const directory = path.join(f.root, 'remote/updates/stable/3.0.8');
    fs.mkdirSync(directory, { recursive: true });
    const name = problem === 'unexpected object' ? 'unexpected.exe' : f.artifact;
    fs.writeFileSync(path.join(directory, name), f.bytes);
    fs.writeFileSync(path.join(directory, `${name}.digest`), 'bad digest');
    expect(f.run().status).not.toBe(0);
    expect(f.uploads()).toEqual([]);
  });

  it('never publishes mutable metadata after an immutable upload fails', () => {
    const f = fixture();
    expect(f.run({ MOCK_FAIL_OBJECT: `updates/stable/3.0.8/${f.artifact}` }).status).not.toBe(0);
    expect(f.uploads().some((key) => key === 'updates/stable/releases.json' || key.endsWith('/latest.yml'))).toBe(
      false
    );
  });

  it('refuses to move the stable pointer to an older version during manual redistribution', () => {
    const f = fixture();
    const directory = path.join(f.root, 'remote/updates/stable');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'releases.json'), JSON.stringify({ release: { version: '3.0.9' } }));
    expect(f.run().status).not.toBe(0);
    expect(f.uploads()).toEqual([]);
  });
});
