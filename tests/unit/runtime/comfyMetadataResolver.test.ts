import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { METADATA_ONLY_PIP } from '@/process/services/media/comfy/planning/runtimePreparation';

const run = promisify(execFile);
it.each(['metadata', 'hashless-alternative', 'no-metadata', 'no-digest'])(
  'resolves %s without requesting a complete wheel',
  async (mode, context) => {
    let python: string | undefined;
    for (const candidate of [
      process.env.OPENH3_TEST_PYTHON,
      path.join(process.env.USERPROFILE ?? '', 'anaconda3', 'python.exe'),
      'python3',
      'python',
    ]) {
      if (!candidate) continue;
      try {
        const result = await run(candidate, ['-c', 'import pip; print(pip.__version__)'], {
          timeout: 5000,
          windowsHide: true,
        });
        if (result.stdout.trim()) {
          python = candidate;
          break;
        }
      } catch {
        /* Optional Python installation varies across test hosts. */
      }
    }
    if (!python) {
      context.skip();
      return;
    }
    const requests: string[] = [];
    const wheel = 'openh3_probe-1.0-py3-none-any.whl';
    const server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url === '/simple/openh3-probe/') {
        response.setHeader('Content-Type', 'text/html');
        const digest = mode === 'no-digest' ? '' : `#sha256=${'a'.repeat(64)}`;
        const metadata = mode === 'no-metadata' ? '' : 'data-dist-info-metadata="true"';
        response.end(
          `<a href="/packages/${wheel}${digest}" ${metadata}>${wheel}</a>` +
            (mode === 'hashless-alternative'
              ? `<a href="/other/${wheel}" data-dist-info-metadata="true">${wheel}</a>`
              : '')
        );
      } else if (request.url === `/packages/${wheel}.metadata`) {
        response.end('Metadata-Version: 2.1\nName: openh3-probe\nVersion: 1.0\nSummary: Unicode ► 元数据\n\n');
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const resolution = run(
        python,
        [
          '-c',
          METADATA_ONLY_PIP,
          'install',
          '--dry-run',
          '--ignore-installed',
          '--only-binary=:all:',
          '--no-cache-dir',
          '--disable-pip-version-check',
          '--no-input',
          '--quiet',
          '--report',
          '-',
          '--index-url',
          `http://127.0.0.1:${port}/simple`,
          'openh3-probe==1.0',
        ],
        { timeout: 20000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'gbk' } }
      );
      if (mode === 'no-metadata' || mode === 'no-digest') {
        await expect(resolution).rejects.toThrow(
          mode === 'no-metadata' ? 'COMFY_METADATA_ONLY_WHEEL_BODY_FORBIDDEN' : 'COMFY_METADATA_ONLY_DIGEST_MISSING'
        );
        expect(requests).not.toContain(`/packages/${wheel}`);
        return;
      }
      const report = JSON.parse((await resolution).stdout);
      expect(report.install[0].metadata.name).toBe('openh3-probe');
      expect(report.install[0].metadata.summary).toBe('Unicode ► 元数据');
      expect(report.install[0].download_info.archive_info.hashes.sha256).toBe('a'.repeat(64));
      expect(requests).toContain(`/packages/${wheel}.metadata`);
      expect(requests).not.toContain(`/packages/${wheel}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  },
  40000
);
