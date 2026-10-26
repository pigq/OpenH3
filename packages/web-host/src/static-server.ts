/**
 * WebUI static server.
 *
 * Serves out/renderer/ as the SPA and reverse-proxies /api/*, /ws, /api/stt/stream,
 * /login and /logout to OpenH3 Core. All auth goes to the backend auth service;
 * /login and /logout are the backend's top-level paths, the rest live under
 * /api/auth/*. /ws and /api/stt/stream are WebSocket/stream upgrades spliced at
 * TCP level; /api/stt/stream is the STT streaming endpoint.
 *
 * Design: Node native http + serve-handler. No Express. No business routes.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import net, { type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import serveHandler from 'serve-handler';

export type StaticServerOptions = {
  staticDir: string;
  backendPort: number;
  port?: number;
  allowRemote?: boolean;
};

export type StaticServerHandle = {
  port: number;
  url: string;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  stop: () => Promise<void>;
};

const DEFAULT_PORT = 25808;

// Ranges that are non-internal IPv4 yet never a reachable LAN address, so we
// must never advertise them as the WebUI access URL even when they are the only
// non-loopback interface present:
//   169.254.0.0/16  link-local / APIPA (host got no DHCP lease)
//   198.18.0.0/15   RFC 2544 benchmarking range — handed out by utility tunnels
//                   such as Cloudflare WARP; this is the address that showed up
//                   on a multi-NIC machine instead of the real LAN IP.
const isUnreachableLanRange = (addr: string): boolean => addr.startsWith('169.254.') || /^198\.(18|19)\./.test(addr);

// Rank candidate LAN addresses by how likely they are the network the user
// actually reaches the desktop on. Lower is better. Private (RFC 1918) home /
// office ranges win over anything else; 192.168/16 is the most common LAN, then
// the 172.16/12 block, then 10/8 (frequently carved up by VPNs / corp routing).
const rankLanCandidate = (addr: string): number => {
  if (addr.startsWith('192.168.')) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 1;
  if (addr.startsWith('10.')) return 2;
  return 3;
};

// Pick the best LAN IPv4 to advertise. Pure over the interface map so it can be
// unit-tested against real multi-NIC layouts. Iterating and returning the first
// non-internal hit (the old behavior) picks whatever the OS lists first, which
// on a multi-NIC box can be a VPN / benchmark adapter rather than the LAN.
export function pickLanIP(nets: ReturnType<typeof networkInterfaces>): string | null {
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (isUnreachableLanRange(iface.address)) continue;
      candidates.push(iface.address);
    }
  }
  // Stable sort keeps OS interface order among equally-ranked addresses (e.g. a
  // physical NIC listed before a VPN when both are 10/8).
  candidates.sort((a, b) => rankLanCandidate(a) - rankLanCandidate(b));
  return candidates[0] ?? null;
}

function getLanIP(): string | null {
  return pickLanIP(networkInterfaces());
}

function forwardToBackend(req: IncomingMessage, res: ServerResponse, backendPort: number): void {
  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port: backendPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${backendPort}`, 'x-openh3-webui-request': '1' },
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'BACKEND_UNREACHABLE' }));
    } else {
      res.destroy();
    }
  });
  req.pipe(proxy);
}

// Bound both opening handshake headers. Ordinary HTTP bodies are never peeked.
const PEEK_LIMIT_BYTES = 16 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const discardEarlyData = (): void => {};

function parseHeaderFields(head: Buffer): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const line of head.toString('latin1').split('\r\n').slice(1, -2)) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\r\n]*)$/.exec(line);
    if (!match || /[^\t\x20-\x7e\x80-\xff]/.test(match[2])) return null;
    const name = match[1].toLowerCase();
    // Reject ambiguity rather than disagreeing with the backend HTTP parser.
    if (fields.has(name)) return null;
    fields.set(name, match[2].trim());
  }
  return fields;
}

function hasUpgradeToken(value: string | undefined): boolean {
  return value?.split(',').some((token) => token.trim().toLowerCase() === 'upgrade') === true;
}

function rejectConnection(client: Socket, status: number, reason: string): void {
  // The peek listener was removed before this rejection. A peer can still
  // reset while the response drains, so keep socket errors local to it.
  client.once('error', () => client.destroy());
  client.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Track only HTTP framing for a failed handshake, never buffer its body. This
// lets us close a keep-alive refusal without truncating delayed body segments.
function rejectionBodyTracker(
  fields: Map<string, string>,
  status: number
): (chunk: Buffer) => { length: number; complete: boolean } {
  const transferEncoding = fields.get('transfer-encoding');
  const contentLength = fields.get('content-length');
  if (transferEncoding && contentLength) throw new Error('ambiguous response framing');
  let remaining = status === 204 || status === 304 ? 0 : undefined;
  if (remaining === undefined && contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))
      throw new Error('invalid response length');
    remaining = Number(contentLength);
  }
  const chunked = transferEncoding?.split(',').at(-1)?.trim().toLowerCase() === 'chunked';
  let state: 'size' | 'data' | 'ending' | 'trailers' | 'done' = 'size';
  let chunkRemaining = 0;
  let line = '';
  let trailerBytes = 0;
  return (chunk) => {
    if (remaining !== undefined) {
      const length = Math.min(remaining, chunk.length);
      remaining -= length;
      return { length, complete: remaining === 0 };
    }
    if (!chunked) return { length: chunk.length, complete: false }; // Close-delimited.
    let length = 0;
    while (length < chunk.length && state !== 'done') {
      if (state === 'data') {
        const consumed = Math.min(chunkRemaining, chunk.length - length);
        length += consumed;
        chunkRemaining -= consumed;
        if (chunkRemaining === 0) state = 'ending';
        continue;
      }
      line += String.fromCharCode(chunk[length++]);
      if (line.length > PEEK_LIMIT_BYTES) throw new Error('oversized chunk framing');
      if (!line.endsWith('\r\n')) continue;
      if (state === 'size') {
        const size = /^([0-9a-fA-F]+)(?:;[^\r\n]*)?\r\n$/.exec(line);
        if (!size || !Number.isSafeInteger(parseInt(size[1], 16))) throw new Error('invalid response chunk');
        chunkRemaining = parseInt(size[1], 16);
        state = chunkRemaining === 0 ? 'trailers' : 'data';
      } else if (state === 'ending') {
        if (line !== '\r\n') throw new Error('invalid chunk ending');
        state = 'size';
      } else {
        trailerBytes += line.length;
        if (trailerBytes > PEEK_LIMIT_BYTES) throw new Error('oversized response trailers');
        if (line === '\r\n') state = 'done';
      }
      line = '';
    }
    return { length, complete: state === 'done' };
  };
}

/**
 * Splice `client` to a TCP endpoint on `targetPort`. Any bytes already read
 * from `client` during peek are replayed to the upstream as the first write,
 * so the endpoint sees the full HTTP request as-sent.
 */
function spliceToTcpEndpoint(client: Socket, targetPort: number, initialBytes: Buffer): void {
  client.setNoDelay(true);
  client.setKeepAlive(true);
  client.setTimeout(0);
  // The peek phase left `client` in flowing mode (it had a 'data' listener),
  // but that listener is now removed and the real consumer — `client.pipe(upstream)`
  // — is only wired inside the async 'connect' handler below. Pause here so any
  // body bytes arriving in the gap are buffered by the socket instead of being
  // dropped for lack of a consumer; `pipe()` resumes the socket once connected.
  // Without this, large/buffered uploads (e.g. reverse-proxied POST bodies that
  // span multiple TCP segments) lose their tail bytes and the backend hangs
  // forever waiting for the missing Content-Length (issue #4058).
  client.pause();
  const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
  upstream.setNoDelay(true);
  upstream.setKeepAlive(true);
  upstream.once('connect', () => {
    if (initialBytes.length > 0) upstream.write(initialBytes);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const tearDown = (): void => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', tearDown);
  client.on('error', tearDown);
  upstream.on('close', tearDown);
  client.on('close', tearDown);
}

/** Forward only the opening header until Core actually switches to WebSocket. */
function spliceWebSocket(client: Socket, targetPort: number, head: Buffer, key: string): void {
  client.setNoDelay(true);
  // RFC 6455 requires clients to wait for the handshake. Discard any early
  // pipeline/tail, including later TCP segments, instead of replaying it as HTTP.
  client.on('data', discardEarlyData);
  const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
  upstream.setNoDelay(true);
  upstream.setTimeout(HANDSHAKE_TIMEOUT_MS);
  const tearDown = (): void => {
    client.destroy();
    upstream.destroy();
  };
  upstream.once('connect', () => upstream.write(head));
  upstream.on('error', tearDown);
  client.on('error', tearDown);
  client.on('close', () => upstream.destroy());
  upstream.on('timeout', tearDown);
  upstream.on('end', () => client.end());
  // Preserve queued response bytes on a clean FIN; destroy only on errors.
  upstream.on('close', () => {
    if (!client.writableEnded) client.end();
  });
  let responseHead = Buffer.alloc(0);
  const onResponse = (chunk: Buffer): void => {
    responseHead = Buffer.concat([responseHead, chunk]);
    const end = responseHead.indexOf('\r\n\r\n');
    if (end < 0 && responseHead.length < PEEK_LIMIT_BYTES) return;
    if (end < 0 || end + 4 > PEEK_LIMIT_BYTES) {
      tearDown();
      return;
    }
    const fields = parseHeaderFields(responseHead.subarray(0, end + 4));
    const status = /^HTTP\/1\.[01] ([0-9]{3}) /.exec(responseHead.toString('latin1', 0, responseHead.indexOf('\r\n')));
    if (!fields || !status) {
      tearDown();
      return;
    }
    // Interim responses cannot open the client -> Core pipe either.
    if (Number(status[1]) < 200 && status[1] !== '101') {
      client.write(responseHead.subarray(0, end + 4));
      const remaining = responseHead.subarray(end + 4);
      responseHead = Buffer.alloc(0);
      if (remaining.length > 0) onResponse(remaining);
      return;
    }
    upstream.removeListener('data', onResponse);
    if (status[1] === '101') {
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (
        fields.get('upgrade')?.toLowerCase() !== 'websocket' ||
        !hasUpgradeToken(fields.get('connection')) ||
        fields.get('sec-websocket-accept') !== accept
      ) {
        tearDown();
        return;
      }
      client.pause();
      client.removeListener('data', discardEarlyData);
      upstream.setTimeout(0);
      client.write(responseHead);
      upstream.pipe(client);
      client.pipe(upstream);
      return;
    }
    // No protocol switch: keep discarding client bytes, relay exactly one HTTP
    // response, then close even when Core advertised keep-alive.
    try {
      const consumeBody = rejectionBodyTracker(fields, Number(status[1]));
      const onBody = (body: Buffer): void => {
        try {
          const { length, complete } = consumeBody(body);
          if (length > 0 && !client.write(body.subarray(0, length))) upstream.pause();
          if (complete) {
            client.end();
            upstream.destroy();
          }
        } catch {
          tearDown();
        }
      };
      client.on('drain', () => upstream.resume());
      client.write(responseHead.subarray(0, end + 4));
      upstream.on('data', onBody);
      onBody(responseHead.subarray(end + 4));
    } catch {
      tearDown();
    }
  };
  upstream.on('data', onResponse);
}

export async function startStaticServer(opts: StaticServerOptions): Promise<StaticServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const allowRemote = opts.allowRemote === true;
  const host = allowRemote ? '0.0.0.0' : '127.0.0.1';

  // The HTTP server listens only on loopback — user traffic hits the outer
  // net.Server first. We route to this server for everything except WS
  // upgrades and STT stream upgrades, which go straight to the backend via a raw TCP splice.
  //
  // Why two listeners instead of using `http.Server`'s native `upgrade` event:
  // bun 1.3's http-compat layer does not faithfully forward writes on the
  // socket delivered to the `upgrade` handler, so the backend's 101 response
  // never reaches the browser (see #2824). Making the outer listener pure
  // TCP avoids touching that code path on both bun and node.
  const http_server: Server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        res.writeHead(400).end();
        return;
      }

      // /api/* — reverse proxy to backend (includes /api/auth/*).
      // /login and /logout are the backend's top-level auth endpoints: proxy them too
      // so WebUI browser clients reach the backend without a path-rewrite.
      if (req.url.startsWith('/api/') || req.url.startsWith('/api?') || req.url === '/login' || req.url === '/logout') {
        forwardToBackend(req, res, opts.backendPort);
        return;
      }

      // static files + SPA fallback
      await serveHandler(req, res, {
        public: opts.staticDir,
        rewrites: [{ source: '**', destination: '/index.html' }],
      });
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
      } else {
        res.destroy();
      }
    }
  });

  // Internal HTTP server — 127.0.0.1 ephemeral port, never visible to the user.
  await new Promise<void>((resolve, reject) => {
    http_server.once('error', reject);
    http_server.listen(0, '127.0.0.1', () => {
      http_server.off('error', reject);
      resolve();
    });
  });
  const internalPort = (http_server.address() as { port: number } | null)?.port;
  if (!internalPort) {
    throw new Error('internal HTTP server failed to bind to a port');
  }

  // User-facing listener: inspect the opening header of upgrade candidates and
  // route to either the backend (for /ws and /api/stt/stream upgrades) or the internal HTTP
  // server (everything else). Both routes use raw TCP splice — no reliance
  // on http.Server's upgrade event.
  const tcp_server = net.createServer((client: Socket) => {
    let peeked = Buffer.alloc(0);
    let settled = false;
    client.setTimeout(HANDSHAKE_TIMEOUT_MS);
    const onTimeout = (): void => {
      cleanup();
      client.destroy();
    };
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      client.removeListener('data', onData);
      client.removeListener('error', onEarlyError);
      client.removeListener('end', onEarlyEnd);
      client.removeListener('timeout', onTimeout);
      client.setTimeout(0);
    };
    const onData = (chunk: Buffer): void => {
      peeked = Buffer.concat([peeked, chunk]);
      const lineEnd = peeked.indexOf('\r\n');
      if (lineEnd < 0 && peeked.length < PEEK_LIMIT_BYTES) return;
      const candidate = /^GET \/(?:ws|api\/stt\/stream)(?:\?[^\s]*)? HTTP\/1\.1$/.test(
        peeked.toString('latin1', 0, lineEnd)
      );
      if (!candidate && lineEnd >= 0) {
        cleanup();
        spliceToTcpEndpoint(client, internalPort, peeked);
        return;
      }
      const headEnd = peeked.indexOf('\r\n\r\n');
      if (headEnd < 0 && peeked.length < PEEK_LIMIT_BYTES) return;
      cleanup();
      if (headEnd < 0 || headEnd + 4 > PEEK_LIMIT_BYTES) {
        rejectConnection(client, 431, 'Request Header Fields Too Large');
        return;
      }
      const head = peeked.subarray(0, headEnd + 4);
      const fields = parseHeaderFields(head);
      if (!fields) {
        rejectConnection(client, 400, 'Bad Request');
        return;
      }
      if (!fields.has('upgrade')) {
        // Ordinary HTTP (including keep-alive/pipelined follow-ups) must stay
        // behind forwardToBackend, which assigns the WebUI identity marker.
        spliceToTcpEndpoint(client, internalPort, peeked);
        return;
      }
      const key = fields.get('sec-websocket-key');
      if (
        fields.get('upgrade')?.toLowerCase() !== 'websocket' ||
        !hasUpgradeToken(fields.get('connection')) ||
        fields.get('sec-websocket-version') !== '13' ||
        !fields.get('host') ||
        !key ||
        !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
        fields.has('transfer-encoding') ||
        (fields.has('content-length') && !/^0+$/.test(fields.get('content-length') ?? ''))
      ) {
        rejectConnection(client, 400, 'Bad Request');
        return;
      }
      spliceWebSocket(client, opts.backendPort, head, key);
    };
    const onEarlyError = (): void => {
      cleanup();
      client.destroy();
    };
    const onEarlyEnd = (): void => {
      // Client closed before we saw a request line — nothing to route.
      cleanup();
      client.destroy();
    };
    client.on('data', onData);
    client.on('error', onEarlyError);
    client.on('end', onEarlyEnd);
    client.on('timeout', onTimeout);
  });

  await new Promise<void>((resolve, reject) => {
    tcp_server.once('error', reject);
    tcp_server.listen(port, host, () => {
      tcp_server.off('error', reject);
      resolve();
    });
  });

  const actualPort = (tcp_server.address() as { port: number } | null)?.port ?? port;
  const lanIP = allowRemote ? (getLanIP() ?? undefined) : undefined;
  const localUrl = `http://127.0.0.1:${actualPort}`;
  const networkUrl = lanIP ? `http://${lanIP}:${actualPort}` : undefined;

  return {
    port: actualPort,
    url: networkUrl ?? localUrl,
    localUrl,
    networkUrl,
    lanIP,
    stop: () =>
      new Promise<void>((resolve) => {
        tcp_server.close(() => {
          http_server.close(() => resolve());
        });
      }),
  };
}

export async function stopStaticServer(handle: StaticServerHandle): Promise<void> {
  await handle.stop();
}
