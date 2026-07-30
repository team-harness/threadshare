# Threadshare Maintenance

Threadshare is an independent API, read-only viewer, and CLI for AI agent conversation threads. Keep it independent of Paseo, Codex, Claude Code, any personal domain, and cloud credentials.

## Public Contract

- The canonical producer format is `threadshare-history@v1`; its schema is `schema/threadshare-history.v1.schema.json`.
- `POST /api/v1/shares` accepts one validated history and returns `{ "id": "<uuid>" }`.
- `GET /api/v1/shares/:id` returns that history or 404. Viewer links use `/?id=<uuid>` and optional `#message-<entry-id>` anchors.
- New producers must use Threadshare's format. The API accepts the legacy Paseo shape only for migration; do not extend that legacy contract.
- Objects always use `shares/<uuid>.json`. Never accept client object keys, arbitrary file uploads, redirects, or MIME types.
- Preserve JSON-only content type checks, the 5 MiB limit, strict validation, `no-store` history reads, and untrusted Markdown rendering.

## Responsibilities

- `src/share-schema.ts` and `src/share-api.ts` own the portable format and HTTP validation.
- `src/session-export.mjs` owns Codex and Claude local JSONL conversion. It must export only visible conversation content, never raw system prompts, credentials, or provider settings.
- `bin/threadshare.mjs` is stable automation surface. `--json` output must stay a one-line JSON object containing at least `id` and `url`.
- `worker.ts` (Cloudflare/R2) and `fc/handler.ts` (Alibaba FC/OSS) are storage adapters. Keep behavior equivalent.

## Verification

Run the exact checks affected by a change:

```bash
npm run test:cli
npm run build:cloudflare
npm run test:fc
```

Do not commit generated deployment state, `node_modules`, storage credentials, `.void/`, `.wrangler/`, `fc/.licell/`, `fc/dist/`, or `fc/static-assets.ts`.
