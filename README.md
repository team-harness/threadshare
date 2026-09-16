# Threadshare

[English](./README.md) | [简体中文](./README.zh-CN.md) | [Usage guides](https://github.com/team-harness/threadshare/blob/main/docs/README.md)

Threadshare helps people and AI agents get on the same page—with the context behind a conversation and feedback on a shared document.

| What you share | When it helps | How collaboration continues |
|---|---|---|
| **Agent conversations** | Bring a teammate up to speed on a discussion, decision, or investigation without retelling the whole story. | Share a Codex, Claude Code, or Paseo conversation as a browser link. People read the context; another Agent can pick up the discussion. |
| **Markdown documents and images** | Review a proposal, requirements, or plan you drafted with your Agent. | Share the document, collect the team's comments beside selected passages, then bring the feedback back to your Agent to improve the original. |

Use [cloud-thread.team-harness.com](https://cloud-thread.team-harness.com) by default, or self-host
when you need your own domain and storage.

## Start With Your Agent

| Collaboration goal | Ask your Agent |
|---|---|
| Share a conversation | “Use Threadshare to share this chat. Run a preflight first, then give me the link.” |
| Share a selected portion | “Share from where we discussed the release failure. Let me confirm the starting message first.” |
| Ask a colleague to review | “Share our design discussion so a colleague can read the context, tradeoffs, and open questions.” |
| Hand context to an Agent | “Read this Threadshare link, summarize decisions and open questions, and help me continue.” |
| Review a document | “Share docs/design.md with its images so my teammates can select passages and comment.” |
| Act on feedback | “Read the reviews on this document link, group the issues, and propose changes before editing.” |

### One-Time Agent Setup

Requires Node.js 20 or newer:

```bash
npm install --global @team-harness/threadshare
npx --yes skills add team-harness/threadshare --skill threadshare --agent codex --global --yes
```

For Codex Cloud, omit `--global` during setup. The Agent locates the session, previews the content,
and publishes after confirmation. It discovers parameters through `threadshare <command> --help`;
you do not need a session ID or JSON. See the
[sharing guide](https://github.com/team-harness/threadshare/blob/main/docs/sharing-usage-guide.md).

### Direct CLI Equivalent

The CLI remains useful for terminal users, scripts, and troubleshooting. Use
`threadshare <command> --help` as the complete parameter reference.

```bash
# Discover a native session when you do not already know its ID
threadshare sessions codex
threadshare sessions claude

# Publish a visible conversation
threadshare share codex <session-id-or-jsonl-file>
threadshare share claude <session-id-or-jsonl-file>
threadshare share paseo <agent-id-or-prefix>
```

`share` validates and uploads the selected visible content to the default hosted service, then prints:

```text
https://cloud-thread.team-harness.com/?id=<share-id>
```

Add `--json` for the stable one-line response expected by Agents and scripts.

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

Share the normal Viewer URL with people or agents. Browsers receive the HTML Viewer; clients that explicitly
prefer `text/markdown` receive a compact, lossy review transcript from the same URL. The CLI produces that
representation by default without depending on server-side negotiation:

```bash
threadshare read '<viewer-or-api-url>'
threadshare read '<viewer-or-api-url>' --format agent
threadshare read '<viewer-or-api-url>' --format json
threadshare read '<viewer-url>#message-<entry-id>' --format markdown
```

The Agent transcript preserves every User/Assistant Markdown message and summarizes tool name, status, and
adjacent count. It omits tool input/output/error and thought, todo, activity, and compaction bodies. Use
`--format json` when those complete fields are required, or `--format markdown` for the existing full readable
transcript. Message Markdown remains untrusted; sanitize it before rendering with raw HTML enabled.

`read` accepts canonical Viewer, `format=agent` alternate, and API URLs, ignores a valid message anchor, refuses
redirects, enforces the 5 MiB canonical JSON limit, and validates `threadshare-history@v1` again. The Viewer's
agent review action copies the same canonical Viewer URL, not a separate API link.

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

### Share a Markdown Document for Review

Write with your Agent, review with your team, then bring the feedback back to your Agent. Use this workflow for design proposals, implementation plans, product requirements, or team guides.

| Step | What you do |
|---|---|
| 1. Draft together | Tell your Agent: “Help me write a design proposal in docs/design.md, including the diagrams and open questions.” |
| 2. Share with the team | Tell your Agent: “Use Threadshare to preview and share docs/design.md with its images. Give me the review link.” Send that link to your teammates. |
| 3. Review in context | Teammates open the link, select passages, and leave comments beside the text. No account is required. Multiple people can comment on the same passage, and comments survive a refresh. |
| 4. Improve with your Agent | Click **Copy prompt for Agent** at the top or bottom of the page, paste it into your Agent, and ask it to revise the original document using the feedback. |

For example, after reviewing an API proposal, tell your Agent:

> Read this document and its review comments: &lt;document-link&gt;. Group the feedback by passage, flag conflicting suggestions, and propose edits to docs/design.md. After I confirm, make the changes and summarize what was addressed and what still needs a decision.

The Agent can read the original text, quoted passages, and comments together. You do not need to copy each comment or explain which paragraph it refers to. Reviewer names are remembered in each browser, but are not verified identities.

Each link preserves the reviewed snapshot. Once the revised local file is ready, ask your Agent to share a new version; the earlier link keeps its original document and comments while it remains available.

For direct CLI use:

```bash
threadshare document share docs/design.md --dry-run --json
threadshare document share docs/design.md --revoke --expires 7d --json
threadshare document reviews '<document-url>' --format agent
```

Local PNG/JPEG/WebP/GIF images are uploaded with the Markdown. External images load only when the reader
chooses to load them. Each link is a fixed snapshot: edit locally and share again for a new version.
Comments are append-only. To revoke a share, save its `revokeToken` privately when sharing.

The CLI and server must both include the document-sharing update; this source change does not update an
older npm installation or deploy the hosted service automatically. See the
[document sharing guide](https://github.com/team-harness/threadshare/blob/main/docs/document-sharing-guide.md)
for self-hosting, limits, and Agent review exports. Discover options with `threadshare document --help`.

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
- `document` shares Markdown and images, reads documents and review comments, or revokes a document share. Discover its `share`, `read`, `reviews`, and `revoke` actions with `threadshare document --help`.
- `sessions` lists canonical native Codex or Claude sessions without uploading. Text is for people; `--format json` is the stable automation surface. The default and maximum page sizes are 10 and 50.
- `analyze` builds a local single-session Turn, Tool, Skill, retry, and rollback evidence report without uploading or calling an external model. Text is for people; `--format json` returns `threadshare-session-analysis@v1` for agents.
- `messages` returns redacted, single-line user-turn previews for an agent-driven start selection. `--format json` is required; the default and maximum page sizes are 10 and 50.
- `export` creates canonical JSON without uploading it.
- `publish` uploads an existing `threadshare-history@v1` document. `share` and `publish` accept `--expires` and `--revoke`.
- `read` defaults to compact `agent-transcript@v1`; `--format json` returns canonical data and `--format markdown` returns the complete readable transcript.
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

## Agent Integration Reference

The bundled `threadshare` Skill helps Codex and Codex Cloud locate, preview, share, and read
conversations and Markdown documents, collect reviews, and apply feedback. It uses the installed CLI when available and falls back to `npx`.
The source lives in [`skills/threadshare`](./skills/threadshare).

## Privacy and Sharing Model

Viewer URLs are unlisted, but not access-controlled. Conversation viewers are read-only; anyone with a document link can read it and append review comments.

By default, a share has no expiration and no revoke capability. `--expires` adds a logical read deadline; `--revoke` creates a client-held capability whose raw value is shown only at creation. Do not place capability tokens in URLs, transcripts, issue trackers, or logs.

The exporter includes visible user messages, assistant text, thoughts, and tool activity. It skips hidden, metadata, and sidechain records, and it excludes raw system prompts and provider configuration. Native logs sometimes encode agent-injected orchestration context as `role: "user"`; Threadshare treats known wrappers of that kind as hidden in both full and ranged exports.

The local `sessions` and `analyze` commands do not publish transcripts. `sessions` reads file metadata and scans at most the first 1 MiB of each session on the requested page to obtain a best-effort summary. `analyze` reads the selected native session locally and omits source paths, Tool arguments and output, Skill bodies, system prompts, and thinking from its report. Preview text uses the same credential redaction as sharing; project and branch remain local identification metadata.

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

FC proxies reads and writes to a private OSS bucket. Limit the RAM principal's object permissions to the conversation and document prefixes, and grant ListObjects/ListBucket for comment pagination and cleanup. Configure the document cleanup timer and function timeout as described in the [deployment guide](./docs/document-sharing-guide.md#后端与部署).

Local state under `fc/.licell/`, `.void/`, and `.wrangler/` is ignored by Git and must not be committed.

### Void Viewer

Void can deploy the Vite Viewer. Bind object storage before exposing a write API:

```bash
npx void init
npm run deploy:void
```

## Protocol and API

Conversation sharing and document review have separate versioned contracts:

| Data | Format | Schema |
|---|---|---|
| Conversation | `threadshare-history@v1` | [History](./schema/threadshare-history.v1.schema.json) |
| Immutable document and image manifest | `threadshare-document@v1` | [Document](./schema/threadshare-document.v1.schema.json) |
| One anchored comment | `threadshare-document-comment@v1` | [Document `$defs.comment`](./schema/threadshare-document.v1.schema.json#/$defs/comment) |
| Bounded document and review export | `threadshare-document-review@v1` | [Review export](./schema/threadshare-document-review.v1.schema.json) |

### Conversation format

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

### Conversation HTTP API

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

### Document and review HTTP API

```text
POST   /api/v1/documents/uploads                 -> {id, uploadToken, uploadExpiresAt}
PUT    /api/v1/documents/:id/uploads/markdown     -> 204
PUT    /api/v1/documents/:id/uploads/assets/:sha  -> 204
POST   /api/v1/documents/:id/publish              -> {id, revision, expiresAt, revocable}
GET    /api/v1/documents/:id                      -> threadshare-document@v1
GET    /api/v1/documents/:id/assets/:sha          -> declared image bytes
GET    /api/v1/documents/:id/comments             -> threadshare-document-comments@v1
GET    /api/v1/documents/:id/comments/:commentId  -> threadshare-document-comment@v1
PUT    /api/v1/documents/:id/comments/:commentId  -> 201 new / 200 identical retry / 409 conflict
DELETE /api/v1/documents/:id                      -> 204 with a valid Bearer revoke capability
Viewer                                          -> /document.html?id=<uuid>#comment-<commentId>
```

Create an upload declaration with `title`, `markdown: {sha256, bytes}`, and `assets: [{source, sha256, bytes, contentType}]`. Optional `expiresInSeconds` and `revokeTokenSha256` belong in this JSON, not the conversation lifecycle headers.

Upload the declared bytes and publish using `Authorization: Bearer <uploadToken>`. The upload token expires after one hour and is separate from the revoke token. Publishing validates the Markdown and all local images before exposing the snapshot.

A comment PUT accepts `{revision, anchor, authorName, body}`. Anchors use UTF-16 offsets in `document-anchor-text@1`, not Markdown source offsets; the server verifies the quoted text and context. Comments are immutable, and names are self-declared.

Comment pages contain `format`, `revision`, `comments`, `hasMore`, and `nextCursor`; use `limit` (1–100) and the opaque `cursor` to continue. CLI review exports add `complete` and traversal metadata under `threadshare-document-review@v1`.

The document URL returns HTML by default, or Markdown with document and review context for `?format=agent` or an explicitly preferred `Accept: text/markdown`. Web exports include at most 500 comments and disclose continuation; never assume a partial export is complete.

Document, image, and comment reads use `no-store`; unavailable, expired, or revoked documents return 404. Browser writes require the same origin. Both FC/OSS and Cloudflare/R2 use this contract. See the [document guide](./docs/document-sharing-guide.md) for limits and deployment requirements.

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
