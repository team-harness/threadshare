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
- `skills/threadshare/` is the Codex and Codex Cloud workflow contract. Keep its commands aligned with the CLI and validate it with `npm run validate:skill` after changes.
- `worker.ts` (Cloudflare/R2) and `fc/handler.ts` (Alibaba FC/OSS) are storage adapters. Keep behavior equivalent.

## Verification

Run the exact checks affected by a change:

```bash
npm run test:cli
npm run test:viewer
npm run test:api
npm run test:release
npm run build:cloudflare
npm run test:fc
npm run validate:skill
```

## npm Releases

Stable npm releases are published only by `.github/workflows/publish-npm.yml` from a GitHub Release. Do not run local `npm publish`, store an npm token in GitHub, move a published tag, or create the next stable Release before the current release workflow succeeds.

One-time npm package settings:

- Trusted Publisher: organization `team-harness`, repository `threadshare`, workflow `publish-npm.yml`, no Environment, and allowed action `npm publish` only.
- Publishing access: require 2FA and disallow token publishing. Trusted Publishing remains the automation path.

For each stable release:

1. Set the same unprefixed stable version in `package.json`, the lockfile top level, and the lockfile root package.
2. Run the full verification above plus `npm pack --dry-run --ignore-scripts --json` with Node 22.22.3 and npm 12.0.2. Confirm the exact 16-file allowlist defined by `EXPECTED_PACKAGE_FILES` in `scripts/verify-release.mjs` and record its integrity.
3. Commit and push the candidate to `main`. Confirm no earlier stable release run is active, pending, cancelled, or failed.
4. Create the release from that exact commit, for example `gh release create 0.4.2 --target <full-main-commit> --title 0.4.2 --generate-notes`. Do not mark it as a prerelease.
5. Find the run with `gh run list --workflow publish-npm.yml --limit 10`, require it to finish successfully, then verify npm `latest`, SLSA provenance, and installation into a temporary prefix; do not rely only on the source checkout.

The workflow pins GitHub Actions, Node, and npm. Update those pins together with the release automation tests. A rerun of an already published release must use `gh run rerun <run-id>` so it retains the original event SHA and pinned toolchain.

Recovery rules:

- If npm does not contain the target version and the workflow failed before publish, fix `main`, then delete the unpublished release and tag with `gh release delete <version> --cleanup-tag --yes`; recreate it from the fixed commit.
- If npm contains the target version and only registry confirmation failed transiently, get the run ID from `gh run list --workflow publish-npm.yml --limit 10`, then use `gh run rerun <run-id>`. Never delete or move its tag.
- If npm contains the version and the workflow itself is wrong, keep that release immutable, fix `main`, and publish a new version.
- A cancelled run is incomplete. Rerun it before any higher release. If a higher version already reached npm, never backfill the lower version.

Do not commit generated deployment state, `node_modules`, storage credentials, `.void/`, `.wrangler/`, `fc/.licell/`, `fc/dist/`, or `fc/static-assets.ts`.
