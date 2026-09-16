import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  documentModel,
  validateAnchor,
  ANCHOR_VERSION,
} from "../src/document-model.mjs";

test("composer keeps its displayed passage when selection changes before submit", async () => {
  const elements = new Map();
  const listeners = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: true,
        value: "",
        dataset: {},
        style: {},
        getBoundingClientRect: () => ({ width: 180, height: 40 }),
        classList: { remove() {}, add() {} },
        setAttribute() {},
        focus() {},
        contains: () => true,
        querySelectorAll: () => [],
        textContent: "",
      });
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
    AbortSignal,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
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
  let source = await readFile(
    new URL("../document-viewer/app.js", import.meta.url),
    "utf8",
  );
  source = source.replace(/import[\s\S]*?from "[^"]+";\n/g, "");
  source = source.slice(0, source.lastIndexOf("\nstart().catch"));
  vm.runInContext(source, context);
  vm.runInContext(
    'model = documentModel("First passage.\\n\\nSecond passage."); shared = {revision:"revision"}; highlight=()=>{}; renderComments=()=>{}; openComposer(anchorFor(0, 5));',
    context,
  );
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
});
