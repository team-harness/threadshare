# Threadshare

[English](./README.md) | [简体中文](./README.zh-CN.md)

Threadshare turns Codex, Claude Code, and Paseo agent conversations into read-only web links.

Install the CLI and share through the hosted service at [cloud-thread.team-harness.com](https://cloud-thread.team-harness.com) without deploying anything first.

The same viewer, API, and portable `threadshare-history@v1` format can be self-hosted when you need your own domain, storage, or infrastructure controls. Threadshare remains independent of any agent provider or cloud platform.

## Quick Start

Threadshare requires Node.js 20 or newer.

### 1. Install the CLI

```bash
npm install --global @team-harness/threadshare
```

### 2. Find a Session

When you do not already have the native session ID, list the 10 most recently updated sessions:

```bash
threadshare sessions codex
threadshare sessions claude
```

Each entry includes the complete session ID, update time, project, Git branch, and a redacted preview of the first visible user request. This command reads local files only and does not upload anything. Use `--offset <n>` and `--limit <n>` to page, or add `--format json` for the stable one-line response expected by agents and scripts.

### 3. Share a Conversation

Choose the provider that owns the session:

```bash
# Codex or Codex Cloud
threadshare share codex <session-id-or-jsonl-file>

# Claude Code
threadshare share claude <session-id-or-jsonl-file>

# A Codex- or Claude-backed Paseo agent
threadshare share paseo <agent-id-or-prefix>
```

`share` exports visible conversation content, validates it, uploads it to the default hosted service, and prints a Viewer URL:

```text
https://cloud-thread.team-harness.com/?id=<share-id>
```

Add `--json` for the one-line `{"id":"...","url":"..."}` response expected by agents and scripts.

### Check Before Uploading

Run the same export, range selection, validation, and 5 MiB size check without contacting the service:

```bash
threadshare share codex <session-id> --dry-run
threadshare share codex <session-id> --dry-run --report --json
```

`--report` adds aggregate byte size and limit, total entries, entry kinds, message roles, native user turns, and redaction markers. It does not include transcript text, tool data, provider settings, or local paths. A failed or oversized dry run exits non-zero and never falls back to publishing.

### Control Share Lifetime

Shares are permanent and not revocable by default. Choose an expiration from 1 minute to 365 days, or request a one-time revocation capability:

```bash
threadshare share codex <session-id> --expires 7d
threadshare share codex <session-id> --revoke --json
threadshare revoke <viewer-url> --token <revoke-token> --json
```

The server confirms an expiration as `expiresAt`. With `--revoke`, human output prints a one-time revoke command to stderr while `--json` includes `revokeToken`. Store that token when the share is created: it cannot be recovered, it must never be added to the Viewer URL, and the service stores only its SHA-256 digest. Expired and revoked shares read as 404. Expiration is enforced at read time; physical object deletion is best-effort and may wait until a later read.

### Read a Share with an Agent

Use the CLI instead of scraping the Viewer when an agent needs the complete canonical conversation:

```bash
threadshare read '<viewer-or-api-url>' --format json
threadshare read '<viewer-url>#message-<entry-id>' --format markdown
```

`read` accepts canonical Viewer and API URLs, ignores a valid message anchor, refuses redirects, enforces the 5 MiB limit, and validates `threadshare-history@v1` again. The Viewer remains optimized for people with a user-turn directory and collapsed tool/thought details; its single-line agent prompt copies the same source JSON URL.

### Share From A User Message

In an interactive terminal, let Threadshare show the 10 most recent user turns and choose where the shared conversation starts:

```bash
threadshare share paseo <agent-id-or-prefix> --pick-start
```

Enter `m` to load 10 older turns or `q` to cancel. The selected user turn is included, and the share continues to the end of the snapshot. `--pick-start` cannot be combined with `--from` or `--before`.

Agents use the non-interactive candidate command instead. It treats the latest user turn as an exclusive boundary, which keeps the sharing request and the subsequent selection workflow out of the published conversation:

```bash
threadshare messages paseo <agent-id-or-prefix> --format json
threadshare messages paseo <agent-id-or-prefix> --format json \
  --before <original-boundary-id> --offset <next-offset>
threadshare share paseo <agent-id-or-prefix> \
  --from <selected-message-id> --before <original-boundary-id> --json
```

`messages` returns the 10 most recent candidates before the boundary, newest first. Its one-line JSON contains `boundaryId`, `boundaryPreview`, `messages`, `hasMore`, and `nextOffset`. An agent should verify that `boundaryPreview` matches the current sharing request, show only numbered previews to the user, retain the original `boundaryId` while loading more, and keep message IDs internal. If the current request is not yet persisted, retry once or stop instead of guessing the boundary.

For scripts that already know the exact user-message ID, `--from` is inclusive and `--before` is exclusive. `--from last-user` selects the last user turn before `--before`, or the snapshot's last user turn when no boundary is supplied. A native user turn with multiple text blocks is always selected as one unit.

When neither `--from` nor `--before` is supplied, `share` and `export` keep their default behavior and process the full visible snapshot. An explicitly empty range value is invalid and exits without publishing, so a failed selection cannot silently become a full share.

Viewer URLs are unlisted, not access-controlled. Anyone with the URL can read the shared conversation, so review the content before sharing it.

Paseo sharing requires the local `paseo` CLI and a reachable daemon. Threadshare resolves the agent's native Codex or Claude session without modifying Paseo or uploading its state file.

### Run Without Installing

```bash
npx --yes @team-harness/threadshare@latest share codex <session-id-or-jsonl-file>
```

### Use Another Threadshare Server

The hosted service is the default. Override it per command or for the current shell when you want to use a self-hosted deployment:

```bash
threadshare share codex <session-id> --url https://threadshare.example.com
export THREADSHARE_URL=https://threadshare.example.com
```

## CLI Reference

The CLI help is the canonical parameter reference. It describes every argument and option, including defaults, constraints, output, agent notes, security boundaries, and recovery guidance:

```bash
threadshare --help
threadshare <command> --help
```

Regular failures exit 1 with empty stdout and print a stable error code plus `Problem`, `Usage`, and `Next` on stderr. The deliberate exception is an invalid `share --dry-run --json`, which returns its one-line `valid:false` result on stdout. When an upload may have created a share but cannot confirm the requested lifecycle, the diagnostic includes a `Result` URL; do not retry that publish automatically.

- `share` exports and publishes a native session in one step. `--dry-run` stops before network access; `--report` is valid only with `--dry-run`.
- `sessions` lists canonical native Codex or Claude sessions without uploading. Text is for people; `--format json` is the stable automation surface. The default and maximum page sizes are 10 and 50.
- `messages` returns redacted, single-line user-turn previews for an agent-driven start selection. `--format json` is required; the default and maximum page sizes are 10 and 50.
- `export` creates canonical JSON without uploading it.
- `publish` uploads an existing `threadshare-history@v1` document. `share` and `publish` accept `--expires` and `--revoke`.
- `read` downloads and validates a canonical share as JSON or Markdown without following redirects.
- `revoke` deletes a capability-enabled share. The raw token is sent only as Bearer authorization.
- `validate` checks a protocol document locally.

For example, review an export before publishing it:

```bash
threadshare export codex <session-id> --output history.json
threadshare validate history.json
threadshare publish history.json --json
```

Codex sessions are searched below `$CODEX_HOME/sessions` when configured, otherwise `~/.codex/sessions`. Claude Code sessions are searched below `~/.claude/projects`. `sessions` lists canonical UUID-backed main sessions and excludes Claude subagent logs. Ambiguous duplicate IDs are skipped and reported instead of selecting an arbitrary file. An explicit JSONL path can be used when a partial ID is ambiguous.

A Paseo agent reference must be a full UUID or a unique UUID prefix. Threadshare asks the Paseo CLI for the daemon home, reads only the matching local agent metadata, and passes its native session ID to the regular Codex or Claude exporter.

Only Codex- and Claude-backed Paseo agents are supported. A running agent produces a best-effort snapshot of content already persisted by its native provider, so an in-flight tail may be absent.

## Install the Codex Skill

The bundled `threadshare` Skill teaches Codex and Codex Cloud how to locate, share, and verify sessions without printing transcript contents or local paths during routine checks.

Install it globally for Codex:

```bash
npx --yes skills add team-harness/threadshare --skill threadshare --agent codex --global --yes
```

The Skill uses the installed CLI when available and falls back to `npx`. For Codex Cloud, omit `--global` during environment setup to install it at project scope. The source lives in [`skills/threadshare`](./skills/threadshare).

## Privacy and Sharing Model

Viewer URLs are read-only and unlisted, but they are not access-controlled. Anyone with a URL can read the shared conversation.

By default, a share has no expiration and no revoke capability. `--expires` adds a logical read deadline; `--revoke` creates a client-held capability whose raw value is shown only at creation. Do not place capability tokens in URLs, transcripts, issue trackers, or logs.

The exporter includes visible user messages, assistant text, thoughts, and tool activity. It skips hidden, metadata, and sidechain records, and it excludes raw system prompts and provider configuration. Native logs sometimes encode agent-injected orchestration context as `role: "user"`; Threadshare treats known wrappers of that kind as hidden in both full and ranged exports.

The local `sessions` command does not publish transcripts. It reads file metadata and scans at most the first 1 MiB of each session on the requested page to obtain a best-effort summary. Preview text uses the same credential redaction as sharing; project and branch remain local identification metadata.

For a ranged share, Threadshare first associates tool results with their calls and then reconstructs each tool's state at the exclusive boundary. A result written after `--before` is not included, even when its call occurred earlier.

Common credential fields and token patterns are redacted on a best-effort basis. Visible messages and tool input or output can still contain sensitive data that is not recognized, so review a conversation before sharing it.

## Self-Host Threadshare

You can use the default hosted service without this section. Self-host when you need to control the domain, object storage, region, rate limits, or deployment lifecycle.

Start from a repository checkout:

```bash
git clone https://github.com/team-harness/threadshare.git
cd threadshare
npm install
```

After deployment, point the CLI at the new origin with `--url` or `THREADSHARE_URL`. The Viewer and API must use the same origin.

### Cloudflare Workers + R2

```bash
npx wrangler login
npx wrangler r2 bucket create threadshare-shares
npm run deploy:cloudflare
```

`wrangler.jsonc` serves the Vite assets and binds `THREADSHARE_BUCKET` to R2. Bind a custom domain in Cloudflare after the first deploy. Do not commit account IDs, API tokens, or bucket credentials.

### Alibaba Cloud Function Compute + OSS

```bash
npm run build:fc
cd fc
licell login
licell workspace init --type api --app threadshare-fc --runtime nodejs22 \
  --entry dist/index.cjs --target prod --disable-vpc --region cn-shanghai
licell oss create threadshare-shares-your-name --acl private --public-access-block on
licell env set THREADSHARE_OSS_BUCKET threadshare-shares-your-name
licell env set THREADSHARE_OSS_REGION cn-shanghai
licell env set THREADSHARE_OSS_ACCESS_KEY_ID <ram-access-key-id>
licell env set THREADSHARE_OSS_ACCESS_KEY_SECRET <ram-access-key-secret>
cd ..
npm run deploy:fc
```

FC proxies reads and writes to a private OSS bucket. Use a dedicated RAM principal limited to `GetObject`, `PutObject`, and `DeleteObject` on the `shares/` prefix.

Local state under `fc/.licell/`, `.void/`, and `.wrangler/` is ignored by Git and must not be committed.

### Void Viewer

Void can deploy the Vite Viewer. Bind object storage before exposing a write API:

```bash
npx void init
npm run deploy:void
```

## Protocol and API

New producers convert native conversations to `threadshare-history@v1`. The canonical schema is [`schema/threadshare-history.v1.schema.json`](./schema/threadshare-history.v1.schema.json).

```json
{
  "format": "threadshare-history@v1",
  "schemaVersion": 1,
  "exportedAt": "2026-07-30T00:00:00.000Z",
  "conversation": {
    "id": "provider-session-id",
    "title": "Conversation title",
    "provider": "codex",
    "source": "codex"
  },
  "entries": []
}
```

Entries can represent messages, tool calls, thoughts, todos, activity, or compaction markers. The Viewer treats transcript text as untrusted: raw HTML is escaped and unsafe links remain labels.

The legacy Paseo v1 shape is accepted only for migration. New producers must use `threadshare-history@v1`, and Threadshare does not require Paseo at runtime.

### HTTP API

```text
POST   /api/v1/shares       -> { "id": "<uuid>", "expiresAt"?: "...", "revocable"?: true }
GET    /api/v1/shares/:id   -> threadshare history JSON or 404
DELETE /api/v1/shares/:id   -> 204 with a valid Bearer revoke capability
Viewer                      -> /?id=<uuid>#message-<entry-id>
```

`POST` accepts only `application/json`, strictly validates the document, and limits payloads to 5 MiB. Storage keys are always `shares/<uuid>.json`; clients cannot choose object keys, file names, or MIME types.

Lifecycle metadata stays outside the portable history. A client may send `x-threadshare-expires-in` with 60 to 31,536,000 seconds and/or `x-threadshare-revoke-token-sha256` with a SHA-256 base64url digest. New objects use an internal `threadshare-object@v1` wrapper, while successful `GET` responses always return only the history. Old bare history objects remain readable.

Expiration is checked on every read and triggers best-effort lazy deletion. `DELETE` requires `Authorization: Bearer <raw-token>` and intentionally returns the same 404 for a missing object, unsupported revocation, or an invalid capability. Revocation is a CLI/direct-API operation and is not exposed through Viewer CORS or browser UI.

History reads use `Cache-Control: no-store` so a shared transcript is not retained by intermediary caches.

Configure rate limits at the hosting edge for publicly exposed instances.

### Paseo as a Producer

The CLI bridge in Quick Start works without changing Paseo. For native producer integration, [team-harness/paseo](https://github.com/team-harness/paseo) is a customized distribution with built-in Thread Share support.

Configure its daemon with a Threadshare origin:

```json
{
  "daemon": {
    "chatShare": { "baseUrl": "https://cloud-thread.team-harness.com" }
  }
}
```

Paseo uploads only validated transcript JSON. It contains no cloud credentials and does not depend on this repository's deployment implementation.

## Development

Run the checks affected by a change:

```bash
npm run build:cloudflare
npm run test:cli
npm run test:viewer
npm run test:api
npm run test:fc
```
