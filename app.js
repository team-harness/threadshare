import markdownit from "markdown-it";
import { agentAlternatePath, canonicalViewerPath } from "./src/agent-transcript.mjs";
import { createTurnDirectory } from "./src/viewer-state.mjs";

const conversation = document.querySelector("#conversation");
const MESSAGE_ANCHOR_PREFIX = "message-";
const QUICK_START_URL = "https://github.com/team-harness/threadshare#quick-start";
const SHARE_COMMANDS = [
  "threadshare share codex <session-id-or-jsonl-file>",
  "threadshare share claude <session-id-or-jsonl-file>",
  "threadshare share paseo <agent-id-or-prefix>",
];

function messageAnchorId(entry) {
  return `${MESSAGE_ANCHOR_PREFIX}${entry.id}`;
}

function currentMessageAnchorId() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  try {
    const anchorId = decodeURIComponent(hash);
    return anchorId.startsWith(MESSAGE_ANCHOR_PREFIX) ? anchorId : null;
  } catch {
    return null;
  }
}

function focusMessageAnchor(anchorId, { moveFocus = true } = {}) {
  const target = document.getElementById(anchorId);
  if (!target) return false;

  document.querySelector(".entry.is-anchor-target")?.classList.remove("is-anchor-target");
  target.classList.remove("is-anchor-target");
  void target.offsetWidth;
  target.classList.add("is-anchor-target");
  if (moveFocus) target.focus({ preventScroll: true });
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  return true;
}

function focusCurrentMessageAnchor() {
  const anchorId = currentMessageAnchorId();
  if (!anchorId) return;
  focusMessageAnchor(anchorId);
}

async function copyMessageAnchor(anchorId, button) {
  const url = new URL(window.location.href);
  url.hash = encodeURIComponent(anchorId);
  window.history.replaceState(null, "", url);
  focusMessageAnchor(anchorId, { moveFocus: false });

  try {
    await navigator.clipboard.writeText(url.toString());
    button.classList.add("copied");
    button.setAttribute("aria-label", "Link copied");
    window.setTimeout(() => {
      button.classList.remove("copied");
      button.setAttribute("aria-label", "Copy link to this message");
    }, 1600);
  } catch {
    button.setAttribute("aria-label", "Link ready in the address bar");
  }
}

async function copyAssistantMarkdown(markdown, button) {
  try {
    await navigator.clipboard.writeText(markdown);
    button.classList.add("copied");
    button.setAttribute("aria-label", "Markdown copied");
    button.title = "Markdown copied";
    window.setTimeout(() => {
      button.classList.remove("copied");
      button.setAttribute("aria-label", "Copy assistant markdown");
      button.title = "Copy assistant markdown";
    }, 1600);
  } catch {
    button.setAttribute("aria-label", "Unable to copy markdown");
    button.title = "Unable to copy markdown";
  }
}

async function copyCommand(command, button) {
  try {
    await navigator.clipboard.writeText(command);
    button.classList.add("copied");
    button.setAttribute("aria-label", "Command copied");
    button.title = "Command copied";
    window.setTimeout(() => {
      button.classList.remove("copied");
      button.setAttribute("aria-label", "Copy command");
      button.title = "Copy command";
    }, 1600);
  } catch {
    button.setAttribute("aria-label", "Unable to copy command");
    button.title = "Unable to copy command";
  }
}

async function copyReviewLink(reviewUrl, link) {
  try {
    await navigator.clipboard.writeText(reviewUrl);
    link.classList.add("copied");
    link.textContent = "Review link copied";
    window.setTimeout(() => {
      link.classList.remove("copied");
      link.textContent = "Copy review link";
    }, 1600);
  } catch {
    link.textContent = "Copy failed";
  }
}

function copyIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("copy-icon");
  for (const d of [
    "M8 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2",
    "M9 4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z",
  ]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function quickStartLink(text, className) {
  const link = element("a", className, text);
  link.href = QUICK_START_URL;
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
}

function renderCommand(command) {
  const row = element("div", "command-row");
  const code = element("code", "", command);
  const button = element("button", "copy-button command-copy-button");
  button.type = "button";
  button.setAttribute("aria-label", "Copy command");
  button.title = "Copy command";
  button.append(copyIcon());
  button.addEventListener("click", () => {
    void copyCommand(command, button);
  });
  row.append(code, button);
  return row;
}

function renderQuickStart() {
  document.title = "Threadshare";
  conversation.removeAttribute("aria-busy");

  const quickStart = element("section", "quick-start");
  quickStart.append(
    element("h1", "", "Share an agent conversation"),
    element("p", "quick-start-intro", "Create a read-only link from a local agent session."),
  );

  const installStep = element("section", "quick-start-step");
  installStep.append(
    element("h2", "", "1. Install the CLI"),
    renderCommand("npm install --global @team-harness/threadshare"),
  );

  const shareStep = element("section", "quick-start-step");
  shareStep.append(element("h2", "", "2. Share a session"));
  for (const command of SHARE_COMMANDS) shareStep.append(renderCommand(command));

  quickStart.append(
    installStep,
    shareStep,
    quickStartLink("View full documentation on GitHub", "quick-start-link"),
  );
  conversation.replaceChildren(quickStart);
}

function renderSharePrompt() {
  const prompt = element("aside", "share-prompt");
  const copy = element("div", "share-prompt-copy");
  copy.append(
    element("strong", "", "Want to share your own agent conversation?"),
    element("p", "", "Turn a local Codex, Claude Code, or Paseo session into a read-only link."),
  );
  prompt.append(copy, quickStartLink("How to share", "share-prompt-link"));
  return prompt;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function isHistory(value) {
  return (
    value &&
    typeof value === "object" &&
    value.schemaVersion === 1 &&
    value.conversation &&
    typeof value.conversation.title === "string" &&
    Array.isArray(value.entries)
  );
}

function isHistoryId(value) {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function shareApiUrl(id) {
  return `/api/v1/shares/${encodeURIComponent(id)}`;
}

function updateAgentAlternate(id) {
  const alternate = document.querySelector("#agent-transcript-alternate");
  if (alternate) alternate.href = agentAlternatePath(id.toLowerCase());
}

function renderLoadingState() {
  const state = element("div", "loading-state");
  state.setAttribute("role", "status");
  state.append(
    element("span", "loading-spinner"),
    element("span", "", "Loading shared conversation..."),
  );
  conversation.setAttribute("aria-busy", "true");
  conversation.replaceChildren(state);
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function isShareableLink(href) {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function renderUnshareableLinksAsLabels(state) {
  for (const token of state.tokens) {
    if (!token.children) continue;
    for (let index = 0; index < token.children.length; index += 1) {
      const open = token.children[index];
      if (open.type !== "link_open" || isShareableLink(open.attrGet("href") ?? "")) continue;

      open.type = "text";
      open.tag = "";
      open.nesting = 0;
      open.attrs = null;
      open.content = "";
      let depth = 1;
      for (let closeIndex = index + 1; closeIndex < token.children.length; closeIndex += 1) {
        const candidate = token.children[closeIndex];
        if (candidate.type === "link_open") depth += 1;
        if (candidate.type !== "link_close") continue;
        depth -= 1;
        if (depth !== 0) continue;
        candidate.type = "text";
        candidate.tag = "";
        candidate.nesting = 0;
        candidate.content = "";
        break;
      }
    }
  }
}

function createMarkdownRenderer() {
  const renderer = markdownit({ html: false, linkify: true });
  renderer.core.ruler.after("inline", "threadshare-link-labels", renderUnshareableLinksAsLabels);
  const defaultLinkOpen =
    renderer.renderer.rules.link_open ??
    ((tokens, index, options, environment, self) =>
      self.renderToken(tokens, index, options, environment));
  renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noopener noreferrer");
    return defaultLinkOpen(tokens, index, options, environment, self);
  };
  return renderer;
}

const markdownRenderer = createMarkdownRenderer();

function renderMarkdown(text) {
  const root = element("div", "markdown");
  // markdown-it escapes raw HTML and rejects unsafe URL protocols.
  root.innerHTML = markdownRenderer.render(text);
  return root;
}

function recordLabel(entry) {
  switch (entry.kind) {
    case "tool":
      return entry.name;
    case "thought":
      return "Thinking";
    case "todo":
      return "Tasks";
    case "compaction":
      return "Context compacted";
    default:
      return "Activity";
  }
}

function renderRecord(entry) {
  const record = element(
    "section",
    `entry record ${entry.kind}-record${
      entry.status === "failed" || entry.level === "error" ? " error" : ""
    }`,
  );
  const heading = element("div", "record-heading");
  heading.append(element("strong", "", recordLabel(entry)));
  const status = entry.status || entry.level;
  if (status) heading.append(element("span", "status", status));
  if (entry.kind === "tool" || entry.kind === "thought") {
    const toggle = element(
      "button",
      entry.kind === "tool" ? "record-toggle tool-toggle" : "record-toggle thought-toggle",
    );
    toggle.type = "button";
    toggle.append(heading, element("span", "record-caret"));

    let detail;
    if (entry.kind === "tool") {
      const data = {};
      if (entry.input !== undefined) data.input = entry.input;
      if (entry.output !== undefined) data.output = entry.output;
      if (entry.error !== undefined) data.error = entry.error;
      detail = element("pre", "", JSON.stringify(data, null, 2));
    } else {
      detail = element("p", "thought-detail", entry.text);
    }
    detail.hidden = true;

    const setExpanded = (expanded) => {
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute(
        "aria-label",
        `${expanded ? "Hide" : "Show"} details for ${recordLabel(entry)}`,
      );
      detail.hidden = !expanded;
      record.classList.toggle("is-expanded", expanded);
    };
    setExpanded(false);
    toggle.addEventListener("click", () => {
      setExpanded(toggle.getAttribute("aria-expanded") !== "true");
    });
    record.append(toggle, detail);
  } else {
    record.append(heading);
  }
  if (entry.kind === "activity") record.append(element("p", "", entry.message));
  if (entry.kind === "todo") {
    const list = element("ul", "todo-list");
    for (const item of entry.items)
      list.append(element("li", item.completed ? "done" : "", item.text));
    record.append(list);
  }
  return record;
}

function toolGroupStatus(entries) {
  const failedCount = entries.filter((entry) => entry.status === "failed").length;
  if (failedCount) return `${failedCount} failed`;
  if (entries.some((entry) => entry.status === "running")) return "Running";
  if (entries.some((entry) => entry.status === "canceled")) return "Canceled";
  return "Completed";
}

function renderToolGroup(entries) {
  const hasFailedTool = entries.some((entry) => entry.status === "failed");
  const group = element("section", `entry record tool-group${hasFailedTool ? " error" : ""}`);
  const toggle = element("button", "record-toggle tool-group-toggle");
  toggle.type = "button";
  const heading = element("div", "record-heading");
  heading.append(
    element("strong", "tool-group-label", `${entries.length} tool calls`),
    element("span", "status", toolGroupStatus(entries)),
  );
  toggle.append(heading, element("span", "record-caret"));

  const list = element("div", "tool-group-list");
  list.hidden = true;
  for (const entry of entries) list.append(renderRecord(entry));

  const setExpanded = (expanded) => {
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${entries.length} tool calls`);
    list.hidden = !expanded;
    group.classList.toggle("is-expanded", expanded);
  };
  setExpanded(false);
  toggle.addEventListener("click", () => {
    setExpanded(toggle.getAttribute("aria-expanded") !== "true");
  });
  group.append(toggle, list);
  return group;
}

function renderAgentReviewHint(id) {
  const reviewUrl = new URL(canonicalViewerPath(id.toLowerCase()), window.location.origin).toString();
  const hint = element("aside", "agent-review-hint");
  hint.setAttribute("aria-label", "Conversation review link");
  hint.append(element("span", "agent-review-label", "AI agent review:"));
  const reviewLink = element("a", "agent-review-link", "Copy review link");
  reviewLink.href = reviewUrl;
  reviewLink.title = "Copy the canonical Viewer review link";
  reviewLink.setAttribute("data-review-url", reviewUrl);
  reviewLink.addEventListener("click", (event) => {
    event.preventDefault();
    void copyReviewLink(reviewUrl, reviewLink);
  });
  hint.append(reviewLink);
  return hint;
}

function renderMessage(entry) {
  const article = element("article", `entry message ${entry.role}`);
  if (entry.role === "user") {
    article.id = messageAnchorId(entry);
    article.tabIndex = -1;
  }
  const bubble = element("div", "bubble");
  const entryMeta = element(
    "div",
    "entry-meta",
    `${entry.role === "user" ? "You" : "Assistant"} · ${formatTime(entry.createdAt)}`,
  );
  if (entry.role === "user") {
    const anchorButton = element("button", "anchor-button");
    anchorButton.type = "button";
    anchorButton.setAttribute("aria-label", "Copy link to this message");
    anchorButton.addEventListener("click", () => {
      void copyMessageAnchor(article.id, anchorButton);
    });
    entryMeta.append(anchorButton);
  } else if (entry.role === "assistant") {
    const copyButton = element("button", "copy-button");
    copyButton.type = "button";
    copyButton.setAttribute("aria-label", "Copy assistant markdown");
    copyButton.title = "Copy assistant markdown";
    copyButton.append(copyIcon());
    copyButton.addEventListener("click", () => {
      void copyAssistantMarkdown(entry.markdown, copyButton);
    });
    entryMeta.append(copyButton);
  }
  bubble.append(entryMeta, renderMarkdown(entry.markdown));
  article.append(bubble);
  return article;
}

function renderTurnDirectory(turns, onNavigate) {
  const directory = element("nav", "turn-directory");
  directory.setAttribute("aria-label", "Conversation turns");

  const heading = element("div", "turn-directory-heading");
  heading.append(
    element("h2", "", "Turns"),
    element("span", "turn-count", String(turns.length)),
  );

  const toggle = element("button", "turn-directory-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "turn-directory-list");
  toggle.append(
    element("span", "", "Turns"),
    element("span", "turn-count", String(turns.length)),
    element("span", "turn-directory-caret"),
  );

  const list = element("ol", "turn-list");
  list.id = "turn-directory-list";
  for (const turn of turns) {
    const item = element("li", "turn-item");
    const link = element("a", "turn-link");
    link.href = `#${encodeURIComponent(turn.anchorId)}`;
    link.append(
      element("span", "turn-number", String(turn.number).padStart(2, "0")),
      element("span", "turn-preview", turn.preview),
    );
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const url = new URL(window.location.href);
      url.hash = encodeURIComponent(turn.anchorId);
      window.history.replaceState(null, "", url);
      directory.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      onNavigate(turn.anchorId);
    });
    item.append(link);
    list.append(item);
  }
  if (turns.length === 0) list.append(element("li", "turn-list-empty", "No user turns"));

  toggle.disabled = turns.length === 0;
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    directory.classList.toggle("is-open", expanded);
  });

  directory.append(heading, toggle, list);
  return directory;
}

function renderHistory(history, id) {
  document.title = `${history.conversation.title} - Threadshare`;
  conversation.removeAttribute("aria-busy");
  conversation.replaceChildren();
  const conversationMeta = element("header", "conversation-meta");
  conversationMeta.append(element("h1", "", history.conversation.title));
  const details = [
    history.conversation.provider,
    history.conversation.model,
    `Shared ${formatTime(history.exportedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (details) conversationMeta.append(element("p", "", details));
  conversation.append(conversationMeta);
  conversation.append(renderAgentReviewHint(id));

  const transcript = element("div", "transcript");
  for (let index = 0; index < history.entries.length; index += 1) {
    const entry = history.entries[index];
    if (entry.kind === "tool") {
      const entries = [entry];
      while (history.entries[index + 1]?.kind === "tool") {
        index += 1;
        entries.push(history.entries[index]);
      }
      transcript.append(entries.length === 1 ? renderRecord(entry) : renderToolGroup(entries));
      continue;
    }
    if (entry.kind === "message") {
      transcript.append(renderMessage(entry));
    } else {
      transcript.append(renderRecord(entry));
    }
  }
  transcript.append(renderSharePrompt());

  const directory = renderTurnDirectory(createTurnDirectory(history.entries), focusMessageAnchor);
  const layout = element("div", "viewer-layout");
  layout.append(directory, transcript);
  conversation.append(layout);

  focusCurrentMessageAnchor();
}

async function loadHistory() {
  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");
  if (!id) {
    renderQuickStart();
    return;
  }
  if (!isHistoryId(id)) {
    conversation.replaceChildren(element("div", "error-state", "This share link is invalid."));
    return;
  }
  updateAgentAlternate(id);
  renderLoadingState();
  await waitForNextPaint();
  try {
    const response = await fetch(shareApiUrl(id), { cache: "no-store" });
    if (!response.ok)
      throw new Error(`The shared history could not be loaded (${response.status})`);
    const history = await response.json();
    if (!isHistory(history)) throw new Error("This file is not a supported Threadshare history");
    renderHistory(history, id);
  } catch (error) {
    conversation.removeAttribute("aria-busy");
    conversation.replaceChildren(
      element(
        "div",
        "error-state",
        error instanceof Error ? error.message : "Unable to load the shared history",
      ),
    );
  }
}

window.addEventListener("hashchange", focusCurrentMessageAnchor);

void loadHistory();
