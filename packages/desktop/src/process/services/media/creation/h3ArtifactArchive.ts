import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { H3Artifact } from '@/common/chat/document/h3Job';

const within = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Persist outputs independently of ComfyUI's server lifetime and ephemeral port. */
export class H3ArtifactArchive {
  private pending = new Map<string, Promise<string>>();
  constructor(private readonly options: { directory: string; outputRoots: () => string[] }) {}

  resolve(id: string, index: number, artifact: H3Artifact, upstream?: () => Promise<Response>): Promise<string> {
    if (
      !/^[\w-]{1,100}$/.test(id) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !artifact.filename ||
      /[\\/]/.test(artifact.filename) ||
      artifact.filename === '..' ||
      path.isAbsolute(artifact.subfolder) ||
      /(^|[\\/])\.\.([\\/]|$)/.test(artifact.subfolder) ||
      artifact.type !== 'output'
    )
      return Promise.reject(new Error('H3_ARTIFACT_REFERENCE_INVALID'));
    const identity = crypto
      .createHash('sha256')
      .update(JSON.stringify([artifact.filename, artifact.subfolder, artifact.type, artifact.mimeType]))
      .digest('hex')
      .slice(0, 20);
    const target = path.join(this.options.directory, id, `${index}-${identity}${path.extname(artifact.filename)}`);
    const pending = this.pending.get(target);
    if (pending) return pending;
    const work = this.materialize(target, artifact, upstream).finally(() => this.pending.delete(target));
    this.pending.set(target, work);
    return work;
  }

  private async materialize(target: string, artifact: H3Artifact, upstream?: () => Promise<Response>): Promise<string> {
    try {
      if (fs.lstatSync(target).isFile() && fs.statSync(target).size > 0) return target;
    } catch {
      /* Older jobs may not have a persisted copy yet. */
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.part`;
    try {
      for (const root of this.options.outputRoots()) {
        try {
          const canonical = fs.realpathSync(root);
          const source = fs.realpathSync(path.join(root, artifact.subfolder, artifact.filename));
          if (!within(canonical, source) || !fs.statSync(source).isFile() || !fs.statSync(source).size) continue;
          fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
          fs.renameSync(temporary, target);
          return target;
        } catch {
          /* Try the other exact known output directories before HTTP. */
        }
      }
      if (!upstream) throw new Error('H3_ARTIFACT_UNAVAILABLE');
      const response = await upstream();
      if (!response.ok || !response.body || /(?:json|text\/html)/i.test(response.headers.get('content-type') ?? ''))
        throw new Error('H3_ARTIFACT_UNAVAILABLE');
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            done(bytes > 8 * 1024 ** 3 ? new Error('H3_ARTIFACT_TOO_LARGE') : null, chunk);
          },
        }),
        fs.createWriteStream(temporary, { flags: 'wx' })
      );
      if (!bytes) throw new Error('H3_ARTIFACT_EMPTY');
      fs.renameSync(temporary, target);
      return target;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

/** Local video playback and seeking must work without starting the generation server. */
export function serveH3ArtifactFile(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  filename: string,
  mimeType: string
): void {
  const size = fs.statSync(filename).size;
  const range = request.headers.range;
  const parsed = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : undefined;
  let start = 0;
  let end = size - 1;
  if (range) {
    if (!parsed || (!parsed[1] && !parsed[2])) {
      response.writeHead(416, { 'content-range': `bytes */${size}` });
      response.end();
      return;
    }
    start = parsed[1] ? Number(parsed[1]) : Math.max(0, size - Number(parsed[2]));
    end = parsed[1] && parsed[2] ? Math.min(Number(parsed[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      response.writeHead(416, { 'content-range': `bytes */${size}` });
      response.end();
      return;
    }
  }
  response.writeHead(range ? 206 : 200, {
    'content-type': mimeType,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  });
  const stream = fs.createReadStream(filename, { start, end });
  response.once('close', () => stream.destroy());
  stream.once('error', () => response.destroy());
  stream.pipe(response);
}
