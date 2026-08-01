# Threadshare Maintenance

Threadshare is an independent API, read-only viewer, and CLI for AI agent conversation threads. Keep it independent of Paseo, Codex, Claude Code, any personal domain, and cloud credentials.

## Public Contract

- The canonical producer format is `threadshare-history@v1`; its schema is `schema/threadshare-history.v1.schema.json`.
- `POST /api/v1/shares` accepts one validated history plus optional lifecycle headers and returns `{ "id": "<uuid>" }` with optional confirmed `expiresAt` and `revocable: true` fields.
- `GET /api/v1/shares/:id` returns only the history or 404. Viewer links use `/?id=<uuid>` and optional `#message-<entry-id>` anchors.
- `DELETE /api/v1/shares/:id` requires the raw revoke capability as Bearer authorization and returns 204 or an intentionally indistinguishable 404. Do not expose DELETE through Viewer CORS or browser UI.
- The CLI defaults to `https://cloud-thread.team-harness.com`; `--url` and `THREADSHARE_URL` are explicit overrides.
- New producers must use Threadshare's format. The API accepts the legacy Paseo shape only for migration; do not extend that legacy contract.
- Objects always use `shares/<uuid>.json`. New writes use the internal `threadshare-object@v1` wrapper; successful reads must unwrap it, while old bare canonical and migration-only legacy objects stay readable. Never accept client object keys, arbitrary file uploads, redirects, or MIME types.
- Preserve JSON-only content type checks, the 5 MiB limit, strict validation, `no-store` history reads, and untrusted Markdown rendering.
- Shares remain permanent and non-revocable by default. Expiration strictly denies reads at the deadline and uses best-effort lazy deletion; raw revoke capabilities are client-only and storage contains only their SHA-256 digest.

## Responsibilities

- `src/share-schema.ts` and `src/share-api.ts` own the portable format and HTTP validation.
- `src/stored-share.ts` owns the internal lifecycle wrapper, expiration checks, capability parsing, hashing, and constant-time digest comparison.
- `src/session-export.mjs` owns Codex and Claude local JSONL conversion. It must export only visible conversation content, never raw system prompts, credentials, or provider settings.
- `src/share-preflight.mjs` owns content-free local reports; `src/share-read.mjs` owns bounded canonical remote reads and Markdown formatting.
- `app.js` and `src/viewer-state.mjs` own the read-only Viewer, message anchors, turn directory, and local folding behavior.
- `bin/threadshare.mjs` is a stable automation surface. Actual share/publish `--json` output must stay a one-line object containing at least `id` and `url`; dry-run JSON must stay one-line, report `dryRun`/`valid`, and never fabricate an `id` or URL.
- `skills/threadshare/` is the Codex and Codex Cloud workflow contract. Keep its commands aligned with the CLI and validate it with `skill-creator/scripts/quick_validate.py` after changes.
- `worker.ts` (Cloudflare/R2) and `fc/handler.ts` (Alibaba FC/OSS) are storage adapters. Keep behavior equivalent.

## Verification

Run the exact checks affected by a change:

```bash
npm run test:cli
npm run test:viewer
npm run test:api
npm run build:cloudflare
npm run test:fc
```

Before publishing npm, run `npm pack --dry-run --json`, confirm only CLI, protocol, Skill, README, and license files are included, then publish `@team-harness/threadshare` with public access. Verify installation in a temporary prefix; do not rely only on the source checkout.

Do not commit generated deployment state, `node_modules`, storage credentials, `.void/`, `.wrangler/`, `fc/.licell/`, `fc/dist/`, or `fc/static-assets.ts`.
