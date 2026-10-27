import { records, record, stringValue, type CatalogRecord } from './catalog';

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

/** Only byte-identical, documented transports participate in domestic fallback. */
export function approvedComfyTransports(component: CatalogRecord): string[] {
  const matches = (item: CatalogRecord) => item.sha256 === component.sha256 && item.sizeBytes === component.sizeBytes;
  const transports = records(component.transports).filter(
    (item) =>
      matches(item) && Boolean(stringValue(record(item.identityEvidence).kind)) && trustedSource(stringValue(item.url))
  );
  const score = (provider: unknown) => (provider === 'modelscope' ? 0 : provider === 'domestic-mirror' ? 1 : 2);
  transports.sort((a, b) => score(a.provider) - score(b.provider));
  const mirrors = VERIFIED_MIRRORS.filter(matches).map((item) => item.url);
  const urls = [...transports.map((item) => stringValue(item.url)), ...mirrors, stringValue(component.url)];
  return [...new Set(urls.filter(trustedSource))]
    .sort(
      (a, b) =>
        score(
          a.includes('modelscope.cn') ? 'modelscope' : a.includes('hf-mirror.com') ? 'domestic-mirror' : 'upstream'
        ) -
        score(b.includes('modelscope.cn') ? 'modelscope' : b.includes('hf-mirror.com') ? 'domestic-mirror' : 'upstream')
    )
    .slice(0, 4);
}

/** Probe the fixed file itself; a reachable home page is not download evidence. */
export async function selectComfyTransports(
  component: CatalogRecord,
  fetcher: typeof fetch = fetch
): Promise<string[]> {
  const urls = approvedComfyTransports(component);
  const reachable: string[] = [];
  let authorization = false;
  for (const url of urls) {
    try {
      const response = await fetcher(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8_000) });
      authorization ||= [401, 403].includes(response.status);
      const sizeHeader = response.headers.get('x-linked-size') ?? response.headers.get('content-length');
      const digest = response.headers.get('x-linked-etag')?.replace(/^"|"$/g, '').toLowerCase();
      const size = Number(sizeHeader);
      const redirect = [301, 302, 303, 307, 308].includes(response.status);
      // LFS metadata on a redirect is sufficient for source reachability; the
      // downloader validates redirected bytes, size and digest independently.
      if (
        (response.ok || redirect) &&
        (!size || size === component.sizeBytes || (redirect && !response.headers.has('x-linked-size'))) &&
        (!digest || digest === stringValue(component.sha256).toLowerCase())
      )
        reachable.push(url);
      await response.body?.cancel();
    } catch {
      /* Fall through to the next documented transport. */
    }
  }
  if (!reachable.length)
    throw new Error(
      `COMFY_${authorization ? 'SOURCE_AUTHORIZATION_REQUIRED' : 'TOOL_NOT_READY:MODEL_SOURCES_UNREACHABLE'}:${stringValue(component.name)}`
    );
  // Preserve eligible but currently offline transports for resumable fallback,
  // after transports actually probed as reachable, in the same domestic order.
  return [...reachable, ...urls.filter((url) => !reachable.includes(url))].slice(0, 4);
}
