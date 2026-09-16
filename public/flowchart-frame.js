const sourceOrigin = new URL(document.currentScript.src).origin;
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== sourceOrigin || !event.data || event.data.type !== "threadshare-flowchart") return;
  const svg = event.data.svg;
  if (typeof svg !== "string" || svg.length > 2_000_000) return;
  const template = document.createElement("template");
  template.innerHTML = svg;
  const diagram = template.content.querySelector("svg");
  if (!diagram) return;
  document.body.textContent = "";
  document.body.appendChild(diagram);
  parent.postMessage({ type: "threadshare-flowchart-ready" }, sourceOrigin);
});
