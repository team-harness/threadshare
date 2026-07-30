# Threadshare

[English](./README.md) | [简体中文](./README.zh-CN.md)

Threadshare is a self-hostable API, read-only web viewer, and CLI for sharing AI coding-agent conversation threads. It is independent of Paseo, Codex, Claude Code, a particular cloud, and a personal domain.

The repository owns the portable `threadshare-history@v1` protocol. Producers convert their native conversation data into this format; Threadshare validates, stores, and serves it at a stable URL.

## Quick Start

Install the public CLI package:

```bash
npm install --global @team-harness/threadshare
threadshare share codex <session-id-or-jsonl-file>
threadshare share claude <session-id-or-jsonl-file> --json
```

Run without installing:

```bash
npx --yes @team-harness/threadshare@latest share codex <session-id-or-jsonl-file>
```

The CLI defaults to the hosted service at `https://cloud-thread.team-harness.com`. Override it with `--url <service-url>` or `THREADSHARE_URL`. The plain command prints a viewer URL. `--json` prints `{"id":"...","url":"..."}`, which is intended for agents and scripts.

The CLI deliberately exports only user messages, assistant text, thoughts, and tool calls. It does not upload raw session metadata, system prompts, credentials, or provider configuration.

## CLI

```text
threadshare export <codex|claude> <session-id|file> [--output <file|->]
threadshare publish <history.json|-> [--url <service-url>] [--json]
threadshare share <codex|claude> <session-id|file> [--url <service-url>] [--json]
threadshare validate <history.json|->
```

`export` finds Codex sessions under `$CODEX_HOME/sessions` when configured, otherwise `~/.codex/sessions`; Claude Code sessions are read from `~/.claude/projects`. Pass an explicit JSONL path when a partial identifier is ambiguous. `publish` accepts a `threadshare-history@v1` file or stdin, so any agent can integrate without a provider-specific SDK.

## Agent Skill

The bundled `threadshare` Skill teaches Codex and Codex Cloud when and how to share a session, verify the resulting JSON, and avoid disclosing local paths or transcript contents during routine checks.

Install it for Codex from GitHub:

```bash
npx --yes skills add team-harness/threadshare --skill threadshare --agent codex --global --yes
```

For Codex Cloud, install it at project scope during environment setup by omitting `--global`. The Skill lives at [`skills/threadshare`](./skills/threadshare).

## Protocol

The canonical JSON Schema is [schema/threadshare-history.v1.schema.json](./schema/threadshare-history.v1.schema.json). A document starts as follows:

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

Entries are messages, tool calls, thoughts, todos, activity records, or compaction markers. The viewer treats all transcript text as untrusted: raw HTML is escaped and unsafe links remain labels.

For migration only, the API also accepts the former Paseo v1 shape. New producers must emit `threadshare-history@v1`; Threadshare does not require Paseo at runtime.

## HTTP API

The viewer and API use one origin:

```text
POST /api/v1/shares       -> { "id": "<uuid>" }
GET  /api/v1/shares/:id   -> threadshare history JSON
Viewer                    -> /?id=<uuid>#message-<entry-id>
```

`POST` accepts only `application/json`, strictly validates the document, and limits payloads to 5 MiB. Storage keys are always `shares/<uuid>.json`; clients cannot choose object keys, file names, or MIME types. Configure rate limits at the hosting edge for publicly exposed instances.

## Deploy

### Cloudflare Workers + R2

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create threadshare-shares
npm run deploy:cloudflare
```

`wrangler.jsonc` serves Vite assets and binds `THREADSHARE_BUCKET` to R2. Bind a custom domain in Cloudflare after the first deploy. Do not commit account IDs, API tokens, or bucket credentials.

### Alibaba Cloud Function Compute + OSS

```bash
npm install
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

FC proxies reads and writes to a private bucket. Use a dedicated RAM principal limited to `GetObject` and `PutObject` on the `shares/` prefix. Deployment state under `.licell/`, `.void/`, and `.wrangler/` is ignored by Git.

### Void

Void deployment is supported for the Vite viewer. Bind its object storage before exposing a write API, then deploy with:

```bash
npx void init
npm run deploy:void
```

## Paseo Integration

Paseo is one producer. Configure its daemon with the Threadshare public URL:

```json
{
  "daemon": {
    "chatShare": { "baseUrl": "https://cloud-thread.team-harness.com" }
  }
}
```

Paseo only uploads validated transcript JSON to this API. It contains no cloud credentials and does not depend on this repository's deployment implementation.

## Verification

```bash
npm run build:cloudflare
npm run test:cli
npm run test:fc
```
