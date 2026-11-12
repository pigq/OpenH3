import { readPublicPage, validatePublicUrl, type WebPage } from './webAccess';

function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_all, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[
      entity.toLowerCase()
    ];
  });
}
const plain = (html: string): string =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
function href(attributes: string): string | undefined {
  return /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i
    .exec(attributes)
    ?.slice(1)
    .find((value) => value !== undefined);
}
export function readablePage(html: string, url: string, maxChars = 16000) {
  const clean = html
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const title = plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1] ?? '');
  const links: Array<{ title: string; url: string }> = [];
  for (const match of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    try {
      const target = validatePublicUrl(new URL(decode(href(match[1]) ?? ''), url).href).href;
      if (!links.some((link) => link.url === target)) links.push({ title: plain(match[2]).slice(0, 200), url: target });
    } catch {
      /* Ignore non-public and non-HTTP references. */
    }
    if (links.length >= 80) break;
  }
  const text = plain(clean);
  return {
    url,
    title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    links,
    untrustedContent: true,
  };
}
export function parseSearchResults(html: string) {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const snippets = [
    ...html.matchAll(/<(?:a|div)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/gi),
  ].map((match) => plain(match[1]));
  for (const match of html.matchAll(/<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    try {
      const target = new URL(decode(href(match[1]) ?? ''), 'https://duckduckgo.com');
      const url = validatePublicUrl(target.searchParams.get('uddg') ?? target.href).href;
      if (!results.some((item) => item.url === url))
        results.push({ title: plain(match[2]), url, snippet: snippets[results.length] ?? '' });
    } catch {
      /* Invalid search hit is not an executable instruction. */
    }
  }
  return results;
}
export function parseBingSearchResults(html: string) {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const entry of html.matchAll(/<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const anchor = /<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(entry[1]);
    if (!anchor) continue;
    try {
      const target = new URL(decode(href(anchor[1]) ?? ''), 'https://www.bing.com');
      let destination = target.href;
      if (target.hostname === 'www.bing.com' && target.pathname === '/ck/a') {
        const encoded = target.searchParams.get('u') ?? '';
        if (!encoded.startsWith('a1')) continue;
        destination = Buffer.from(encoded.slice(2), 'base64url').toString('utf8');
      }
      const url = validatePublicUrl(destination).href;
      if (results.some((item) => item.url === url)) continue;
      const caption =
        /<div\b[^>]*class=["'][^"']*b_caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(entry[1])?.[1] ?? '';
      results.push({ title: plain(anchor[2]), url, snippet: plain(caption) });
    } catch {
      /* Ignore malformed or wrapped non-public search hits. */
    }
    if (results.length >= 10) break;
  }
  return results;
}
export async function searchWeb(
  query: string,
  options: { read?: (url: string) => Promise<WebPage>; limit?: number } = {}
) {
  try {
    const page = await (options.read ?? readPublicPage)(
      'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
    );
    if (!/challenge-form|anomaly-modal|verify (?:you are |you're )?human/i.test(page.text)) {
      const results = parseSearchResults(page.text);
      if (results.length || /no results|result--no-result/i.test(page.text))
        return {
          query,
          provider: 'duckduckgo-html',
          results: results.slice(0, options.limit ?? 8),
          retrievedAt: new Date().toISOString(),
          untrustedContent: true,
        };
    }
  } catch {
    // A provider outage is a reason to try the alternate public search endpoint.
  }
  const fallback = await (options.read ?? readPublicPage)('https://www.bing.com/search?q=' + encodeURIComponent(query));
  const results = parseBingSearchResults(fallback.text).slice(0, options.limit ?? 8);
  if (!results.length) throw new Error('WEB_SEARCH_UNAVAILABLE_OR_UNRECOGNIZED');
  return { query, provider: 'bing-html', results, retrievedAt: new Date().toISOString(), untrustedContent: true };
}
