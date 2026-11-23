import { highlight, languageFor } from "./highlight";
import { applyTokens, parsePatch, type Chunk, type DiffFile, type Hunk, type Line, type Risk } from "./parse";

// ---------------------------------------------------------------------------------------------
// Types

type Layout = "unified" | "split";
type Side = "old" | "new";

type Row =
  | { k: "file"; f: number }
  | { k: "hunk"; f: number; h: Hunk }
  | { k: "line"; f: number; ln: Line }
  | { k: "pair"; f: number; l: Line | null; r: Line | null }
  | { k: "note"; f: number; text: string; button?: string }
  | { k: "card"; f: number };

interface RenderPayload {
  files: DiffFile[];
  labels?: Record<string, Risk> | null;
  layout?: Layout;
  headSha?: string;
}

interface Selection {
  f: number;
  /** Split view: the side the drag started on. Unified: null. */
  side: Side | null;
  a: number;
  b: number;
}

interface Pick {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  text: string;
}

declare global {
  interface Window {
    quack: Record<string, (...args: never[]) => void>;
    webkit?: { messageHandlers?: { quack?: { postMessage(m: unknown): void } } };
  }
}

// ---------------------------------------------------------------------------------------------
// State

const H_FILE = 40;
const H_HUNK = 26;
const H_NOTE = 34;
const H_CARD = 138;
const OVERSCAN = 400;

let files: DiffFile[] = [];
let labels: Record<string, Risk> = {};
let layout: Layout = "unified";
let headSha = "";
let fontSize = 12;
let lineHeight = 19;
let rows: Row[] = [];
let offsets = new Float64Array(1);
let heights = new Float64Array(0);
let fileStart: number[] = [];
let hunkRows: number[] = [];
let fileHunks: Hunk[][] = [];
let selection: Selection | null = null;
let cardOpen = false;
let signature = "";

const scroller = document.getElementById("scroller") as HTMLDivElement;
const content = document.getElementById("content") as HTMLDivElement;
const sticky = document.getElementById("sticky") as HTMLDivElement;
const live = new Map<number, HTMLElement>();
let cardEl: HTMLElement | null = null;
let stickyFile = -1;
let pinnedFile: string | null = null;
let lastReported: string | null = null;

function post(message: Record<string, unknown>): void {
  window.webkit?.messageHandlers?.quack?.postMessage(message);
}

// ---------------------------------------------------------------------------------------------
// Row model

function rowHeight(r: Row): number {
  switch (r.k) {
    case "file": return H_FILE;
    case "hunk": return H_HUNK;
    case "note": return H_NOTE;
    case "card": return H_CARD;
    default: return lineHeight;
  }
}

function buildRows(): void {
  rows = [];
  fileHunks = [];
  files.forEach((file, f) => {
    rows.push({ k: "file", f });
    if (file.binary) {
      rows.push({ k: "note", f, text: "Binary file" });
      fileHunks.push([]);
      return;
    }
    if (file.truncated) {
      rows.push({ k: "note", f, text: "Diff too large to show here.", button: "Open on GitHub" });
      fileHunks.push([]);
      return;
    }
    const hunks = file.patch ? parsePatch(file.patch, f) : [];
    fileHunks.push(hunks);
    if (!hunks.length) {
      rows.push({ k: "note", f, text: file.status === "renamed" ? "Renamed without changes." : "No content changes to show." });
      return;
    }
    for (const h of hunks) {
      rows.push({ k: "hunk", f, h });
      if (layout === "unified") {
        for (const ln of h.lines) rows.push({ k: "line", f, ln });
      } else {
        pairUp(h.lines, f);
      }
    }
  });
}

function pairUp(lines: Line[], f: number): void {
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.t === "ctx" || ln.t === "meta") {
      rows.push({ k: "pair", f, l: ln, r: ln });
      i++;
      continue;
    }
    const dels: Line[] = [];
    const adds: Line[] = [];
    while (i < lines.length && lines[i].t === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].t === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let j = 0; j < n; j++) rows.push({ k: "pair", f, l: dels[j] ?? null, r: adds[j] ?? null });
  }
}

function computeOffsets(): void {
  const n = rows.length;
  heights = new Float64Array(n);
  offsets = new Float64Array(n + 1);
  fileStart = [];
  hunkRows = [];
  let y = 0;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    heights[i] = rowHeight(r);
    offsets[i] = y;
    y += heights[i];
    if (r.k === "file") fileStart[r.f] = i;
    else if (r.k === "hunk") hunkRows.push(i);
  }
  offsets[n] = y;
  content.style.height = `${y}px`;
  scroller.setAttribute("aria-rowcount", String(n));
}

function rowAt(y: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Index of the file whose header is at or above `y`. */
function fileAt(y: number): number {
  if (!files.length) return -1;
  const i = rowAt(y + 1);
  return rows[i]?.f ?? 0;
}

// ---------------------------------------------------------------------------------------------
// DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Static markup only (never diff content).
const BARS: Record<string, [number, number, number]> = { high: [1, 1, 1], medium: [1, 1, 0.3], low: [1, 0.3, 0.3], unlabeled: [1, 1, 1] };
function riskBadge(risk: Risk): HTMLElement {
  const cls = { high: "hi", medium: "md", low: "lo", unlabeled: "un" }[risk.risk] ?? "un";
  const word = { high: "High", medium: "Medium", low: "Low", unlabeled: "Unlabeled" }[risk.risk] ?? "Unlabeled";
  const [a, b, c] = BARS[risk.risk] ?? BARS.unlabeled;
  const badge = el("span", `risk ${cls}`);
  badge.innerHTML =
    `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0" y="6" width="2.4" height="4" rx=".6" fill="currentColor" opacity="${a}"/>` +
    `<rect x="3.8" y="3" width="2.4" height="7" rx=".6" fill="currentColor" opacity="${b}"/>` +
    `<rect x="7.6" y="0" width="2.4" height="10" rx=".6" fill="currentColor" opacity="${c}"/></svg>`;
  const w = el("span", undefined, word);
  badge.append(w);
  return badge;
}

const LOGO =
  '<svg width="13.5" height="9" viewBox="0 0 36 24" aria-hidden="true"><path class="brace" d="M7 3C4.6 3 4.4 4.8 4.4 7V9.6C4.4 11 3.6 12 2 12C3.6 12 4.4 13 4.4 14.4V17C4.4 19.2 4.6 21 7 21" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path class="brace" d="M29 3C31.4 3 31.6 4.8 31.6 7V9.6C31.6 11 32.4 12 34 12C32.4 12 31.6 13 31.6 14.4V17C31.6 19.2 31.4 21 29 21" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<g transform="rotate(-12 18 12)"><path d="M18 21.4Q16.6 21.4 16 20L10.6 8.8Q9.9 6.6 12 6.8Q15.3 10.6 16.8 4.2Q18 1.8 19.2 4.2Q20.7 10.6 24 6.8Q26.1 6.6 25.4 8.8L20 20Q19.4 21.4 18 21.4Z" fill="#ff980f"/>' +
  '<path d="M18 17.2L12.2 8.2M18 17.2V4.8M18 17.2L23.8 8.2" fill="none" stroke="#ffcc33" stroke-width="1.2" stroke-linecap="round"/></g></svg>';

function fileHeader(f: number): HTMLElement {
  const file = files[f];
  const h = el("div", "fh");
  h.dataset.f = String(f);
  const shown = file.status === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  h.append(el("span", "path", shown));
  h.querySelector(".path")!.setAttribute("title", shown);
  const risk = labels[file.path];
  if (risk) h.append(riskBadge(risk));
  h.append(risk?.reason ? el("span", "reason", risk.reason) : el("span", "sp"));
  // As on the canvas: zero sides are left out ("+96" for a new file), unless both are zero.
  if (file.additions > 0 || file.deletions === 0) h.append(el("span", "tn add", `+${file.additions}`));
  if (file.deletions > 0) h.append(el("span", "tn del", `−${file.deletions}`));
  const ask = el("button", "btn");
  ask.type = "button";
  ask.innerHTML = LOGO;
  ask.append(document.createTextNode("Ask about file"));
  ask.addEventListener("click", (e) => {
    e.stopPropagation();
    post({ type: "askAboutFile", path: file.path });
  });
  h.append(ask);
  return h;
}

function label(r: Row): string {
  const file = files[r.f];
  switch (r.k) {
    case "file": {
      const risk = labels[file.path];
      return `File ${file.path}${risk ? `, ${risk.risk} risk` : ""}, ${file.additions} added, ${file.deletions} removed`;
    }
    case "hunk": return `Hunk ${r.h.header} ${r.h.context}`.trim();
    case "line": return lineLabel(r.ln);
    case "pair": return [r.l && `Old: ${lineLabel(r.l)}`, r.r && r.r !== r.l && `New: ${lineLabel(r.r)}`].filter(Boolean).join(". ") || "Empty";
    case "note": return r.text;
    default: return "Ask about the selected lines";
  }
}

function lineLabel(l: Line): string {
  if (l.t === "meta") return l.text;
  const num = l.t === "del" ? l.o : l.n;
  const kind = l.t === "add" ? "added" : l.t === "del" ? "removed" : "unchanged";
  return `Line ${num}, ${kind}: ${l.text}`;
}

function fillText(tx: HTMLElement, l: Line): void {
  if (!l.tok) {
    tx.textContent = l.text;
    return;
  }
  for (const [cls, text] of l.tok) {
    if (cls) tx.append(el("span", cls, text));
    else tx.append(document.createTextNode(text));
  }
}

function mark(t: Line["t"]): string {
  return t === "add" ? "+" : t === "del" ? "−" : "";
}

function isPicked(i: number, side: Side | null): boolean {
  if (!selection) return false;
  if (i < selection.a || i > selection.b) return false;
  if (selection.side && side !== selection.side) return false;
  return true;
}

const pendingChunks: Chunk[] = [];
function queueChunk(c: Chunk): void {
  if (c.done || c.queued) return;
  c.queued = true;
  pendingChunks.push(c);
}

function cell(l: Line | null, i: number, side: Side): HTMLElement {
  if (!l) {
    const e = el("div", "half empty");
    e.dataset.side = side;
    return e;
  }
  queueChunk(l.chunk);
  const e = el("div", `half ${l.t === "meta" ? "meta" : l.t === "add" ? "add" : l.t === "del" ? "del" : ""}`);
  e.dataset.side = side;
  e.setAttribute("role", "gridcell");
  const num = side === "old" ? l.o : l.n;
  const g = el("span", "g", num === null ? "" : String(num));
  g.dataset.g = "1";
  const tx = el("span", "tx");
  fillText(tx, l);
  e.append(g, el("span", "mk", mark(l.t)), tx);
  if (l.t === "meta") tx.style.fontStyle = "italic";
  else e.append(plusHandle());
  if (isPicked(i, side) && l.t !== "meta") e.classList.add("pick");
  return e;
}

/** The "+" shown on hover, as in most review tools: click asks about the line, drag asks about a range. */
function plusHandle(): HTMLElement {
  const p = el("span", "plus", "+");
  p.dataset.g = "1";
  p.dataset.plus = "1";
  p.setAttribute("aria-hidden", "true");
  p.title = "Ask about this line (drag for more lines)";
  return p;
}

function buildRow(i: number): HTMLElement {
  const r = rows[i];
  const wrap = el("div", "row");
  wrap.setAttribute("role", "row");
  wrap.setAttribute("aria-rowindex", String(i + 1));
  wrap.setAttribute("aria-label", label(r));
  wrap.dataset.i = String(i);
  wrap.style.top = `${offsets[i]}px`;
  wrap.style.height = `${heights[i]}px`;
  switch (r.k) {
    case "file": {
      wrap.append(fileHeader(r.f));
      break;
    }
    case "hunk": {
      const e = el("div", "hunk");
      e.append(el("span", undefined, r.h.header), el("span", "hc", r.h.context));
      wrap.append(e);
      break;
    }
    case "line": {
      const l = r.ln;
      queueChunk(l.chunk);
      const e = el("div", `dl ${l.t}`);
      e.setAttribute("role", "gridcell");
      const g1 = el("span", "g", l.o === null ? "" : String(l.o));
      const g2 = el("span", "g", l.n === null ? "" : String(l.n));
      g1.dataset.g = "1";
      g2.dataset.g = "1";
      const tx = el("span", "tx");
      fillText(tx, l);
      e.append(g1, g2, el("span", "mk", mark(l.t)), tx);
      if (l.t !== "meta") e.append(plusHandle());
      if (isPicked(i, null) && l.t !== "meta") {
        e.classList.add("pick");
        if (selection && i === selection.b && !cardOpen) e.append(askAffordance());
      }
      wrap.append(e);
      break;
    }
    case "pair": {
      const e = el("div", "sp2");
      e.append(cell(r.l, i, "old"), cell(r.r, i, "new"));
      if (selection && i === selection.b && !cardOpen) e.append(askAffordance());
      wrap.append(e);
      break;
    }
    case "note": {
      const e = el("div", "note", r.text);
      if (r.button) {
        const b = el("button", "btn", r.button);
        b.type = "button";
        b.addEventListener("click", () => post({ type: "openGitHub", path: files[r.f].path }));
        e.append(b);
      }
      wrap.append(e);
      break;
    }
    case "card": {
      wrap.removeAttribute("aria-label");
      wrap.append(ensureCard());
      break;
    }
  }
  return wrap;
}

function askAffordance(): HTMLElement {
  const box = el("span", "askpill");
  const b = el("button", "btn", "Ask ⌘↩");
  b.type = "button";
  b.addEventListener("mousedown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    openCard();
  });
  box.append(b);
  return box;
}

// ---------------------------------------------------------------------------------------------
// Virtual drawing

let drawQueued = false;
function schedule(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function draw(force = false): void {
  if (force) {
    for (const e of live.values()) e.remove();
    live.clear();
  }
  if (!rows.length) {
    sticky.style.display = "none";
    return;
  }
  const top = scroller.scrollTop;
  const first = rowAt(Math.max(0, top - OVERSCAN));
  const last = rowAt(top + scroller.clientHeight + OVERSCAN);
  for (const [i, e] of live) {
    if (i < first || i > last) {
      if (e.firstElementChild === cardEl) e.removeChild(cardEl!);
      e.remove();
      live.delete(i);
    }
  }
  const frag = document.createDocumentFragment();
  for (let i = first; i <= last; i++) {
    if (live.has(i)) continue;
    const e = buildRow(i);
    live.set(i, e);
    frag.append(e);
  }
  content.append(frag);
  updateSticky();
  if (pendingChunks.length) setTimeout(processChunks, 0);
}

function processChunks(): void {
  if (!pendingChunks.length) return;
  const started = performance.now();
  let any = false;
  while (pendingChunks.length && performance.now() - started < 12) {
    const c = pendingChunks.shift()!;
    if (c.done) continue;
    const lang = languageFor(files[c.file].path);
    if (lang) {
      applyTokens(c, (t) => highlight(t, lang));
      any = true;
    } else {
      c.done = true;
    }
  }
  if (any) redrawKeepingCard();
  if (pendingChunks.length) setTimeout(processChunks, 0);
}

function redrawKeepingCard(): void {
  // Drop line rows so they rebuild with tokens; the card row (and its textarea state) stays.
  for (const [i, e] of live) {
    const r = rows[i];
    if (r.k === "line" || r.k === "pair") {
      e.remove();
      live.delete(i);
    }
  }
  draw();
}

function updateSticky(): void {
  const f = fileAt(scroller.scrollTop);
  const showing = f >= 0 && scroller.scrollTop >= offsets[fileStart[f]];
  if (!showing) {
    sticky.style.display = "none";
    stickyFile = -1;
    return;
  }
  sticky.style.display = "block";
  sticky.style.right = `${scroller.offsetWidth - scroller.clientWidth}px`;
  if (stickyFile !== f || !sticky.firstChild) {
    stickyFile = f;
    sticky.replaceChildren(fileHeader(f));
  }
}

function refreshAll(): void {
  stickyFile = -1;
  computeOffsets();
  draw(true);
}

// ---------------------------------------------------------------------------------------------
// Navigation

function currentFile(): number {
  return fileAt(scroller.scrollTop);
}

function userScrolled(): void {
  pinnedFile = null;
}

let reportTimer: number | undefined;
function reportVisible(): void {
  window.clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => {
    if (pinnedFile) return;
    const f = currentFile();
    if (f < 0) return;
    const path = files[f].path;
    if (path === lastReported) return;
    lastReported = path;
    post({ type: "visibleFile", path });
  }, 90);
}

function scrollToFile(path: string): void {
  const f = files.findIndex((x) => x.path === path);
  if (f < 0) return;
  pinnedFile = path;
  lastReported = path;
  scroller.scrollTop = offsets[fileStart[f]];
  draw();
}

function goFile(delta: number): void {
  if (!files.length) return;
  const top = scroller.scrollTop;
  let target: number;
  if (delta > 0) {
    target = files.findIndex((_, f) => offsets[fileStart[f]] > top + 2);
    if (target < 0) return;
  } else {
    target = -1;
    for (let f = 0; f < files.length; f++) if (offsets[fileStart[f]] < top - 2) target = f;
    if (target < 0) target = 0;
  }
  userScrolled();
  scroller.scrollTop = offsets[fileStart[target]];
  draw();
  reportVisible();
}

function goHunk(delta: number): void {
  if (!hunkRows.length) return;
  const top = scroller.scrollTop + H_FILE;
  let target = -1;
  if (delta > 0) {
    target = hunkRows.find((i) => offsets[i] > top + 2) ?? -1;
  } else {
    for (const i of hunkRows) if (offsets[i] < top - 2) target = i;
  }
  if (target < 0) return;
  userScrolled();
  scroller.scrollTop = Math.max(0, offsets[target] - H_FILE);
  draw();
  reportVisible();
}

// ---------------------------------------------------------------------------------------------
// Selection and the inline ask card

function rowIndexOf(node: EventTarget | null): number {
  const e = (node as HTMLElement | null)?.closest?.("[data-i]") as HTMLElement | null;
  return e ? Number(e.dataset.i) : -1;
}

function selectable(i: number): boolean {
  const r = rows[i];
  return !!r && (r.k === "line" || r.k === "pair");
}

let dragging: { f: number; side: Side | null; anchor: number; ask?: boolean } | null = null;

function startDrag(e: MouseEvent): void {
  const g = (e.target as HTMLElement).closest("[data-g]");
  if (!g || e.button !== 0) return;
  const i = rowIndexOf(g);
  if (!selectable(i)) return;
  const r = rows[i];
  const half = (g as HTMLElement).closest(".half") as HTMLElement | null;
  const side = layout === "split" ? ((half?.dataset.side as Side | undefined) ?? "new") : null;
  if (layout === "split" && r.k === "pair") {
    const l = side === "old" ? r.l : r.r;
    if (!l || l.t === "meta") return;
  }
  e.preventDefault();
  closeCard(false);
  if (e.shiftKey && selection && selection.f === r.f && selection.side === side) {
    const anchor = selection.a;
    dragging = { f: r.f, side, anchor };
    setSelection(r.f, side, anchor, i);
    finishDrag();
    return;
  }
  // Started on the "+": the ask card opens as soon as the mouse goes up.
  dragging = { f: r.f, side, anchor: i, ask: !!(e.target as HTMLElement).closest("[data-plus]") };
  scroller.classList.add("dragging");
  setSelection(r.f, side, i, i);
}

function moveDrag(e: MouseEvent): void {
  if (!dragging) return;
  const box = scroller.getBoundingClientRect();
  if (e.clientY < box.top + 30) scroller.scrollTop -= 14;
  else if (e.clientY > box.bottom - 24) scroller.scrollTop += 14;
  let i = rowIndexOf(document.elementFromPoint(Math.min(Math.max(e.clientX, box.left + 5), box.right - 20), Math.min(Math.max(e.clientY, box.top + 2), box.bottom - 2)));
  if (i < 0) return;
  // Clamp to rows of the same file.
  const f = dragging.f;
  while (i >= 0 && i < rows.length && rows[i].f !== f) i += rows[i].f > f ? -1 : 1;
  if (!selectable(i)) {
    const dir = i < dragging.anchor ? 1 : -1;
    while (i >= 0 && i < rows.length && rows[i].f === f && !selectable(i)) i += dir;
    if (!selectable(i) || rows[i].f !== f) return;
  }
  setSelection(f, dragging.side, dragging.anchor, i);
}

function finishDrag(): void {
  if (!dragging) return;
  const ask = dragging.ask;
  dragging = null;
  scroller.classList.remove("dragging");
  const pick = currentPick();
  if (pick) post({ type: "selectLines", ...pick });
  draw(true);
  if (ask && pick) openCard();
}

function setSelection(f: number, side: Side | null, a: number, b: number): void {
  const next = { f, side, a: Math.min(a, b), b: Math.max(a, b) };
  if (selection && selection.f === next.f && selection.side === next.side && selection.a === next.a && selection.b === next.b) return;
  selection = next;
  for (const [i, e] of live) {
    const r = rows[i];
    if (r.k === "line" || r.k === "pair") {
      e.remove();
      live.delete(i);
    }
  }
  draw();
}

function clearSelection(): void {
  if (!selection) return;
  selection = null;
  draw(true);
}

function selectedLines(): Line[] {
  if (!selection) return [];
  const out: Line[] = [];
  for (let i = selection.a; i <= selection.b; i++) {
    const r = rows[i];
    if (r.k === "line") out.push(r.ln);
    else if (r.k === "pair") {
      if (!selection.side) {
        if (r.l && r.l.t !== "ctx") out.push(r.l);
        if (r.r && r.r.t !== "meta") out.push(r.r);
      } else {
        const l = selection.side === "old" ? r.l : r.r;
        if (l) out.push(l);
      }
    }
  }
  return out.filter((l) => l.t !== "meta");
}

function currentPick(): Pick | null {
  const lines = selectedLines();
  if (!selection || !lines.length) return null;
  const side: Side = selection.side ?? (lines.some((l) => l.t !== "del") ? "new" : "old");
  const nums = lines.map((l) => (side === "old" ? l.o : l.n)).filter((n): n is number => n !== null);
  if (!nums.length) return null;
  const text = lines.map((l) => `${l.t === "add" ? "+" : l.t === "del" ? "-" : " "}${l.text}`).join("\n");
  return { path: files[selection.f].path, side, startLine: Math.min(...nums), endLine: Math.max(...nums), text };
}

function ensureCard(): HTMLElement {
  if (cardEl) return cardEl;
  const card = el("div");
  card.id = "card";
  card.setAttribute("role", "form");
  card.setAttribute("aria-label", "Ask about the selected lines");
  const top = el("div", "top");
  const pill = el("span", "pill");
  pill.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/></svg>';
  const pt = el("span", "pt");
  pt.id = "pill-text";
  const close = el("button", "x");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.innerHTML =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
  close.addEventListener("click", () => closeCard(true));
  pill.append(pt, close);
  const count = el("span", "l2");
  count.id = "pill-count";
  top.append(pill, count);
  const ta = el("textarea");
  ta.id = "ask-text";
  ta.placeholder = "Ask about these lines";
  ta.setAttribute("aria-label", "Question");
  ta.addEventListener("input", () => (submit.disabled = !ta.value.trim()));
  const bot = el("div", "bot");
  const hint = el("span", "l2 grow", "The answer opens in chat.");
  const esc = el("span", "l2", "Esc");
  const submit = el("button", "btn ask");
  submit.id = "ask-submit";
  submit.type = "button";
  submit.disabled = true;
  submit.append(document.createTextNode("Ask "), el("span", undefined, "⌘↩"));
  submit.addEventListener("click", sendAsk);
  bot.append(hint, esc, submit);
  card.append(top, ta, bot);
  for (const type of ["mousedown", "keydown"]) card.addEventListener(type, (e) => e.stopPropagation());
  card.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Escape") {
      ke.preventDefault();
      closeCard(true);
    } else if (ke.key === "Enter" && (ke.metaKey || ke.ctrlKey)) {
      ke.preventDefault();
      sendAsk();
    }
  });
  cardEl = card;
  return card;
}

function openCard(): void {
  const pick = currentPick();
  if (!pick || !selection || cardOpen) return;
  cardOpen = true;
  const card = ensureCard();
  const range = pick.startLine === pick.endLine ? `${pick.startLine}` : `${pick.startLine}–${pick.endLine}`;
  card.querySelector("#pill-text")!.textContent = `${pick.path}:${range}`;
  const n = selectedLines().length;
  card.querySelector("#pill-count")!.textContent = `${n} line${n === 1 ? "" : "s"} selected`;
  (card.querySelector("#ask-text") as HTMLTextAreaElement).value = "";
  (card.querySelector("#ask-submit") as HTMLButtonElement).disabled = true;
  const at = selection.b + 1;
  rows.splice(at, 0, { k: "card", f: selection.f });
  const anchor = scroller.scrollTop;
  refreshAll();
  scroller.scrollTop = anchor;
  // Make sure the card is on screen.
  const bottom = offsets[at] + H_CARD;
  if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight + 8;
  draw();
  (card.querySelector("#ask-text") as HTMLTextAreaElement).focus();
}

function closeCard(refocus: boolean): void {
  if (!cardOpen) return;
  cardOpen = false;
  const at = rows.findIndex((r) => r.k === "card");
  if (cardEl && cardEl.parentElement) cardEl.remove();
  if (at >= 0) rows.splice(at, 1);
  const anchor = scroller.scrollTop;
  refreshAll();
  scroller.scrollTop = anchor;
  draw();
  if (refocus) scroller.focus({ preventScroll: true });
}

function sendAsk(): void {
  const ta = cardEl?.querySelector("#ask-text") as HTMLTextAreaElement | null;
  const question = ta?.value.trim();
  const pick = currentPick();
  if (!question || !pick) return;
  post({ type: "askInline", question, selection: pick });
  closeCard(true);
  clearSelection();
}

// ---------------------------------------------------------------------------------------------
// Events

let scrollTimer: number | undefined;
scroller.addEventListener("scroll", () => {
  schedule();
  reportVisible();
  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => post({ type: "scroll", top: scroller.scrollTop }), 250);
}, { passive: true });
scroller.addEventListener("wheel", userScrolled, { passive: true });
scroller.addEventListener("mousedown", (e) => {
  userScrolled();
  startDrag(e);
  if (!(e.target as HTMLElement).closest("#card")) scroller.focus({ preventScroll: true });
});
window.addEventListener("mousemove", moveDrag);
window.addEventListener("mouseup", finishDrag);
new ResizeObserver(() => {
  if (rows.length) {
    stickyFile = -1;
    schedule();
  }
}).observe(scroller);

// Delegated: clicking the header of the sticky overlay buttons works via their own listeners.
document.addEventListener("keydown", (e) => {
  const inField = (e.target as HTMLElement).closest?.("textarea,input");
  if (inField) return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openCard();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case "j": goFile(1); break;
    case "k": goFile(-1); break;
    case "n": goHunk(1); break;
    case "N": goHunk(-1); break;
    case "Escape":
      if (cardOpen) closeCard(true);
      else clearSelection();
      break;
    default: return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------------------------------------
// API for Swift

function applyFont(): void {
  lineHeight = Math.max(15, Math.round((fontSize * 19) / 12));
  const root = document.documentElement.style;
  root.setProperty("--fs", `${fontSize}px`);
  root.setProperty("--lh", `${lineHeight}px`);
}

function withAnchor(change: () => void): void {
  const f = currentFile();
  const path = f >= 0 ? files[f]?.path : null;
  const delta = f >= 0 ? scroller.scrollTop - offsets[fileStart[f]] : 0;
  change();
  const nf = path ? files.findIndex((x) => x.path === path) : -1;
  scroller.scrollTop = nf >= 0 ? offsets[fileStart[nf]] + delta : 0;
  draw();
}

function render(p: RenderPayload): void {
  const nextFiles = p.files ?? [];
  const nextSig = `${p.headSha ?? ""}|${nextFiles.map((f) => `${f.path}:${f.patch?.length ?? 0}:${f.truncated}:${f.binary}`).join(",")}`;
  const nextLayout = p.layout ?? layout;
  labels = p.labels ?? {};
  headSha = p.headSha ?? "";
  if (nextSig === signature && nextLayout === layout) {
    // Only labels changed: rebuild the file headers alone. Line rows stay put, so a drag in progress,
    // the "Ask" button under the pointer and the open ask card (with its focus) all survive.
    for (const [i, e] of live) {
      if (rows[i].k === "file") {
        e.remove();
        live.delete(i);
      }
    }
    stickyFile = -1;
    draw();
    return;
  }
  withAnchor(() => {
    signature = nextSig;
    files = nextFiles;
    layout = nextLayout;
    selection = null;
    cardOpen = false;
    cardEl?.remove();
    pendingChunks.length = 0;
    buildRows();
    refreshAll();
  });
}

window.quack = {
  render: render as never,
  setTheme: ((t: { vars?: Record<string, string>; dark?: boolean }) => {
    const root = document.documentElement;
    root.classList.toggle("dark", !!t.dark);
    for (const [k, v] of Object.entries(t.vars ?? {})) root.style.setProperty(k.startsWith("--") ? k : `--${k}`, v);
  }) as never,
  scrollToFile: scrollToFile as never,
  scrollToTop: ((px: number) => {
    // Restores an exact position; the sidebar follows the file now at the top.
    pinnedFile = null;
    lastReported = null;
    scroller.scrollTop = Math.max(0, px);
    draw();
    reportVisible();
  }) as never,
  nextHunk: (() => goHunk(1)) as never,
  previousHunk: (() => goHunk(-1)) as never,
  nextFile: (() => goFile(1)) as never,
  previousFile: (() => goFile(-1)) as never,
  setLayout: ((l: Layout) => {
    if (l === layout) return;
    layout = l;
    withAnchor(() => {
      selection = null;
      cardOpen = false;
      cardEl?.remove();
      buildRows();
      refreshAll();
    });
  }) as never,
  setFontSize: ((px: number) => {
    fontSize = Math.min(24, Math.max(9, px));
    applyFont();
    withAnchor(() => refreshAll());
  }) as never,
};

applyFont();
post({ type: "ready" });
