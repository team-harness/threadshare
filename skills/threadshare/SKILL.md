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
- List start candidates for an agent-driven partial share: `threadshare messages <codex|claude|paseo> <session-or-agent> --format json`
- Export without uploading: `threadshare export <codex|claude|paseo> <session-or-agent> --output <file>`
- Publish an existing protocol file: `threadshare publish <file|-> --json`
- Validate an existing protocol file: `threadshare validate <file|->`

Use an installed `threadshare` binary when available. Otherwise run the same arguments with:

```bash
npx --yes @team-harness/threadshare@latest <command> ...
```

Override the shared service only when requested, using `--url <service-url>` or `THREADSHARE_URL`.

## Choose A Start Turn

When the user asks for the full conversation, use the regular `share` command without `--from` or `--before`. Omitting both options is the deliberate full-conversation mode. An empty range value is invalid; if selection fails, stop instead of retrying without the range options. When the user wants to start from a particular message but has not supplied an exact message ID, use this non-interactive workflow:

1. Run `threadshare messages <provider> <session> --format json`. It returns at most 10 candidates before the latest user turn, newest first, plus `boundaryId`, `boundaryPreview`, `hasMore`, and `nextOffset`.
2. Confirm that `boundaryPreview` corresponds to the user's current sharing request. If it does not, retry after the request has persisted once; if it still does not match, stop and explain that a safe boundary is unavailable.
3. Show the user numbered candidate previews without IDs. Keep the preview-to-ID mapping and the original `boundaryId` internal.
4. If the user asks for more, run `threadshare messages <provider> <session> --format json --before <original-boundary-id> --offset <next-offset>`. Append the next page's numbering and continue to retain the original boundary.
5. After the user selects a number, run `threadshare share <provider> <session> --from <selected-message-id> --before <original-boundary-id> --json`.

Do not infer a start from fuzzy text when more than one preview could match. Agents must not use interactive `--pick-start` or `--from last-user`: later selection messages can change what "last" means. `--pick-start` is for a person running the CLI in a terminal; it displays 10 turns at a time and includes the snapshot's latest real user turn.

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
5. For a ranged share, verify that the first exported native turn matches the selected candidate and that the boundary entry is absent.
6. Return the Viewer URL. Include the exported entry count when useful.

The exporter skips hidden, metadata, sidechain, and known agent-injected orchestration records; omits raw system prompts and provider configuration; and redacts common credential fields and token patterns on a best-effort basis. Visible messages and tool input/output can still contain sensitive data that it does not recognize; do not share a session when the task indicates those contents must remain private.

Do not print the exported transcript during routine verification. Do not expose the local JSONL path unless it helps the user disambiguate sessions.
