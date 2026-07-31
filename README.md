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

### 2. Share a Conversation

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

```text
threadshare messages <codex|claude|paseo> <session-id|file|agent-id> --format json [--before <user-message-id>] [--offset <n>] [--limit <n>]
threadshare export <codex|claude|paseo> <session-id|file|agent-id> [--from <user-message-id|last-user>] [--before <user-message-id>] [--output <file|->]
threadshare publish <history.json|-> [--url <service-url>] [--json]
threadshare share <codex|claude|paseo> <session-id|file|agent-id> [--from <user-message-id|last-user>] [--before <user-message-id>] [--pick-start] [--url <service-url>] [--json]
threadshare validate <history.json|->
```

- `share` exports and publishes a native session in one step.
- `messages` returns redacted, single-line user-turn previews for an agent-driven start selection. `--format json` is required; the default and maximum page sizes are 10 and 50.
- `export` creates canonical JSON without uploading it.
- `publish` uploads an existing `threadshare-history@v1` document.
- `validate` checks a protocol document locally.

For example, review an export before publishing it:

```bash
threadshare export codex <session-id> --output history.json
threadshare validate history.json
threadshare publish history.json --json
```

Codex sessions are searched below `$CODEX_HOME/sessions` when configured, otherwise `~/.codex/sessions`. Claude Code sessions are searched below `~/.claude/projects`. An explicit JSONL path can be used when a partial ID is ambiguous.

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

The exporter includes visible user messages, assistant text, thoughts, and tool activity. It skips hidden, metadata, and sidechain records, and it excludes raw system prompts and provider configuration. Native logs sometimes encode agent-injected orchestration context as `role: "user"`; Threadshare treats known wrappers of that kind as hidden in both full and ranged exports.

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

FC proxies reads and writes to a private OSS bucket. Use a dedicated RAM principal limited to `GetObject` and `PutObject` on the `shares/` prefix.

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
POST /api/v1/shares       -> { "id": "<uuid>" }
GET  /api/v1/shares/:id   -> threadshare history JSON
Viewer                    -> /?id=<uuid>#message-<entry-id>
```

`POST` accepts only `application/json`, strictly validates the document, and limits payloads to 5 MiB. Storage keys are always `shares/<uuid>.json`; clients cannot choose object keys, file names, or MIME types.

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
npm run test:api
npm run test:fc
```
