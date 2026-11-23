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
  | { k: "card"; f: number }
  // Writing reviews: a GitHub thread, my pending comment, and the comment editor.
  | { k: "thread"; f: number; id: string }
  | { k: "draft"; f: number; id: string }
  | { k: "editor"; f: number };

type GhSide = "LEFT" | "RIGHT";

interface RDraft {
  id: string;
  path: string | null;
  side: GhSide | null;
  line: number | null;
  startLine: number | null;
  replyTo: string | null;
  body: string;
  origin: string;
  /** Its lines changed in a newer commit: what they were and what the same lines hold now. */
  outdated?: { old: string[]; now: string[]; changedIn: string };
}

interface RComment {
  author: string;
  initials: string;
  color: string;
  when: string;
  body: string;
}

interface RThread {
  id: string;
  path: string;
  side: GhSide;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  canResolve: boolean;
  canReply: boolean;
  comments: RComment[];
}

interface ReviewPayload {
  /** Comments can be written (the server supports it). */
  enabled: boolean;
  me: { initials: string; color: string };
  drafts: RDraft[];
  threads: RThread[];
  viewed: Record<string, boolean>;
}

/** Where the editor writes: a range on one side of a file, or an existing draft being edited. */
interface EditorTarget {
  f: number;
  path: string;
  side: GhSide;
  startLine: number;
  line: number;
  /** The base row the editor sits under. */
  after: Row;
  draftId?: string;
  /** Drafted by the agent from a chat answer ("Turn into comment"). */
  origin?: "agent";
}

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
/** The diff's own rows; `rows` adds review threads, drafts and the open card or editor in between. */
let base: Row[] = [];
let rows: Row[] = [];
let review: ReviewPayload = { enabled: false, me: { initials: "", color: "#334155" }, drafts: [], threads: [], viewed: {} };
/** Measured heights of thread and draft rows, by row key; cleared when they or the width change. */
const heightCache = new Map<string, number>();
let measuredWidth = 0;
let editor: EditorTarget | null = null;
let editorEl: HTMLElement | null = null;
let editorHeight = 0;
let editorSaving = false;
/** The thread whose reply box is open, and that box. */
let replyOpen: string | null = null;
let replyEl: HTMLElement | null = null;
let replyHeight = 0;
/** Resolved threads the user expanded. */
const shownResolved = new Set<string>();
/** Lines carrying one of my pending comments: "f|R:12". */
let draftLines = new Set<string>();
/** The pending reply being edited in the open reply box. */
let replyDraft: string | null = null;
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
/** Files folded or unfolded by hand, by path; otherwise a viewed file is folded, as on GitHub. */
const foldOverride = new Map<string, boolean>();
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
    case "editor": return editorHeight;
    case "thread":
    case "draft": return measuredHeight(r);
    default: return lineHeight;
  }
}

function buildRows(): void {
  rows = base = [];
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
  layoutRows();
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

/** A file shows only its header: viewed (unless unfolded by hand), or folded by hand. */
function isFolded(f: number): boolean {
  const path = files[f]?.path;
  if (path === undefined) return false;
  return foldOverride.get(path) ?? (review.enabled && !!review.viewed[path]);
}

/** Re-lays the rows after a file folds or unfolds; a file folded at the top leaves its header there. */
function foldChanged(): void {
  const f = currentFile();
  const delta = f >= 0 ? scroller.scrollTop - offsets[fileStart[f]] : 0;
  relayout();
  if (f >= 0 && fileStart[f] !== undefined) {
    scroller.scrollTop = offsets[fileStart[f]] + (isFolded(f) ? 0 : delta);
    draw();
    reportVisible();
  }
}

function fileHeader(f: number): HTMLElement {
  const file = files[f];
  const folded = isFolded(f);
  const h = el("div", `fh${folded ? " folded" : ""}`);
  h.dataset.f = String(f);
  const fold = el("button", "fold");
  fold.type = "button";
  fold.innerHTML = ICON_CHEVRON;
  fold.setAttribute("aria-expanded", String(!folded));
  fold.setAttribute("aria-label", `${folded ? "Show" : "Hide"} ${file.path}`);
  fold.title = folded ? "Show file" : "Hide file";
  fold.addEventListener("click", (e) => {
    e.stopPropagation();
    foldOverride.set(file.path, !folded);
    foldChanged();
  });
  h.append(fold);
  const shown = file.status === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  h.append(el("span", "path", shown));
  h.querySelector(".path")!.setAttribute("title", shown);
  const risk = labels[file.path];
  if (risk) h.append(riskBadge(risk));
  h.append(risk?.reason ? el("span", "reason", risk.reason) : el("span", "sp"));
  // As on the canvas: zero sides are left out ("+96" for a new file), unless both are zero.
  if (file.additions > 0 || file.deletions === 0) h.append(el("span", "tn add", `+${file.additions}`));
  if (file.deletions > 0) h.append(el("span", "tn del", `−${file.deletions}`));
  if (review.enabled) {
    const isViewed = !!review.viewed[file.path];
    const v = el("button", `viewed${isViewed ? " on" : ""}`);
    v.type = "button";
    v.setAttribute("role", "checkbox");
    v.setAttribute("aria-checked", String(isViewed));
    v.setAttribute("aria-label", `Viewed ${file.path}`);
    const tick = el("span", "tick");
    tick.innerHTML = ICON_CHECK;
    v.append(tick, document.createTextNode("Viewed"));
    v.addEventListener("click", (e) => {
      e.stopPropagation();
      // Folds (or unfolds) at once, as on GitHub; Swift's answer confirms or puts it back.
      review.viewed = { ...review.viewed, [file.path]: !isViewed };
      foldOverride.delete(file.path);
      post({ type: "markViewed", path: file.path, viewed: !isViewed });
      foldChanged();
    });
    h.append(v);
  }
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
    case "thread": return "Review thread";
    case "draft": return "Your pending comment";
    case "editor": return "Comment on the selected lines";
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
  if (num !== null && l.t !== "meta" && hasDraft(rows[i].f, side === "old" ? "LEFT" : "RIGHT", num)) g.append(el("span", "cdot"));
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
      if (l.t !== "meta" && hasDraft(r.f, l.t === "del" ? "LEFT" : "RIGHT", l.t === "del" ? l.o : l.n)) g1.append(el("span", "cdot"));
      if (isPicked(i, null) && l.t !== "meta") {
        e.classList.add("pick");
        if (selection && i === selection.b && !cardOpen && !editor && !dragging) e.append(review.enabled ? selectionBar() : askAffordance());
      }
      wrap.append(e);
      break;
    }
    case "pair": {
      const e = el("div", "sp2");
      e.append(cell(r.l, i, "old"), cell(r.r, i, "new"));
      if (selection && i === selection.b && !cardOpen && !editor && !dragging) {
        // Split view: under the side the lines were selected on (the halves clip, so it hangs off the row).
        const bar = review.enabled ? selectionBar() : askAffordance();
        bar.classList.add(selection.side === "new" ? "on-new" : "on-old");
        e.append(bar);
      }
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
      if (onRight(r)) wrap.classList.add("rs");
      wrap.append(ensureCard());
      break;
    }
    case "editor": {
      wrap.removeAttribute("aria-label");
      if (onRight(r)) wrap.classList.add("rs");
      wrap.append(ensureEditor());
      break;
    }
    case "thread":
    case "draft": {
      wrap.removeAttribute("aria-label");
      if (onRight(r)) wrap.classList.add("rs");
      const node = r.k === "thread" ? threadEl(r.id) : draftEl(r.id);
      if (node) wrap.append(node);
      break;
    }
  }
  return wrap;
}

/**
 * Split view: the card, the editor, threads and pending comments sit under the side they belong to
 * (the new side on the right). Unified view: always the one column.
 */
function onRight(r: Row): boolean {
  if (layout !== "split") return false;
  switch (r.k) {
    case "card": return selection?.side === "new";
    case "editor": return editor?.side === "RIGHT";
    case "thread": return review.threads.find((t) => t.id === r.id)?.side === "RIGHT";
    case "draft": return review.drafts.find((d) => d.id === r.id)?.side === "RIGHT";
    default: return false;
  }
}

function hasDraft(f: number, side: GhSide, line: number | null): boolean {
  return line !== null && draftLines.has(`${f}|${lineKey(side, line)}`);
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
// Writing reviews: threads, pending comments and the comment editor between the diff's rows

const lineKey = (side: GhSide, line: number) => `${side === "LEFT" ? "L" : "R"}:${line}`;

/** The diff rows of each file by "R:12" / "L:7", to hang threads and drafts under. */
function lineIndex(): Map<number, Map<string, Row>> {
  const out = new Map<number, Map<string, Row>>();
  for (const r of base) {
    let m = out.get(r.f);
    if (!m) out.set(r.f, (m = new Map()));
    const put = (k: string) => { if (!m!.has(k)) m!.set(k, r); };
    if (r.k === "file") m.set("file", r);
    else if (r.k === "line") {
      const l = r.ln;
      if (l.t === "meta") continue;
      if (l.t === "del") put(lineKey("LEFT", l.o!));
      else {
        put(lineKey("RIGHT", l.n!));
        if (l.t === "ctx" && l.o !== null) put(lineKey("LEFT", l.o));
      }
    } else if (r.k === "pair") {
      if (r.l && r.l.t !== "meta" && r.l.o !== null) put(lineKey("LEFT", r.l.o));
      if (r.r && r.r.t !== "meta" && r.r.n !== null) put(lineKey("RIGHT", r.r.n));
    }
  }
  return out;
}

/**
 * Builds `rows` from the diff's rows plus, under the lines they belong to: the ask card or the
 * comment editor, GitHub threads, then my pending comments. The selection keeps its rows.
 */
function layoutRows(): void {
  const keepA = selection ? rows[selection.a] : null;
  const keepB = selection ? rows[selection.b] : null;
  const fileOf = new Map(files.map((x, f) => [x.path, f]));
  const index = lineIndex();
  const after = new Map<Row, Row[]>();
  const hang = (r: Row | undefined, extra: Row) => {
    if (!r) return;
    const list = after.get(r);
    if (list) list.push(extra);
    else after.set(r, [extra]);
  };
  for (const t of review.threads) {
    const f = fileOf.get(t.path);
    if (f === undefined) continue;
    const m = index.get(f);
    hang((t.line !== null && m?.get(lineKey(t.side, t.line))) || m?.get("file"), { k: "thread", f, id: t.id });
  }
  draftLines = new Set();
  for (const d of review.drafts) {
    if (!d.path || !d.side || d.line === null) continue;
    const f = fileOf.get(d.path);
    if (f === undefined) continue;
    for (let n = d.startLine ?? d.line; n <= d.line; n++) draftLines.add(`${f}|${lineKey(d.side, n)}`);
    if (editor?.draftId === d.id) continue;
    hang(index.get(f)?.get(lineKey(d.side, d.line)) ?? index.get(f)?.get("file"), { k: "draft", f, id: d.id });
  }
  rows = [];
  const folded = files.map((_, f) => isFolded(f));
  for (const r of base) {
    if (folded[r.f]) {
      if (r.k === "file") rows.push(r);
      continue;
    }
    rows.push(r);
    if (cardOpen && r === keepB) rows.push({ k: "card", f: r.f });
    if (editor && r === editor.after) rows.push({ k: "editor", f: r.f });
    const extra = after.get(r);
    if (extra) rows.push(...extra);
  }
  if (selection) {
    const a = keepA ? rows.indexOf(keepA) : -1;
    const b = keepB ? rows.indexOf(keepB) : -1;
    if (a < 0 || b < 0) selection = null;
    else {
      selection.a = a;
      selection.b = b;
    }
  }
}

/** Re-lays the rows and redraws, keeping the scroll position and the focus in an open text box. */
function relayout(): void {
  const active = document.activeElement as HTMLTextAreaElement | null;
  const typing = active && active.tagName === "TEXTAREA" && (editorEl?.contains(active) || replyEl?.contains(active) || cardEl?.contains(active));
  const caret = typing ? [active!.selectionStart, active!.selectionEnd] : null;
  const top = scroller.scrollTop;
  layoutRows();
  refreshAll();
  scroller.scrollTop = top;
  draw();
  if (typing && active!.isConnected) {
    active!.focus({ preventScroll: true });
    active!.setSelectionRange(caret![0], caret![1]);
  }
}

// Measuring: threads and drafts wrap their text, so their height is measured once per width.

let measureBox: HTMLDivElement | null = null;

function measure(node: HTMLElement, rightSide = false): number {
  if (!measureBox) {
    measureBox = el("div");
    measureBox.style.cssText = "position:absolute;left:0;right:0;top:0;visibility:hidden;pointer-events:none;display:flow-root";
    content.append(measureBox);
  }
  const holder = el("div", rightSide ? "rs" : undefined);
  holder.style.display = "flow-root";
  holder.append(node);
  measureBox.append(holder);
  const h = Math.ceil(holder.getBoundingClientRect().height);
  holder.remove();
  return h;
}

function measuredHeight(r: Row): number {
  if (r.k !== "thread" && r.k !== "draft") return lineHeight;
  const width = content.clientWidth;
  if (width !== measuredWidth) {
    heightCache.clear();
    measuredWidth = width;
  }
  const key = `${r.k}:${r.id}`;
  let h = heightCache.get(key);
  if (h === undefined) {
    // The open reply box is a live element: measure the thread without it and add the box's own height.
    const node = r.k === "thread" ? threadEl(r.id, true) : draftEl(r.id);
    h = node ? measure(node, onRight(r)) : 0;
    if (r.k === "thread" && replyOpen === r.id) h += replyHeight;
    heightCache.set(key, h);
  }
  return h;
}

function avatar(initials: string, color: string): HTMLElement {
  const a = el("span", "av", initials);
  a.style.background = color;
  a.setAttribute("aria-hidden", "true");
  return a;
}

/** Comment text: plain text with `code` spans and line breaks; never HTML. */
function commentBody(text: string): HTMLElement {
  const body = el("div", "cbody");
  text.split(/(`[^`\n]+`)/).forEach((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) body.append(el("code", undefined, part.slice(1, -1)));
    else if (part) body.append(document.createTextNode(part));
  });
  return body;
}

function iconButton(label: string, svg: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "btn ghost sm icon");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = svg;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const ICON_EDIT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
const ICON_DELETE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>';
const ICON_CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const ICON_CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_COMMENT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14v10H10l-4 4v-4H5z"/></svg>';
const ICON_ASK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4l1.7 4.6 4.6 1.7-4.6 1.7L11 16.6 9.3 12 4.7 10.3 9.3 8.6z"/></svg>';
const ICON_COPY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8h11v12H8z"/><path d="M5 16V4h11"/></svg>';

/** One of my pending comments under its lines. */
function draftEl(id: string): HTMLElement | null {
  const d = review.drafts.find((x) => x.id === id);
  if (!d) return null;
  const box = el("div", "thread");
  const range = d.startLine && d.startLine < (d.line ?? 0) ? `lines ${d.startLine}–${d.line}` : `line ${d.line}`;
  box.append(myComment(d, d.outdated ? undefined : `on ${range}`));
  if (d.outdated) box.append(outdatedPart(d, range));
  return box;
}

/** "Outdated · line 85 changed in c3d8e11", the old and new line, then Move or Delete. */
function outdatedPart(d: RDraft, range: string): HTMLElement {
  const o = d.outdated!;
  const part = el("div", "tc outdated");
  const col = el("div", "tbody");
  const head = el("div", "thead");
  head.append(el("span", "otag", "Outdated"), el("span", "l3", `${range} changed in ${o.changedIn}`));
  const lines = el("div", "olines");
  for (const t of o.old) lines.append(el("div", "ol del", `− ${t}`));
  for (const t of o.now) lines.append(el("div", "ol add", `+ ${t}`));
  const actions = el("div", "thead");
  const move = el("button", "btn sm", "Move to new line");
  move.type = "button";
  move.disabled = o.now.length === 0;
  move.title = o.now.length ? "Keep the comment on the same line numbers, on the new commit" : "Those lines are gone";
  move.addEventListener("click", (e) => {
    e.stopPropagation();
    post({ type: "moveOutdated", id: d.id });
  });
  const del = el("button", "btn ghost sm", "Delete");
  del.type = "button";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    post({ type: "deleteDraft", id: d.id });
  });
  actions.append(move, del, el("span", "l3", "It can't be sent until it's moved or deleted"));
  col.append(head, lines, actions);
  part.append(el("span", "avsp"), col);
  return part;
}

/** "You · Pending", edit and delete, then the text. */
function myComment(d: RDraft, where?: string): HTMLElement {
  const tc = el("div", "tc");
  const bodyCol = el("div", "tbody");
  const head = el("div", "thead");
  head.append(el("span", "who", "You"), el("span", "ptag", "Pending"));
  if (where) head.append(el("span", "l3", where));
  if (d.origin === "agent") head.append(el("span", "l3", "· drafted from Quack's answer"));
  if (d.origin === "gap_check") head.append(el("span", "l3", "· from gap check"));
  head.append(el("span", "grow"));
  head.append(
    iconButton("Edit", ICON_EDIT, () => (d.replyTo ? openReply(d.replyTo, d) : openEditorForDraft(d.id))),
    iconButton("Delete", ICON_DELETE, () => post({ type: "deleteDraft", id: d.id })),
  );
  bodyCol.append(head, commentBody(d.body));
  tc.append(avatar(review.me.initials, review.me.color), bodyCol);
  return tc;
}

/** A GitHub thread: its comments, my pending replies, then reply and resolve. `forMeasure` leaves the live reply box out. */
function threadEl(id: string, forMeasure = false): HTMLElement | null {
  const t = review.threads.find((x) => x.id === id);
  if (!t) return null;
  const box = el("div", `thread${t.isResolved ? " resolved" : ""}`);
  box.dataset.thread = t.id;
  if (t.isResolved && !shownResolved.has(t.id)) {
    const line = el("div", "rline");
    line.innerHTML = ICON_CHECK;
    const quote = t.comments.slice(0, 2).map((c) => `${c.author}: "${c.body.split("\n")[0].slice(0, 60)}"`).join(" · ");
    line.append(el("span", "rw", "Resolved"), el("span", "ell grow", quote));
    const show = el("button", "btn ghost sm", "Show");
    show.type = "button";
    show.addEventListener("click", () => {
      shownResolved.add(t.id);
      heightCache.delete(`thread:${t.id}`);
      relayout();
    });
    line.append(show);
    box.append(line);
    return box;
  }
  if (t.isOutdated || t.line === null) {
    const note = el("div", "tnote");
    note.append(el("span", "otag", "Outdated"), el("span", "l3", "on lines that changed since"));
    box.append(note);
  }
  for (const c of t.comments) {
    const tc = el("div", "tc");
    const col = el("div", "tbody");
    const head = el("div", "thead");
    head.append(el("span", "who", c.author), el("span", "l3", c.when));
    col.append(head, commentBody(c.body));
    tc.append(avatar(c.initials, c.color), col);
    box.append(tc);
  }
  for (const d of review.drafts) if (d.replyTo === t.id && !(replyOpen === t.id && replyDraft === d.id)) box.append(myComment(d));
  if (!review.enabled) return box;
  if (replyOpen === t.id) {
    if (!forMeasure && replyEl) box.append(replyEl);
    return box;
  }
  const foot = el("div", "tc foot");
  const col = el("div", "tbody");
  if (t.canReply) {
    const stub = el("button", "box stub", "Reply…");
    stub.type = "button";
    stub.addEventListener("click", () => openReply(t.id));
    col.append(stub);
  }
  const actions = el("div", "thead");
  if (t.canResolve) actions.append(resolveButton(t));
  if (t.isResolved) {
    const hide = el("button", "btn ghost sm", "Hide");
    hide.type = "button";
    hide.addEventListener("click", () => {
      shownResolved.delete(t.id);
      heightCache.delete(`thread:${t.id}`);
      relayout();
    });
    actions.append(hide);
  }
  if (actions.childNodes.length) col.append(actions);
  foot.append(avatar(review.me.initials, review.me.color), col);
  if (col.childNodes.length) box.append(foot);
  return box;
}

function resolveButton(t: RThread): HTMLElement {
  const wrap = el("span", "rbtn");
  const b = el("button", "btn sm", t.isResolved ? "Unresolve" : "Resolve");
  b.type = "button";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    post({ type: "resolveThread", id: t.id, resolved: !t.isResolved });
  });
  wrap.append(b, el("span", "l3", "Happens right away on GitHub"));
  return wrap;
}

// The comment editor (new comment on the selected lines, or editing a pending one)

function ensureEditor(): HTMLElement {
  if (editorEl) return editorEl;
  const box = el("div", "thread editor");
  box.setAttribute("role", "form");
  box.setAttribute("aria-label", "Comment on the selected lines");
  const tc = el("div", "tc");
  const col = el("div", "tbody");
  const head = el("div", "thead");
  const where = el("span", "l3");
  where.id = "ed-where";
  const tag = el("span", "l3", "· Drafted from Quack's answer · edit before adding");
  tag.id = "ed-tag";
  head.append(el("span", "who", "You"), where, tag);
  const ta = el("textarea", "box focus");
  ta.id = "ed-text";
  ta.placeholder = "Leave a comment";
  ta.setAttribute("aria-label", "Comment");
  const bot = el("div", "thead");
  const hint = el("span", "l3 grow", "Markdown · stays on this Mac until you submit");
  hint.id = "ed-hint";
  const redraft = el("button", "btn sm", "Redraft");
  redraft.id = "ed-redraft";
  redraft.type = "button";
  redraft.title = "Uses the agent selected in chat";
  redraft.addEventListener("click", () => post({ type: "redraft" }));
  const cancel = el("button", "btn ghost sm", "Cancel");
  cancel.id = "ed-cancel";
  cancel.type = "button";
  cancel.addEventListener("click", () => closeEditor(true));
  const add = el("button", "btn y sm");
  add.id = "ed-add";
  add.type = "button";
  add.append(document.createTextNode("Add to review "), el("span", "k", "⌘↩"));
  add.addEventListener("click", saveEditor);
  ta.addEventListener("input", () => (add.disabled = editorSaving || !ta.value.trim()));
  bot.append(redraft, hint, cancel, add);
  col.append(head, ta, bot);
  tc.append(avatar(review.me.initials, review.me.color), col);
  box.append(tc);
  for (const type of ["mousedown", "keydown"]) box.addEventListener(type, (e) => e.stopPropagation());
  box.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Escape") {
      ke.preventDefault();
      closeEditor(true);
    } else if (ke.key === "Enter" && (ke.metaKey || ke.ctrlKey)) {
      ke.preventDefault();
      saveEditor();
    }
  });
  editorEl = box;
  return box;
}

function showEditor(target: EditorTarget, text: string): void {
  if (cardOpen) closeCard(false);
  closeReply();
  editor = target;
  editorSaving = false;
  const box = ensureEditor();
  const range = target.startLine < target.line ? `lines ${target.startLine}–${target.line}` : `line ${target.line}`;
  box.querySelector("#ed-where")!.textContent = `on ${range}`;
  const ta = box.querySelector("#ed-text") as HTMLTextAreaElement;
  ta.value = text;
  (box.querySelector("#ed-add") as HTMLButtonElement).disabled = !text.trim();
  box.querySelector("#ed-add")!.firstChild!.textContent = target.draftId ? "Save " : "Add to review ";
  const agent = target.origin === "agent";
  (box.querySelector("#ed-tag") as HTMLElement).hidden = !agent;
  (box.querySelector("#ed-redraft") as HTMLElement).hidden = !agent;
  box.querySelector("#ed-hint")!.textContent = agent ? "Uses the agent selected in chat" : "Markdown · stays on this Mac until you submit";
  box.querySelector("#ed-cancel")!.textContent = agent ? "Discard" : "Cancel";
  editorHeight = measure(box, layout === "split" && target.side === "RIGHT");
  layoutRows();
  refreshAll();
  const at = rows.findIndex((r) => r.k === "editor");
  if (at >= 0) {
    const bottom = offsets[at] + editorHeight;
    if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight + 8;
    if (offsets[at] < scroller.scrollTop) scroller.scrollTop = Math.max(0, offsets[at] - lineHeight * 3);
  }
  draw();
  ta.focus({ preventScroll: true });
}

/** C, or Comment in the selection bar: a new comment on the selected lines. */
function openEditor(): void {
  const pick = currentPick();
  if (!pick || !selection || !review.enabled) return;
  const after = rows[selection.b];
  showEditor({ f: selection.f, path: pick.path, side: pick.side === "old" ? "LEFT" : "RIGHT", startLine: pick.startLine, line: pick.endLine, after }, "");
}

function openEditorForDraft(id: string): void {
  const d = review.drafts.find((x) => x.id === id);
  if (!d || !d.path || !d.side || d.line === null) return;
  const f = files.findIndex((x) => x.path === d.path);
  if (f < 0) return;
  const after = lineIndex().get(f)?.get(lineKey(d.side, d.line)) ?? base[fileStart[f]];
  showEditor({ f, path: d.path, side: d.side, startLine: d.startLine ?? d.line, line: d.line, after, draftId: d.id }, d.body);
}

function closeEditor(refocus: boolean): void {
  if (!editor) return;
  editor = null;
  editorSaving = false;
  editorEl?.remove();
  relayout();
  if (refocus) scroller.focus({ preventScroll: true });
}

function saveEditor(): void {
  const ta = editorEl?.querySelector("#ed-text") as HTMLTextAreaElement | null;
  const body = ta?.value ?? "";
  if (!editor || !body.trim() || editorSaving) return;
  editorSaving = true;
  (editorEl!.querySelector("#ed-add") as HTMLButtonElement).disabled = true;
  const anchor: Record<string, unknown> = { path: editor.path, side: editor.side, line: editor.line };
  if (editor.startLine < editor.line) anchor.startLine = editor.startLine;
  post({ type: "saveDraft", draft: { ...(editor.draftId && { id: editor.draftId }), anchor, body, ...(editor.origin && { origin: editor.origin }) } });
}

/**
 * "Turn into comment": the agent's draft opens in the editor on its lines, to edit before adding.
 * Called again with a new body after Redraft (or `redrafting` while it runs).
 */
function openDraftEditor(p: { anchor: { path: string; side: GhSide; line: number; startLine?: number | null }; body: string; redrafting?: boolean }): void {
  const f = files.findIndex((x) => x.path === p.anchor.path);
  if (f < 0) return;
  const start = p.anchor.startLine ?? p.anchor.line;
  const same = editor && editor.origin === "agent" && editor.path === p.anchor.path && editor.line === p.anchor.line && editor.startLine === start;
  if (!same) {
    const after = lineIndex().get(f)?.get(lineKey(p.anchor.side, p.anchor.line)) ?? base[fileStart[f]];
    selection = null;
    showEditor({ f, path: p.anchor.path, side: p.anchor.side, startLine: start, line: p.anchor.line, after, origin: "agent" }, p.body);
  }
  const box = ensureEditor();
  const ta = box.querySelector("#ed-text") as HTMLTextAreaElement;
  if (same && !p.redrafting) ta.value = p.body;
  ta.disabled = !!p.redrafting;
  const redraft = box.querySelector("#ed-redraft") as HTMLButtonElement;
  redraft.disabled = !!p.redrafting;
  redraft.textContent = p.redrafting ? "Redrafting…" : "Redraft";
  (box.querySelector("#ed-add") as HTMLButtonElement).disabled = !!p.redrafting || !ta.value.trim();
  if (!p.redrafting) ta.focus({ preventScroll: true });
}

// Replying to a thread (the reply goes out with the review)

function ensureReply(): HTMLElement {
  if (replyEl) return replyEl;
  const tc = el("div", "tc foot");
  const col = el("div", "tbody");
  const ta = el("textarea", "box focus");
  ta.id = "rp-text";
  ta.placeholder = "Reply…";
  ta.setAttribute("aria-label", "Reply");
  const bot = el("div", "thead");
  const resolveSlot = el("span");
  resolveSlot.id = "rp-resolve";
  const cancel = el("button", "btn ghost sm", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => closeReply(true));
  const add = el("button", "btn y sm", "Add reply to review");
  add.id = "rp-add";
  add.type = "button";
  add.addEventListener("click", saveReply);
  ta.addEventListener("input", () => (add.disabled = !ta.value.trim()));
  bot.append(resolveSlot, el("span", "grow"), cancel, add);
  col.append(ta, bot);
  tc.append(avatar(review.me.initials, review.me.color), col);
  for (const type of ["mousedown", "keydown"]) tc.addEventListener(type, (e) => e.stopPropagation());
  tc.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Escape") {
      ke.preventDefault();
      closeReply(true);
    } else if (ke.key === "Enter" && (ke.metaKey || ke.ctrlKey)) {
      ke.preventDefault();
      saveReply();
    }
  });
  replyEl = tc;
  return tc;
}

function openReply(threadId: string, draft?: RDraft): void {
  const t = review.threads.find((x) => x.id === threadId);
  if (!t) return;
  if (editor) closeEditor(false);
  if (cardOpen) closeCard(false);
  const previous = replyOpen;
  replyOpen = threadId;
  replyDraft = draft?.id ?? null;
  const box = ensureReply();
  const ta = box.querySelector("#rp-text") as HTMLTextAreaElement;
  ta.value = draft?.body ?? "";
  (box.querySelector("#rp-add") as HTMLButtonElement).disabled = !ta.value.trim();
  box.querySelector("#rp-add")!.textContent = draft ? "Save reply" : "Add reply to review";
  const slot = box.querySelector("#rp-resolve")!;
  slot.replaceChildren(...(t.canResolve ? [resolveButton(t)] : []));
  replyHeight = measure(box);
  if (previous) heightCache.delete(`thread:${previous}`);
  heightCache.delete(`thread:${threadId}`);
  relayout();
  ta.focus({ preventScroll: true });
}

function closeReply(refocus = false): void {
  if (!replyOpen) return;
  const id = replyOpen;
  replyOpen = null;
  replyDraft = null;
  replyEl?.remove();
  heightCache.delete(`thread:${id}`);
  relayout();
  if (refocus) scroller.focus({ preventScroll: true });
}

function saveReply(): void {
  const ta = replyEl?.querySelector("#rp-text") as HTMLTextAreaElement | null;
  const body = ta?.value ?? "";
  if (!replyOpen || !body.trim()) return;
  post({ type: "saveDraft", draft: { ...(replyDraft && { id: replyDraft }), replyTo: replyOpen, body } });
  closeReply(true);
}

// The bar under a selection: Comment (C), Ask agent (⌘↩), Copy

function selectionBar(): HTMLElement {
  const pick = currentPick();
  const bar = el("div", "actbar");
  bar.setAttribute("role", "toolbar");
  const range = pick ? (pick.startLine === pick.endLine ? `Line ${pick.startLine}` : `Lines ${pick.startLine}–${pick.endLine}`) : "";
  bar.setAttribute("aria-label", `Selected ${range.toLowerCase()}`);
  bar.addEventListener("mousedown", (e) => e.stopPropagation());
  const button = (label: string, icon: string, key: string | null, onClick: () => void, on = false) => {
    const b = el("button", `ab${on ? " on" : ""}`);
    b.type = "button";
    b.innerHTML = icon;
    b.append(document.createTextNode(label));
    if (key) b.append(el("span", "kbd", key));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };
  bar.append(el("span", "lbl", range), el("span", "vs"));
  bar.append(button("Comment", ICON_COMMENT, "C", openEditor, true), button("Ask agent", ICON_ASK, "⌘↩", openCard));
  const copy = button("", ICON_COPY, null, () => {
    const p = currentPick();
    if (p) post({ type: "copy", text: selectedLines().map((l) => l.text).join("\n") });
  });
  copy.setAttribute("aria-label", "Copy the selected lines");
  copy.title = "Copy";
  bar.append(el("span", "vs"), copy);
  return bar;
}

/** Applies what Swift sent; only rows that changed are redrawn. */
function setReview(p: ReviewPayload): void {
  const before = JSON.stringify({ ...review, viewed: null });
  const foldedBefore = files.map((_, f) => isFolded(f)).join();
  review = { enabled: !!p.enabled, me: p.me ?? review.me, drafts: p.drafts ?? [], threads: p.threads ?? [], viewed: p.viewed ?? {} };
  if (replyOpen && !review.threads.some((t) => t.id === replyOpen)) closeReply();
  if (editor?.draftId && !review.drafts.some((d) => d.id === editor!.draftId)) closeEditor(false);
  if (files.map((_, f) => isFolded(f)).join() !== foldedBefore) {
    heightCache.clear();
    foldChanged();
    return;
  }
  if (JSON.stringify({ ...review, viewed: null }) === before) {
    // Only viewed ticks changed: the file headers.
    for (const [i, e] of live) if (rows[i].k === "file") { e.remove(); live.delete(i); }
    stickyFile = -1;
    draw();
    return;
  }
  heightCache.clear();
  relayout();
}

/** Swift's answer to saveDraft: close the editor and drop the selection it was for, or let the user try again. */
function draftSaved(ok: boolean): void {
  if (!editor) return;
  if (ok) {
    closeEditor(true);
    clearSelection();
  }
  else {
    editorSaving = false;
    const ta = editorEl?.querySelector("#ed-text") as HTMLTextAreaElement | null;
    (editorEl?.querySelector("#ed-add") as HTMLButtonElement | null)?.toggleAttribute("disabled", !ta?.value.trim());
  }
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
  // The "+": without review writing it asks right away; with it, the bar offers Comment and Ask agent.
  if (ask && pick && !review.enabled) openCard();
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
  if (editor) closeEditor(false);
  closeReply();
  const anchor = scroller.scrollTop;
  layoutRows();
  refreshAll();
  scroller.scrollTop = anchor;
  const at = Math.max(0, rows.findIndex((r) => r.k === "card"));
  // Make sure the card is on screen.
  const bottom = offsets[at] + H_CARD;
  if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight + 8;
  draw();
  (card.querySelector("#ask-text") as HTMLTextAreaElement).focus();
}

function closeCard(refocus: boolean): void {
  if (!cardOpen) return;
  cardOpen = false;
  if (cardEl && cardEl.parentElement) cardEl.remove();
  const anchor = scroller.scrollTop;
  layoutRows();
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
  if (rows.length && measuredWidth && content.clientWidth !== measuredWidth && rows.some((r) => r.k === "thread" || r.k === "draft")) {
    relayout();
    return;
  }
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
    case "c":
      if (!selection || !review.enabled) return;
      openEditor();
      break;
    case "Escape":
      if (cardOpen) closeCard(true);
      else if (editor) closeEditor(true);
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
    editor = null;
    editorEl?.remove();
    replyOpen = null;
    replyEl?.remove();
    heightCache.clear();
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
    heightCache.clear();
    withAnchor(() => {
      selection = null;
      cardOpen = false;
      cardEl?.remove();
      editor = null;
      editorEl?.remove();
      buildRows();
      refreshAll();
    });
  }) as never,
  setFontSize: ((px: number) => {
    fontSize = Math.min(24, Math.max(9, px));
    applyFont();
    heightCache.clear();
    withAnchor(() => refreshAll());
  }) as never,
  setReview: setReview as never,
  openDraftEditor: openDraftEditor as never,
  draftSaved: draftSaved as never,
};

applyFont();
post({ type: "ready" });
