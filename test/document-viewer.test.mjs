import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { isSafeFlowchartSource } from "../document-viewer/flowchart-source.mjs";
import {
  documentModel,
  validateAnchor,
  ANCHOR_VERSION,
} from "../src/document-model.mjs";

async function viewerScript() {
  let source = await readFile(
    new URL("../document-viewer/app.js", import.meta.url),
    "utf8",
  );
  source = source.replace(/import[\s\S]*?from "[^"]+";\n/g, "");
  return source.slice(0, source.lastIndexOf("\nstart().catch"));
}

test("flowcharts reject instructions and remote media before invoking Mermaid", () => {
  assert.equal(isSafeFlowchartSource("flowchart LR\n  A[Build] --> B[Release]"), true);
  for (const source of [
    'flowchart LR\n A --> B\n %%{init: {"htmlLabels":true}}%%',
    'flowchart LR\n A@{ img: "https://example.test/pixel" }',
    'flowchart LR\n A[<img src="https://example.test/pixel">]',
    'flowchart LR\n click A "https://example.test"',
    'flowchart LR\n classDef danger fill:url(https://example.test/pixel)',
    'flowchart LR\n A --> B; click A "//tracker.example/pixel"',
    'flowchart LR\n A --> B; style A fill:#f00',
    'flowchart LR\n A --> B; classDef danger fill:#f00',
    'flowchart LR\n A[//tracker.example/pixel] --> B',
    'flowchart LR\n A[plain] --> B[data:image/png;base64,abc]',
  ]) assert.equal(isSafeFlowchartSource(source), false, source);
});

test("flowchart frame acknowledges only a same-origin parent after displaying an SVG", async () => {
  const source = await readFile(new URL("../public/flowchart-frame.js", import.meta.url), "utf8");
  let onMessage;
  const displayed = [];
  const acknowledgements = [];
  const parent = { postMessage: (...args) => acknowledgements.push(args) };
  const svg = { nodeName: "svg" };
  const context = {
    URL,
    parent,
    window: { addEventListener: (_type, callback) => { onMessage = callback; } },
    document: {
      currentScript: { src: "https://test.local/flowchart-frame.js" },
      createElement: () => ({ content: { querySelector: () => svg }, innerHTML: "" }),
      body: { appendChild: (node) => displayed.push(node), textContent: "previous" },
    },
  };
  vm.runInNewContext(source, context);
  onMessage({ source: parent, origin: "https://other.test", data: { type: "threadshare-flowchart", svg: "<svg/>" } });
  assert.equal(displayed.length, 0);
  onMessage({ source: parent, origin: "https://test.local", data: { type: "threadshare-flowchart", svg: "<svg/>" } });
  assert.deepEqual(displayed, [svg]);
  assert.equal(context.document.body.textContent, "");
  assert.equal(acknowledgements[0][0].type, "threadshare-flowchart-ready");
  assert.equal(acknowledgements[0][1], "https://test.local");
});

test("composer keeps its displayed passage when selection changes before submit", async () => {
  const elements = new Map();
  const listeners = new Map();
  const frames = [];
  let scrollY = 420;
  const element = (id) => {
    if (!elements.has(id)) {
      const node = {
        hidden: true,
        value: "",
        dataset: {},
        style: {},
        getBoundingClientRect: () => ({ width: 180, height: 40 }),
        classList: { remove() {}, add() {} },
        setAttribute() {},
        addEventListener() {},
        focus(options) {
          if (id === "comment-body" && !options?.preventScroll) scrollY = 0;
        },
        blur() {},
        contains: () => true,
        querySelectorAll: () => [],
        textContent: "",
      };
      if (id === "composer") {
        let hidden = true;
        Object.defineProperty(node, "hidden", {
          get: () => hidden,
          set(value) {
            hidden = value;
            if (value) scrollY = 0; // Simulate browser scroll anchoring on form removal.
          },
        });
      }
      elements.set(id, node);
    }
    return elements.get(id);
  };
  let range;
  let posted;
  const context = vm.createContext({
    documentModel,
    validateAnchor,
    ANCHOR_VERSION,
    document: {
      getElementById: element,
      addEventListener: (name, fn) => listeners.set(name, fn),
    },
    location: { href: "https://test.local/document.html?id=x", hash: "" },
    URL,
    innerWidth: 800,
    innerHeight: 600,
    structuredClone,
    crypto: { getRandomValues: crypto.getRandomValues.bind(crypto) },
    AbortSignal: {}, // DingTalk WebView has no AbortSignal.timeout.
    AbortController,
    setTimeout,
    clearTimeout,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    requestAnimationFrame: (callback) => frames.push(callback),
    get scrollY() { return scrollY; },
    scrollTo: (_x, top) => { scrollY = top; },
    localStorage: { getItem() {}, setItem() {} },
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    }),
    readDocumentJson: async () => ({ commentId: "saved" }),
    fetch: async (_url, options) => {
      assert.match(
        _url,
        /\/comments\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      posted = JSON.parse(options.body);
      return {};
    },
  });
  vm.runInContext(await viewerScript(), context);
  vm.runInContext(
    'model = documentModel("First passage.\\n\\nSecond passage."); shared = {revision:"revision"}; highlight=()=>{}; renderComments=()=>{}; openComposer(anchorFor(0, 5));',
    context,
  );
  assert.equal(scrollY, 420, "opening the composer must keep the selected passage in view");
  const displayed = element("selected-text").textContent;
  const node = {
    nodeType: 3,
    parentElement: { matches: () => true, dataset: { start: "15" } },
  };
  range = {
    startContainer: node,
    endContainer: node,
    startOffset: 0,
    endOffset: 6,
    getClientRects: () => [
      { left: 100, right: 600, top: 80, bottom: 100, width: 500, height: 20 },
      { left: 100, right: 220, top: 100, bottom: 120, width: 120, height: 20 },
    ],
  };
  listeners.get("selectionchange")();
  assert.equal(element("selection-action").style.left, "220px");
  assert.equal(element("selection-action").style.top, "128px");
  range.getClientRects = () => [
    { left: 650, right: 790, top: 560, bottom: 580, width: 140, height: 20 },
  ];
  vm.runInContext("positionSelectionAction()", context);
  assert.equal(element("selection-action").style.left, "612px");
  assert.equal(element("selection-action").style.top, "512px");
  range.getClientRects = () => [
    { left: 100, right: 220, top: -100, bottom: -80, width: 120, height: 20 },
  ];
  vm.runInContext("positionSelectionAction()", context);
  assert.equal(element("selection-action").hidden, true);
  element("author").value = "Reviewer";
  element("comment-body").value = "Keep this wording";
  await element("composer").onsubmit({ preventDefault() {} });
  assert.equal(displayed, "First");
  assert.equal(posted.anchor.exact, displayed);
  assert.equal(posted.anchor.start, 0);
  for (const frame of frames) frame();
  assert.equal(scrollY, 420);
});

test("document requests work without AbortSignal.timeout and retain an abort deadline", async () => {
  const elements = new Map();
  const timers = new Map();
  let timerId = 0;
  let requests = 0;
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id))
          elements.set(id, { classList: { add() {} }, setAttribute() {}, addEventListener() {} });
        return elements.get(id);
      },
      addEventListener() {},
    },
    location: { href: "https://test.local/document.html?id=x" },
    URL,
    AbortSignal: {},
    AbortController,
    setTimeout(fn, delay) {
      assert.equal(delay, 30000);
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    localStorage: { getItem() {} },
    readDocumentJson: async () => ({ ok: true }),
    fetch: async (_url, init) => {
      assert.equal(init.signal.aborted, false);
      assert.equal(typeof init.signal.addEventListener, "function");
      if (++requests === 2)
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      return {};
    },
  });
  vm.runInContext(await viewerScript(), context);
  assert.deepEqual(await vm.runInContext("api('')", context), { ok: true });
  assert.equal(timers.size, 0);
  const timedRequest = vm.runInContext("api('')", context);
  timers.get(timerId)();
  await assert.rejects(timedRequest, /aborted/);
  assert.equal(timers.size, 0);
});

test("document images open an accessible preview and close without navigation", async () => {
  const markup = await readFile(
    new URL("../document.html", import.meta.url),
    "utf8",
  );
  assert.match(markup, /id="image-preview"/);
  assert.match(markup, /id="image-preview-image"[^>]*referrerpolicy="no-referrer"/);
  const elements = new Map();
  let focused;
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: true,
        style: {},
        classList: { add() {} },
        setAttribute() {},
        addEventListener() {},
        removeAttribute() {},
        focus() { focused = id; },
      });
    return elements.get(id);
  };
  const listeners = new Map();
  const image = {
    src: "https://test.local/image.png",
    currentSrc: "https://test.local/image.png",
    alt: "Diagram",
    addEventListener(name, fn) { listeners.set(name, fn); },
    focus() { focused = "image"; },
    setAttribute(name, value) { this[name] = value; },
  };
  const context = vm.createContext({
    document: {
      body: { style: { overflow: "" } },
      getElementById: element,
      addEventListener() {},
    },
    location: { href: "https://test.local/document.html?id=x" },
    URL,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    localStorage: { getItem() {} },
    image,
  });
  vm.runInContext(await viewerScript(), context);
  vm.runInContext("enableImagePreview(image)", context);
  assert.equal(image.tabIndex, 0);
  assert.equal(image.role, "button");
  let prevented = false;
  listeners.get("click")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(element("image-preview").hidden, false);
  assert.equal(element("image-preview-image").src, image.src);
  assert.equal(element("image-preview-image").alt, image.alt);
  assert.equal(focused, "image-preview-close");
  element("image-preview-close").onclick();
  assert.equal(element("image-preview").hidden, true);
  assert.equal(focused, "image");
});
