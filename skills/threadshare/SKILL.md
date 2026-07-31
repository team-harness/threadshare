---
name: threadshare
description: Share Codex, Codex Cloud, Claude Code, or Codex/Claude-backed Paseo conversation sessions through the Threadshare CLI and return a verified read-only viewer URL. Use when a user asks to share, publish, export, or validate an agent conversation, requests a link to the current session, or needs agent-readable thread JSON.
---

# Threadshare

Use the `threadshare` CLI to export visible conversation content and publish it as a read-only link. The CLI defaults to `https://cloud-thread.team-harness.com`.

## Choose The Command

- Share a Codex or Codex Cloud session: `threadshare share codex <session-id-or-jsonl-file> --json`
- Share a Claude Code session: `threadshare share claude <session-id-or-jsonl-file> --json`
- Share a Codex- or Claude-backed Paseo agent: `threadshare share paseo <agent-id-or-prefix> --json`
- Export without uploading: `threadshare export <codex|claude|paseo> <session-or-agent> --output <file>`
- Publish an existing protocol file: `threadshare publish <file|-> --json`
- Validate an existing protocol file: `threadshare validate <file|->`

Use an installed `threadshare` binary when available. Otherwise run the same arguments with:

```bash
npx --yes @team-harness/threadshare@latest <command> ...
```

Override the shared service only when requested, using `--url <service-url>` or `THREADSHARE_URL`.

## Resolve A Session

Prefer an exact session ID or explicit JSONL path from the task context.

- Codex local and Codex Cloud sessions are searched below `$CODEX_HOME/sessions` when `CODEX_HOME` is set, otherwise `~/.codex/sessions`.
- Claude Code sessions are searched below `~/.claude/projects`.
- Paseo agents use a full agent UUID or a unique UUID prefix. The local Paseo CLI and daemon must be available; Threadshare resolves the native Codex or Claude session without printing its handle or the Paseo state path.
- A partial session ID is acceptable only when it identifies exactly one file.
- If several sessions may be active, inspect file paths, modification times, and sizes without printing conversation content. Do not assume the newest file is the requested session.
- In Codex Cloud, publish before the ephemeral environment is torn down.

## Share And Verify

1. Confirm that the user asked to share the conversation. A Viewer URL is unlisted, but anyone with the URL can read it.
2. Run `share` with `--json` and capture the one-line `{ "id", "url" }` result.
3. Verify that `id` is present and that `url` uses the expected Threadshare origin.
4. Fetch `/api/v1/shares/<id>` and verify `format == "threadshare-history@v1"`. Verify `conversation.source` matches the selected input (`paseo` for a bridged Paseo agent, otherwise the native provider).
5. Return the Viewer URL. Include the exported entry count when useful.

The exporter skips hidden, metadata, and sidechain records; omits raw system prompts and provider configuration; and redacts common credential fields and token patterns on a best-effort basis. Visible messages and tool input/output can still contain sensitive data that it does not recognize; do not share a session when the task indicates those contents must remain private.

Do not print the exported transcript during routine verification. Do not expose the local JSONL path unless it helps the user disambiguate sessions.
