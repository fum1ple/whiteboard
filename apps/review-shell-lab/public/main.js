const reviewId = new URL(location.href).searchParams.get("review");
const runId = new URL(location.href).searchParams.get("run");
const app = document.querySelector("#app");
const status = document.querySelector("#status");
const cliButton = document.querySelector("#cli-run");
const cliDialog = document.querySelector("#cli-dialog");
const cliOutput = document.querySelector("#cli-output");
const rendered = new Set();
let snapshot;

const api = (suffix, options) =>
  fetch(`/reviews-api/${encodeURIComponent(reviewId)}${suffix}`, options).then(async (response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    return response;
  });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mark(name, condition) {
  if (condition) rendered.add(name);
}

function parseSourceReference(value) {
  const match = /review-source:(head|base)\/([^#)\s]+)#L(\d+)(?:-L(\d+))?/.exec(value);
  if (!match) return null;
  return { side: match[1], file: decodeURIComponent(match[2]), start: Number(match[3]), end: Number(match[4] ?? match[3]) };
}

function sourceReference(source) {
  if (!source?.file || !source.start?.side || !Number.isInteger(source.start.line)) return null;
  return {
    side: source.start.side,
    file: source.file,
    start: source.start.line,
    end: source.end?.line ?? source.start.line,
  };
}

function markdownInto(container, markdown) {
  const lines = String(markdown ?? "").split("\n");
  let paragraph = [];
  let codeLines = null;
  const flush = () => {
    if (!paragraph.length) return;
    const p = element("p");
    appendInline(p, paragraph.join(" "));
    container.append(p);
    paragraph = [];
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flush();
      if (codeLines) {
        const pre = element("pre");
        pre.textContent = codeLines.join("\n");
        container.append(pre);
        codeLines = null;
      } else codeLines = [];
      continue;
    }
    if (codeLines) { codeLines.push(line); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      container.append(element(`h${heading[1].length}`, "", heading[2]));
    } else if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  flush();
}

function appendInline(container, text) {
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(document.createTextNode(text.slice(offset, match.index)));
    if (match[2]?.startsWith("review-source:")) {
      const reference = parseSourceReference(match[2]);
      const button = element("button", "source-link", match[1]);
      button.type = "button";
      button.addEventListener("click", () => showCodeReference(reference, match[1]));
      container.append(button);
    } else if (match[3]) {
      const code = element("code", "", match[3]);
      container.append(code);
    } else if (match[4]) {
      const strong = element("strong", "", match[4]);
      container.append(strong);
    } else {
      container.append(document.createTextNode(match[0]));
    }
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

function renderFlow(block) {
  const wrapper = element("figure", "diagram");
  wrapper.append(element("h3", "", block.title ?? "Flow diagram"));
  const nodes = block.nodes ?? [];
  const width = Math.max(480, nodes.length * 170);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} 190`);
  const defs = document.createElementNS(svg.namespaceURI, "defs");
  const marker = document.createElementNS(svg.namespaceURI, "marker");
  marker.id = "arrow"; marker.setAttribute("markerWidth", "8"); marker.setAttribute("markerHeight", "8"); marker.setAttribute("refX", "7"); marker.setAttribute("refY", "4"); marker.setAttribute("orient", "auto");
  const arrow = document.createElementNS(svg.namespaceURI, "path"); arrow.setAttribute("d", "M0,0 L8,4 L0,8 z"); arrow.setAttribute("fill", "#9a9daa"); marker.append(arrow); defs.append(marker); svg.append(defs);
  const positions = new Map();
  nodes.forEach((node, index) => {
    const x = 24 + index * 160; const y = node.kind === "decision" ? 74 : 64;
    positions.set(node.key, { x, y });
  });
  for (const edge of block.edges ?? []) {
    const from = positions.get(edge.from); const to = positions.get(edge.to);
    if (!from || !to) continue;
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("class", "edge");
    path.setAttribute("d", `M${from.x + 126},${from.y + 27} C${from.x + 145},${from.y + 27} ${to.x - 20},${to.y + 27} ${to.x - 7},${to.y + 27}`);
    svg.append(path);
    if (edge.label) {
      const label = document.createElementNS(svg.namespaceURI, "text"); label.setAttribute("x", String((from.x + to.x) / 2 + 45)); label.setAttribute("y", String(from.y + 18)); label.textContent = edge.label; svg.append(label);
    }
  }
  for (const node of nodes) {
    const { x, y } = positions.get(node.key);
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("class", `node ${node.kind ?? ""}`); rect.setAttribute("x", String(x)); rect.setAttribute("y", String(y)); rect.setAttribute("width", "126"); rect.setAttribute("height", "54"); rect.setAttribute("rx", node.kind === "terminal" ? "24" : "7"); svg.append(rect);
    const label = document.createElementNS(svg.namespaceURI, "text"); label.setAttribute("x", String(x + 63)); label.setAttribute("y", String(y + 31)); label.setAttribute("text-anchor", "middle"); label.textContent = node.label; svg.append(label);
    if (node.attachments?.length) for (const attachment of node.attachments) {
      for (const source of attachment.sources ?? []) {
        const ref = sourceReference(source);
        if (ref) addSourceCard(wrapper, ref, attachment.label ?? node.label);
      }
    }
  }
  wrapper.append(svg);
  return wrapper;
}

function renderSequence(block) {
  const wrapper = element("figure", "diagram");
  wrapper.append(element("h3", "", block.title ?? "Sequence diagram"));
  const actors = Object.entries(block.actors ?? {});
  const width = Math.max(460, actors.length * 150);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${Math.max(120, 70 + (block.steps?.length ?? 0) * 40)}`);
  const centers = new Map();
  actors.forEach(([key, label], index) => {
    const x = 24 + index * 150; centers.set(key, x + 55);
    const rect = document.createElementNS(svg.namespaceURI, "rect"); rect.setAttribute("class", "node"); rect.setAttribute("x", String(x)); rect.setAttribute("y", "10"); rect.setAttribute("width", "110"); rect.setAttribute("height", "30"); rect.setAttribute("rx", "6"); svg.append(rect);
    const text = document.createElementNS(svg.namespaceURI, "text"); text.setAttribute("x", String(x + 55)); text.setAttribute("y", "30"); text.setAttribute("text-anchor", "middle"); text.textContent = label; svg.append(text);
    const line = document.createElementNS(svg.namespaceURI, "line"); line.setAttribute("class", "lifeline"); line.setAttribute("x1", String(x + 55)); line.setAttribute("x2", String(x + 55)); line.setAttribute("y1", "40"); line.setAttribute("y2", String(65 + (block.steps?.length ?? 0) * 40)); svg.append(line);
  });
  const stepList = element("div", "sequence-steps");
  for (const [index, step] of (block.steps ?? []).entries()) {
    const y = 68 + index * 40; const from = centers.get(step.from); const to = centers.get(step.to);
    const line = document.createElementNS(svg.namespaceURI, "line"); line.setAttribute("class", "edge"); line.setAttribute("x1", String(from ?? 0)); line.setAttribute("x2", String(to ?? 0)); line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y)); line.setAttribute("marker-end", "url(#arrow)"); svg.append(line);
    const text = document.createElementNS(svg.namespaceURI, "text"); text.setAttribute("x", String(((from ?? 0) + (to ?? 0)) / 2)); text.setAttribute("y", String(y - 6)); text.setAttribute("text-anchor", "middle"); text.textContent = step.label ?? step.explanation ?? step.code?.caption ?? step.source?.path ?? "message"; svg.append(text);
    stepList.append(element("div", "sequence-step", `${block.actors?.[step.from] ?? step.from} → ${block.actors?.[step.to] ?? step.to}: ${step.label ?? step.explanation ?? step.code?.caption ?? "message"}`));
    const reference = sourceReference(step.source);
    if (reference) addSourceCard(wrapper, reference, step.label ?? "Sequence source");
  }
  wrapper.append(svg, stepList);
  return wrapper;
}

async function showCodeReference(reference, label, target = document.querySelector("#code-references")) {
  if (!reference) return false;
  try {
    const query = new URLSearchParams({ side: reference.side, file: reference.file });
    const file = await (await api(`/file?${query}`)).json();
    const lines = String(file.text ?? "").split("\n");
    if (reference.start < 1 || reference.end < reference.start || reference.start > lines.length)
      throw new Error("The referenced line range is outside this file.");
    const card = element("section", "source-result");
    card.append(element("h3", "", `${label} · ${reference.side}/${reference.file}:${reference.start}-${reference.end}`));
    const pre = element("pre", "code-snippet");
    pre.textContent = lines.slice(Math.max(0, reference.start - 1), reference.end).map((line, index) => `${reference.start + index}  ${line}`).join("\n");
    if (!pre.textContent.trim()) throw new Error("The referenced file did not contain code at this line range.");
    card.append(pre);
    target?.append(card);
    mark("code-reference", true);
    return true;
  } catch (error) {
    target?.append(element("p", "error", `Could not load ${reference.file}: ${error.message}`));
    return false;
  }
}

function addSourceCard(parent, reference, label) {
  const button = element("button", "source-card");
  button.type = "button";
  button.append(element("strong", "", label), element("span", "small-label", ` ${reference.side}/${reference.file}:${reference.start}-${reference.end}`));
  button.addEventListener("click", () => showCodeReference(reference, label));
  parent.append(button);
}

async function render() {
  if (!reviewId || !runId) throw new Error("The review or run id is missing from the host URL.");
  const state = await (await fetch("/__state")).json();
  snapshot = await (await api("?full=true")).json();
  const heading = element("div", "review-heading");
  const title = element("div");
  title.append(element("h1", "", snapshot.title ?? "Untitled review"), element("div", "meta", `Review ${snapshot.reviewId} · v${snapshot.version} · ${state.fixture} fixture`));
  heading.append(title);
  const columns = element("div", "columns");
  const prosePanel = element("section", "panel"); prosePanel.append(element("h2", "", "Review"));
  const prose = element("div", "panel-body prose-block");
  const diagrams = [];
  for (const block of snapshot.document ?? []) {
    if (block.type === "markdown") markdownInto(prose, block.markdown);
    else if (block.type === "flow_diagram") diagrams.push(renderFlow(block));
    else if (block.type === "sequence") diagrams.push(renderSequence(block));
    else prose.append(element("pre", "", JSON.stringify(block, null, 2)));
  }
  mark("prose", prose.childElementCount > 0);
  for (const diagram of diagrams) prose.append(diagram);
  mark("diagram", diagrams.length > 0);
  prosePanel.append(prose);

  const details = element("div", "details");
  const diffPanel = element("section", "panel"); diffPanel.append(element("h2", "", "Base / head diff"));
  const diffBody = element("div", "panel-body");
  const files = await (await api("/diff?format=files")).json();
  if (Array.isArray(files) && files.length) {
    const list = element("div");
    let selected = files[0];
    const patch = element("pre", "diff-patch");
    const showPatch = async (file) => {
      selected = file;
      for (const button of list.children) button.classList.toggle("selected", button.dataset.path === file.path);
      const query = new URLSearchParams({ paths: file.path, format: "patch" });
      patch.textContent = await (await api(`/diff?${query}`)).text();
      for (const line of patch.textContent.split("\n")) {
        if (line.startsWith("+")) patch.classList.add("has-additions");
        if (line.startsWith("-")) patch.classList.add("has-removals");
      }
    };
    for (const file of files) {
      const button = element("button", "diff-file"); button.type = "button"; button.dataset.path = file.path;
      button.append(element("span", "", `${file.status}  ${file.path}`), element("span", "diff-count", `+${file.additions} −${file.deletions}`));
      button.addEventListener("click", () => showPatch(file).catch((error) => { patch.textContent = error.message; }));
      list.append(button);
    }
    diffBody.append(list, patch);
    await showPatch(selected);
    mark("diff", true);
  } else diffBody.append(element("p", "empty", "No changed files in this review."));
  diffPanel.append(diffBody);

  const codePanel = element("section", "panel"); codePanel.append(element("h2", "", "Code references"));
  const codeBody = element("div", "panel-body source-list"); codeBody.id = "code-references";
  const references = [];
  for (const block of snapshot.document ?? []) {
    if (block.type === "markdown") {
      for (const match of block.markdown.matchAll(/\]\((review-source:[^)]+)\)/g)) {
        const reference = parseSourceReference(match[1]);
        if (reference && !references.some((item) => item.file === reference.file && item.start === reference.start)) references.push(reference);
      }
    }
    if (block.type === "flow_diagram") for (const node of block.nodes ?? []) for (const attachment of node.attachments ?? []) for (const source of attachment.sources ?? []) {
      const reference = sourceReference(source);
      if (reference) references.push(reference);
    }
    if (block.type === "sequence") for (const step of block.steps ?? []) {
      const reference = sourceReference(step.source);
      if (reference) references.push(reference);
    }
  }
  let successfulCodeReferences = 0;
  for (const reference of references)
    if (await showCodeReference(reference, "Review evidence", codeBody)) successfulCodeReferences += 1;
  if (!references.length) codeBody.append(element("p", "empty", "No code references in this review."));
  codePanel.append(codeBody);
  details.append(diffPanel, codePanel);
  columns.append(prosePanel, details);
  app.replaceChildren(heading, columns);
  cliButton.disabled = false;
  if (successfulCodeReferences !== references.length || successfulCodeReferences === 0) {
    status.textContent = "Review rendered · code references incomplete";
    return;
  }
  status.textContent = "Review rendered";
  const ready = await fetch("/__ready", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, rendered: [...rendered] }) });
  if (!ready.ok) throw new Error(`Host did not accept render readiness (${ready.status}).`);
  status.textContent = "Ready";
}

cliButton.addEventListener("click", async () => {
  cliButton.disabled = true;
  cliOutput.textContent = "Running Whiteboard CLI review_get…";
  cliDialog.showModal();
  try {
    const response = await fetch("/__cli", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? response.statusText);
    cliOutput.textContent = result.output;
  } catch (error) {
    cliOutput.textContent = error.message;
  } finally {
    cliButton.disabled = false;
  }
});

render().catch((error) => {
  status.textContent = "Review failed";
  app.replaceChildren(element("section", "panel error", error.message));
});
