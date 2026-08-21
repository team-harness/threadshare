# Threadshare

[English](./README.md) | [简体中文](./README.zh-CN.md)

Threadshare makes AI-agent history useful: share Codex, Claude Code, and Paseo sessions as read-only
web links, or let your Agent query a local index for Tool failures, workflow patterns, prior solutions,
and evidence-backed development insights.

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

### Query Local Insights with an Agent

Local Insights lets your Agent investigate patterns across your recorded Codex and Claude work. Ask a
concrete question in natural language. The Agent chooses the queries, checks coverage, and reads only
the evidence needed for its answer.

```bash
threadshare insights sync
```

Run `sync` once before the first analysis and whenever you want fresher results. Later runs are
incremental. Use `reindex` only for an explicit complete rebuild or origin-secret recovery.
For delivery questions about a repository, register that repository once with
`threadshare insights sync --repository .`. Delivery Trace works from Git and Agent evidence without
any requirements system. If you explicitly want to connect a repository-owned Markdown checklist or
plan, add `--intent <repository-relative-file>`; Threadshare never discovers one automatically. Remove
that optional source with `threadshare insights sync --repository . --clear-intent`. Later plain `sync`
runs update the remaining registered sources.
From that checkout, the Agent can omit the opaque repository key; Delivery Trace resolves the
registered repository containing its current working directory.

Then ask your Agent questions like these:

| Ask your Agent | What the answer can guide |
|---|---|
| Which Skills and Tools do I use most, and in what kinds of work? | Standardize useful workflows, consolidate aliases, and remove low-value integrations. |
| Which Tool attempts keep failing, and did the same attempt chain later succeed? | Separate high-volume friction from broken integrations, then improve Tool setup, prompts, or documentation. |
| Which Sessions were research-heavy, implementation-heavy, or missing supporting documentation? | Add design or review checkpoints where implementation is outrunning recorded evidence. |
| When did Tool density, Skill use, or project switching change? | Compare workflow changes over time and identify coordination or automation overhead. |
| Where did this exact error happen before, and what evidence-backed step succeeded later? | Reuse a previously successful procedure without treating historical correlation as a guarantee. |

#### Trace delivery with an Agent

After repository sync, ordinary successful `git commit` output can connect an Agent Session to a
reachable commit.

Full hashes form direct evidence. A short hash forms observed evidence only when it resolves uniquely
inside the registered repository. No special commit wrapper is required.

| Ask your Agent | What Insights Trace connects | What the answer can guide |
|---|---|---|
| Which Agent Sessions are related to this commit, and what does the evidence actually prove? | Session, observed Git result, commit identity, reachability, and the GitHub or GitLab link. | Review the originating context without claiming authorship or exclusive line attribution. |
| How did this requirement move from plan to delivery? | Intent or checklist item, Sessions, changed files, commits, and on-demand Git diff evidence. | Confirm that implemented work matches the recorded requirement and find missing delivery steps. |
| Which attempts and file changes preceded the commit that fixed this bug? | Relevant Turns, Tool uses, files, successful commit evidence, and unresolved gaps. | Reuse the successful path and distinguish it from failed or merely correlated attempts. |
| Why did this commit change these files? | Commit diff, related Session context, implementation decisions, and review evidence. | Check whether the diff follows the stated design and whether review covered the risky paths. |
| What remains before another Agent continues or the release ships? | Completed and unresolved intents, Sessions with no commit, commits with no recorded Agent context, and affected files. | Build a bounded handoff and surface delivery gaps before release. |

Each edge is evidence, not a claim of authorship or causation.

The Agent should report its relation, strength, source, facts, and limitations. Candidate and
contextual edges are investigation leads; they must not be presented as confirmed delivery.

The user does not choose commands, resource names, schemas, or internal analysis plans. A compatible
Agent reads `threadshare insights spec --format json`, selects bounded queries, and reports the
snapshot, time window, coverage, truncation, and evidence behind its conclusion.

#### Real report from a local index

The following findings came from one real local index containing more than 3,600 Sessions and 11,000
Turns. No Session text, paths, stable keys, or evidence identifiers are included here.

| Question | What the Agent found | Development decision |
|---|---|---|
| Which Skills are used most? | Review and design-convergence Skills dominated recorded use; the top two represented 48.9% of Skill invocations. | Productize the review and design workflows before adding more low-frequency entry points. |
| Which Tools keep failing? | `Bash` had the most failures by volume but completed 13,345 of 13,674 calls. `WebFetch` failed 9/9 and a retired MCP search failed 4/4. | Classify recurring `Bash` failures, but remove or replace integrations that never record a successful call. |
| Did failed attempts recover? | All 50 returned representative failure chains were `never-succeeded`; 34 were `Bash` chains. | Track recovery per attempt chain instead of assuming that a generally reliable Tool recovered a specific failure. |
| How did the workflow change? | Recorded Turns fell 50.3% between two 13-week windows while Tool calls per Turn rose 36.4%. | Investigate whether work became more deeply automated or accumulated extra orchestration overhead. |
| Where are token hotspots? | The largest group recorded about 2.84B tokens, with roughly 98% of input tokens served from cache. | Compare uncached input, output, and delivered results before treating total tokens as avoidable cost. |

Read the [complete real-index Agent report](https://github.com/team-harness/threadshare/blob/main/docs/insights-analysis-example.md)
for the questions, evidence limits, conclusions, and follow-up decisions behind these findings.
The [Delivery Trace reference](https://github.com/team-harness/threadshare/blob/main/docs/insights-delivery-trace-example.md)
shows how an Agent follows a requirement through Sessions, files, commits, and on-demand Git diff evidence.

Local Insights queries committed local history without uploading it. Deep Query can return complete
messages, analysis, Tool input/output, errors, and file paths. Treat its output as sensitive local
data, and do not share or publish it unless the user explicitly asks.

Local Insights is packaged for macOS and Linux on arm64 and x64. Windows installations retain the
core Threadshare CLI (`share`, `read`, `export`, and related commands), but local Insights is not
available in the 0.8.x release line while the owner-only Windows ACL adapter remains unimplemented.

Usage counts are recorded invocations, not inferred independent uses. Agents should distinguish Tool
terminal states from the outcome of the containing Turn. Co-occurrence does not prove that a Tool or
Skill caused a Turn to succeed or fail.

### Build Shared Team Memory

Team Memory retrospectively selects local Insights Turns and turns them into reviewed,
repository-owned memory. It never defaults to the whole Insights database: every new preview requires
a request with an explicit UTC time window (at most 366 days) and may add text, provider, opaque
session, Tool, Skill, result-evidence, and capability-state filters. Threadshare always adds the bound
worktree project scope plus `hard-sealed`; callers cannot override either boundary.

```json
{
  "format": "threadshare-memory-extraction-request@v1",
  "window": {
    "after": "2026-08-01T00:00:00.000Z",
    "before": "2026-08-22T00:00:00.000Z"
  },
  "query": "release verification",
  "filters": {
    "providers": ["claude", "codex"],
    "resultEvidence": ["provider-completed"]
  }
}
```

```bash
threadshare memory init
threadshare memory extract --runner claude --request memory-filter.json
# After approving the exact extraction plan shown above:
threadshare memory extract --runner claude --approve-plan <extraction-digest>
# Adjudication is a separate delivery with a separate approval:
threadshare memory extract --runner claude --approve-plan <adjudication-digest>
threadshare memory review
threadshare memory promote --plan <plan-id>
threadshare memory assemble --provider claude
```

Codex is also a restricted Phase 1 runner. A new Codex preview binds the exact model and HTTPS
endpoint; later approval reuses that private stored profile and cannot override it:

```bash
threadshare memory extract --runner codex \
  --runner-model <model> \
  --runner-endpoint <https-url> \
  --request memory-filter.json
threadshare memory extract --runner codex --approve-plan <extraction-digest>
threadshare memory extract --runner codex --approve-plan <adjudication-digest>
```

Agents may create the same pending-only preview with `threadshare_memory_extract_preview` over the
local Insights MCP server. That tool can write the private pending artifact, but it cannot approve a
digest, start either runner stage, or return transcript bytes. `threadshare_memory_search` and
`threadshare_memory_status` remain read-only.

Each runner stage is deny-all except for its model connection and receives transcript bytes only after
the user approves that stage's exact digest and byte summary. `review` requires a real TTY and confirms
every generated statement; non-interactive callers can inspect pending work but cannot approve it.
The selector rejects requests matching more than 200 Turns instead of silently taking a prefix. It
reads complete selected Turns, injects bounded Delivery Trace evidence, and revalidates the exact
source binding before candidate submission; unrelated snapshot advances do not invalidate a plan.
`promote` writes only sanitized content below `.threadshare/memory/`, refreshes the approved search
projection, and never stages, commits, or pushes. After a teammate pulls approved memory from Git, run
`assemble` to refresh both the provider context block and local search projection.

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
