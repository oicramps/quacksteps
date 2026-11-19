import type { Tok } from "./highlight";

export interface DiffFile {
  path: string;
  oldPath?: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch?: string | null;
  truncated: boolean;
}

export interface Risk {
  risk: "high" | "medium" | "low" | "unlabeled";
  reason: string;
  source?: string;
}

export interface Chunk {
  file: number;
  lines: Line[];
  done: boolean;
  queued: boolean;
}

export interface Line {
  t: "ctx" | "add" | "del" | "meta";
  o: number | null;
  n: number | null;
  text: string;
  tok: Tok[] | null;
  chunk: Chunk;
}

export interface Hunk {
  header: string;
  context: string;
  lines: Line[];
}

const CHUNK = 150;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

export function parsePatch(patch: string, file: number): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let chunk: Chunk | null = null;
  let o = 0;
  let n = 0;
  const parts = patch.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  for (const raw of parts) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      hunk = { header: raw.slice(0, raw.indexOf("@@", 2) + 2), context: m[3] ?? "", lines: [] };
      hunks.push(hunk);
      o = Number(m[1]);
      n = Number(m[2]);
      chunk = null;
      continue;
    }
    if (!hunk) continue;
    if (!chunk || chunk.lines.length >= CHUNK) chunk = { file, lines: [], done: false, queued: false };
    const c = raw[0];
    let line: Line;
    if (c === "+") line = { t: "add", o: null, n: n++, text: raw.slice(1), tok: null, chunk };
    else if (c === "-") line = { t: "del", o: o++, n: null, text: raw.slice(1), tok: null, chunk };
    else if (c === "\\") line = { t: "meta", o: null, n: null, text: raw.slice(1).trim(), tok: null, chunk };
    else line = { t: "ctx", o: o++, n: n++, text: raw.slice(1), tok: null, chunk };
    chunk.lines.push(line);
    hunk.lines.push(line);
  }
  return hunks;
}

/** Fills tokens for a chunk: old side for deletions, new side for context and additions. */
export function applyTokens(chunk: Chunk, tokenize: (text: string) => Tok[][] | null): void {
  chunk.done = true;
  const oldSide = chunk.lines.filter((l) => l.t === "ctx" || l.t === "del");
  const newSide = chunk.lines.filter((l) => l.t === "ctx" || l.t === "add");
  const longest = chunk.lines.reduce((a, l) => Math.max(a, l.text.length), 0);
  if (longest > 2000) return;
  const oldTok = oldSide.some((l) => l.t === "del") ? tokenize(oldSide.map((l) => l.text).join("\n")) : null;
  const newTok = tokenize(newSide.map((l) => l.text).join("\n"));
  if (newTok) newSide.forEach((l, i) => (l.tok = newTok[i] ?? null));
  if (oldTok) oldSide.forEach((l, i) => { if (l.t === "del") l.tok = oldTok[i] ?? null; });
}
