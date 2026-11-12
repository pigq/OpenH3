import { record, records, stringValue, type CatalogRecord } from '../planning/catalog';
import { readPublicPage } from '@/process/resources/builtinMcp/research/webAccess';

type Source = { url: string; repository: string; revision: string; path: string; sha256: string; sizeBytes: number };
type Attempt = { url: string; status: 'verified' | 'no-match' | 'unreachable'; httpStatus?: number };
export type SourceDiscovery = { component: string; sources: Source[]; attempts: Attempt[] };
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
const revisionPattern = /^[a-f\d]{40}$/i;

/** Search provider metadata, never filenames alone, for the same immutable bytes. */
export async function discoverComfySources(
  component: CatalogRecord,
  options: { fetcher?: typeof fetch; repositories?: string[] } = {}
): Promise<SourceDiscovery> {
  const result: SourceDiscovery = { component: stringValue(component.name), sources: [], attempts: [] };
  if (!/^[a-f\d]{64}$/i.test(stringValue(component.sha256)) || !(Number(component.sizeBytes) > 0))
    throw new Error('COMFY_SOURCE_IDENTITY_REQUIRED');
  const repositories = new Set(
    [stringValue(component.repository), ...(options.repositories ?? [])].filter((repo) => repositoryPattern.test(repo))
  );
  for (const url of [component.url, ...records(component.transports).map((item) => item.url)]) {
    try {
      const parsed = new URL(String(url));
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parsed.hostname === 'modelscope.cn' && parts[0] === 'models') parts.shift();
      const repo = parts.slice(0, 2).join('/');
      if (repositoryPattern.test(repo)) repositories.add(repo);
    } catch {
      /* Missing legacy URL is not identity evidence. */
    }
  }
  const fetcher =
    options.fetcher ??
    (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await readPublicPage(String(input));
      return new Response(response.text, {
        status: response.status,
        headers: { 'content-type': response.contentType },
      });
    });
  async function metadata(url: string): Promise<unknown> {
    const attempt: Attempt = { url, status: 'unreachable' };
    result.attempts.push(attempt);
    try {
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8_000) });
      attempt.httpStatus = response.status;
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return undefined;
      }
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error('METADATA_TOO_LARGE');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch((): undefined => undefined);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      attempt.status = 'no-match';
      return value;
    } catch {
      return undefined;
    }
  }
  function add(
    repository: string,
    host: string,
    revision: unknown,
    file: unknown,
    sha: unknown,
    size: unknown,
    metadataUrl: string
  ) {
    if (
      !revisionPattern.test(String(revision)) ||
      typeof file !== 'string' ||
      file.split('/').some((part) => !part || part === '..' || part === '.') ||
      String(sha).toLowerCase() !== stringValue(component.sha256).toLowerCase() ||
      Number(size) !== Number(component.sizeBytes)
    )
      return;
    const url = `https://${host}/${host === 'modelscope.cn' ? 'models/' : ''}${repository}/resolve/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
    if (!result.sources.some((source) => source.url === url))
      result.sources.push({
        url,
        repository,
        revision: String(revision),
        path: file,
        sha256: String(sha).toLowerCase(),
        sizeBytes: Number(size),
      });
    const attempt = result.attempts.find((entry) => entry.url === metadataUrl);
    if (attempt) attempt.status = 'verified';
  }
  async function inspect(repository: string) {
    await Promise.all(
      ['modelscope.cn', 'hf-mirror.com', 'huggingface.co'].map(async (host) => {
        const url =
          host === 'modelscope.cn'
            ? `https://${host}/api/v1/models/${repository}/repo/files?Revision=master&Recursive=true`
            : `https://${host}/api/models/${repository}?blobs=true`;
        const data = record(await metadata(url));
        if (host === 'modelscope.cn') {
          for (const file of records(record(data.Data).Files))
            if (file.Type === 'blob') add(repository, host, file.Revision, file.Path, file.Sha256, file.Size, url);
        } else {
          for (const file of records(data.siblings)) {
            const lfs = record(file.lfs);
            add(repository, host, data.sha, file.rfilename, lfs.sha256, lfs.size ?? file.size, url);
          }
        }
      })
    );
  }
  for (const repository of [...repositories].slice(0, 4)) await inspect(repository);
  if (!result.sources.length) {
    // Provider search yields repository candidates only. Every hit must pass the same hash/size check.
    const catalogRepository = stringValue(component.repository);
    const query = catalogRepository.split('/').pop() || result.component.replace(/\.(safetensors|gguf|bin)$/, '');
    for (const host of ['hf-mirror.com', 'huggingface.co']) {
      const hits = records(await metadata(`https://${host}/api/models?search=${encodeURIComponent(query)}&limit=5`));
      const extra = hits
        .map((hit) => stringValue(hit.id ?? hit.modelId))
        .filter((repo) => repo !== catalogRepository && repositoryPattern.test(repo) && !repositories.has(repo));
      for (const repo of extra.slice(0, 4)) repositories.add(repo);
      await Promise.all(extra.slice(0, 4).map(inspect));
      if (result.sources.length) break;
    }
  }
  return result;
}
