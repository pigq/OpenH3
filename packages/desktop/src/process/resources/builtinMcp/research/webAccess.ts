import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { resolveH3DownloadProxy } from '@/process/services/runtime/h3Downloader';

export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 88, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  // Permit global unicast only; rejects mapped IPv4, loopback, link-local and unique-local IPv6.
  return (
    net.isIPv6(address) &&
    /^[23][a-f\d]{3}:/i.test(address) &&
    !/^2001:(?:0*db8|0):/i.test(address) &&
    !/^2002:/i.test(address) &&
    !/^3fff:/i.test(address)
  );
}
export function validatePublicUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (!host.includes('.') && !net.isIP(host)) ||
    (net.isIP(host) && !isPublicAddress(host))
  )
    throw new Error('WEB_URL_NOT_PUBLIC');
  url.hash = '';
  return url;
}
export type WebPage = { url: string; text: string; contentType: string; status: number };

/** Bounded public HTTP reads with DNS pinned per request and every redirect validated. */
export async function readPublicPage(value: string): Promise<WebPage> {
  const signal = AbortSignal.timeout(20_000);
  let url = validatePublicUrl(value);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const proxy = resolveH3DownloadProxy();
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('WEB_TIMEOUT')), { once: true })
      ),
    ]);
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
      throw new Error('WEB_URL_NOT_PUBLIC');
    const pinnedAddress = addresses[0];
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method: 'GET',
          signal,
          ...(pinnedAddress ? { family: pinnedAddress.family } : {}),
          ...(proxy
            ? { agent: url.protocol === 'https:' ? new HttpsProxyAgent(proxy) : new HttpProxyAgent(proxy) }
            : {}),
          headers: {
            'user-agent': 'OpenH3/1.0 (public-page-reader)',
            accept: 'text/html,application/json,text/plain,application/xml;q=0.9',
            'accept-encoding': 'identity',
          },
          ...(!proxy && pinnedAddress
            ? {
                lookup: (
                  _name: string,
                  _options: unknown,
                  callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void
                ) => callback(null, pinnedAddress.address, pinnedAddress.family),
              }
            : {}),
        },
        resolve
      );
      request.on('error', reject);
      request.end();
    });
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.destroy();
      if (!response.headers.location) throw new Error('WEB_INVALID_REDIRECT');
      url = validatePublicUrl(new URL(response.headers.location, url).href);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error('WEB_HTTP_' + status);
    }
    const contentType = response.headers['content-type'] ?? '';
    if (!/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType)) {
      response.destroy();
      throw new Error('WEB_UNSUPPORTED_CONTENT_TYPE');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      length += buffer.length;
      if (length > 2 * 1024 * 1024) {
        response.destroy();
        throw new Error('WEB_PAGE_TOO_LARGE');
      }
      chunks.push(buffer);
    }
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
    return { url: url.href, contentType, status, text: new TextDecoder(charset).decode(Buffer.concat(chunks)) };
  }
  throw new Error('WEB_TOO_MANY_REDIRECTS');
}
