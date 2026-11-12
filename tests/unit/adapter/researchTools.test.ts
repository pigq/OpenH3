import { describe, expect, it } from 'vitest';
import {
  parseBingSearchResults,
  parseSearchResults,
  readablePage,
  searchWeb,
} from '@/process/resources/builtinMcp/research/webTools';
import { isPublicAddress, validatePublicUrl } from '@/process/resources/builtinMcp/research/webAccess';

describe('built-in web research', () => {
  it('uses the fallback provider when the primary search endpoint is unreachable', async () => {
    const page = await searchWeb('model', {
      read: async (url) => {
        if (url.includes('duckduckgo')) throw new Error('WEB_HTTP_503');
        return {
          url,
          text: '<li class="b_algo"><h2><a href="https://huggingface.co/Org/Model">Model</a></h2></li>',
          contentType: 'text/html',
          status: 200,
        };
      },
    });
    expect(page.provider).toBe('bing-html');
    expect(page.results[0].url).toBe('https://huggingface.co/Org/Model');
  });
  it.each(['192.88.99.1', '198.51.100.1', '203.0.113.1', '2001:0db8::1', '3fff::1'])(
    'rejects reserved non-public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    }
  );
  it('extracts real search links and rejects a blocked search as an empty success', async () => {
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhuggingface.co%2FOrg%2FModel">Model &amp; weights</a><a class="result__snippet">Pinned weights</a>';
    expect(parseSearchResults(html)[0]).toMatchObject({
      title: 'Model & weights',
      url: 'https://huggingface.co/Org/Model',
      snippet: 'Pinned weights',
    });
    const page = await searchWeb('model', {
      read: async (url) =>
        String(url).includes('duckduckgo')
          ? {
              url: String(url),
              text: '<form id="challenge-form">Verify human</form>',
              contentType: 'text/html',
              status: 200,
            }
          : {
              url: String(url),
              text: '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9odWdnaW5nZmFjZS5jby9PcmcvTW9kZWw=">Model</a></h2><div class="b_caption"><p>Verified source</p></div></li>',
              contentType: 'text/html',
              status: 200,
            },
    });
    expect(page.provider).toBe('bing-html');
    expect(page.results[0].url).toBe('https://huggingface.co/Org/Model');
  });
  it('unwraps provider redirects from Bing search results', () => {
    expect(
      parseBingSearchResults(
        '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9odWdnaW5nZmFjZS5jby9PcmcvTW9kZWw=">Model</a></h2></li>'
      )[0].url
    ).toBe('https://huggingface.co/Org/Model');
  });
  it('returns readable page text, bounded output and source links without executing scripts', () => {
    const page = readablePage(
      '<title>Guide</title><script>steal()</script><style>hide</style><p>Install &amp; verify</p><a href="/models">Models</a>',
      'https://example.org/guide',
      12000
    );
    expect(page.text).toContain('Install & verify');
    expect(page.text).not.toContain('steal');
    expect(page.links[0].url).toBe('https://example.org/models');
    expect(readablePage('x'.repeat(40), 'https://example.org', 20)).toMatchObject({
      truncated: true,
      text: 'x'.repeat(20),
    });
  });
  it('blocks local addresses, mapped IPv6 and credential URLs', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.1.32',
      '169.254.169.254',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      'fc00::1',
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    for (const url of [
      'file:///C:/secret',
      'https://user:secret@example.org/',
      'http://localhost/',
      'http://127.0.0.1/',
      'http://example.org:8000/',
    ])
      expect(() => validatePublicUrl(url)).toThrow();
  });
});
