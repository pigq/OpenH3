# OpenH3 Gateway

Cloudflare Worker gateway for the OpenAI Responses API. The upstream API key is
read only from a Cloudflare Secret and is never stored in the OpenH3 client or
repository.

## Deploy

From this directory:

```bash
npx wrangler login
npx wrangler secret put UPSTREAM_API_KEY
npx wrangler deploy
```

The deployed endpoint is:

```text
https://<worker-name>.<account>.workers.dev/v1/responses
```

`UPSTREAM_BASE_URL`, `DEFAULT_MODEL`, and `DEFAULT_REASONING_EFFORT` are public
configuration values in `wrangler.toml`. The Worker secret is the only place
where the upstream credential is stored. Never put that credential in the
desktop build, repository, GitHub Actions logs, or client requests.

## Contract

- `POST /v1/responses` forwards the OpenAI Responses request.
- The Worker forces `gpt-6-astra` and `{ "effort": "low" }` for every request.
- `GET /v1/models` exposes only the supported model.
- `GET /health` returns a basic readiness response.
- Chat Completions are intentionally not exposed.

Before broad public distribution, add Cloudflare rate limiting or another
quota policy. The desktop client must point at the deployed public URL using
the build-time `OPENH3_GATEWAY_URL` value; it never receives the upstream key.
