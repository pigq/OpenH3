import { records, record, stringValue, type CatalogRecord } from './catalog';
import { discoverComfySources } from '../discovery/sourceDiscovery';
import { fetchH3Download } from '@/process/services/runtime/h3Downloader';

// Fixed-revision mirror HEAD metadata (x-linked-etag/x-linked-size and repo
// commit) was compared with the catalog on 2026-10-27. Downloads are still
// verified by SHA256; this table never treats a URL substitution as evidence.
const VERIFIED_MIRRORS: Array<{ sha256: string; sizeBytes: number; url: string }> = [
  {
    sha256: 'cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4',
    sizeBytes: 9384670680,
    url: 'https://hf-mirror.com/Comfy-Org/Hunyuan-Video-1.5/resolve/1405a2b738c29b890cf6d03fc038d8d3e92eeed7/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
  },
  {
    sha256: 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f',
    sizeBytes: 253806246,
    url: 'https://hf-mirror.com/Comfy-Org/Qwen-Image/resolve/1f12b17be14c89b026c51a91d67c32f84bb047bc/split_files/vae/qwen_image_vae.safetensors',
  },
  {
    sha256: 'c9fdc158e46d3b61ef75f21ae866ca2fe808bf4a53643120d1c1e87c19280a4e',
    sizeBytes: 20533762817,
    url: 'https://hf-mirror.com/Comfy-Org/Qwen-Image-Edit/resolve/f68ace85e60b4a02a323e394253731947657b7d2/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors',
  },
  {
    sha256: '22226e8d05d354bb356627d428809f5afd7819399b077238a2b70a82883a904f',
    sizeBytes: 849608296,
    url: 'https://hf-mirror.com/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/d74eba145674fd7e31b949324e148e21e7118abd/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors',
  },
  {
    sha256: '2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6',
    sizeBytes: 12309866400,
    url: 'https://hf-mirror.com/Comfy-Org/Z-Image-Turbo/resolve/6fc90a3b1b653e935a0d175e260736de25b84df5/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
  },
  {
    sha256: '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a',
    sizeBytes: 8044982048,
    url: 'https://hf-mirror.com/Comfy-Org/Z-Image-Turbo/resolve/6fc90a3b1b653e935a0d175e260736de25b84df5/split_files/text_encoders/qwen_3_4b.safetensors',
  },
  {
    sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38',
    sizeBytes: 335304388,
    url: 'https://hf-mirror.com/Comfy-Org/Z-Image-Turbo/resolve/6fc90a3b1b653e935a0d175e260736de25b84df5/split_files/vae/ae.safetensors',
  },
];

function trustedSource(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      ['modelscope.cn', 'hf-mirror.com', 'huggingface.co'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isTrustedComfySource(url: string): boolean {
  return trustedSource(url);
}

/** Only byte-identical, documented transports participate in domestic fallback. */
export function approvedComfyTransports(component: CatalogRecord, discovered: string[] = []): string[] {
  const matches = (item: CatalogRecord) => item.sha256 === component.sha256 && item.sizeBytes === component.sizeBytes;
  const transports = records(component.transports).filter(
    (item) =>
      matches(item) &&
      Boolean(stringValue(record(item.identityEvidence).kind) || stringValue(item.integrityEvidence)) &&
      trustedSource(stringValue(item.url))
  );
  const score = (provider: unknown) => (provider === 'modelscope' ? 0 : provider === 'domestic-mirror' ? 1 : 2);
  transports.sort((a, b) => score(a.provider) - score(b.provider));
  const mirrors = VERIFIED_MIRRORS.filter(matches).map((item) => item.url);
  const urls = [
    ...discovered,
    ...transports.map((item) => stringValue(item.url)),
    ...mirrors,
    stringValue(component.url),
  ];
  const preferred = [...new Set(urls.filter(trustedSource).filter((url) => !discovered.includes(url)))].sort(
    (a, b) =>
      score(a.includes('modelscope.cn') ? 'modelscope' : a.includes('hf-mirror.com') ? 'domestic-mirror' : 'upstream') -
      score(b.includes('modelscope.cn') ? 'modelscope' : b.includes('hf-mirror.com') ? 'domestic-mirror' : 'upstream')
  );
  return [...new Set([...discovered.filter(trustedSource), ...preferred])];
}

/** Probe the fixed file itself; a reachable home page is not download evidence. */
export async function selectComfyTransports(
  component: CatalogRecord,
  fetcher: typeof fetch = fetchH3Download,
  discovered: string[] = []
): Promise<string[]> {
  const urls = approvedComfyTransports(component, discovered);
  const reachable: string[] = [];
  let authorization = false;
  for (const url of urls) {
    try {
      const response = await fetcher(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8_000) });
      if (isUsableProbe(response, component)) reachable.push(url);
      else if ([401, 403, 405, 501].includes(response.status)) {
        await response.body?.cancel();
        const ranged = await fetcher(url, {
          method: 'GET',
          headers: { range: 'bytes=0-0' },
          redirect: 'manual',
          signal: AbortSignal.timeout(8_000),
        });
        if (isUsableProbe(ranged, component, true)) reachable.push(url);
        else authorization ||= [401, 403].includes(ranged.status);
        await ranged.body?.cancel();
      }
      await response.body?.cancel();
    } catch {
      /* Fall through to the next documented transport. */
    }
  }
  if (!reachable.length)
    throw new Error(
      `COMFY_${authorization ? 'SOURCE_AUTHORIZATION_REQUIRED' : 'SOURCE_UNREACHABLE'}:${stringValue(component.name)}`
    );
  // Probe each pinned source, then try every byte-identical eligible transport.
  return [...new Set([...reachable, ...urls.filter((url) => !reachable.includes(url))])];
}

function isUsableProbe(response: Response, component: CatalogRecord, ranged = false): boolean {
  const total =
    ranged && response.status === 206
      ? response.headers.get('content-range')?.match(/^bytes \d+-\d+\/(\d+)$/)?.[1]
      : response.headers.get('content-length');
  const sizeHeader = response.headers.get('x-linked-size') ?? total;
  const digest = response.headers.get('x-linked-etag')?.replace(/^"|"$/g, '').toLowerCase();
  const size = Number(sizeHeader);
  const redirect = [301, 302, 303, 307, 308].includes(response.status);
  return (
    (response.ok || redirect) &&
    (!size || size === component.sizeBytes || (redirect && !response.headers.has('x-linked-size'))) &&
    (!digest || digest === stringValue(component.sha256).toLowerCase())
  );
}

/** Exhaust catalog transports, then search equivalent provider artifacts once. */
export async function resolveComfyTransports(
  component: CatalogRecord,
  fetcher: typeof fetch = fetchH3Download,
  discovered: string[] = []
): Promise<string[]> {
  try {
    return await selectComfyTransports(component, fetcher, discovered);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('COMFY_SOURCE_UNREACHABLE:')) throw error;
    const discovery = await discoverComfySources(component, { fetcher });
    try {
      if (!discovery.sources.length) throw error;
      return await selectComfyTransports(component, fetcher, [
        ...discovery.sources.map((source) => source.url),
        ...discovered,
      ]);
    } catch (cause) {
      throw Object.assign(cause instanceof Error ? cause : error, {
        diagnosis: {
          stage: 'source-discovery',
          component: component.name,
          sha256: component.sha256,
          sizeBytes: component.sizeBytes,
          attempts: discovery.attempts,
          candidates: discovery.sources,
          nextAction:
            'Use openh3_web_search and openh3_web_fetch to locate equivalent repositories, then openh3_comfy_sources to verify metadata. Preserve identity and permissions.',
        },
      });
    }
  }
}
