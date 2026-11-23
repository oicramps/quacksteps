import fs from 'node:fs';
import path from 'node:path';
import { LOG_FILE } from './paths.ts';

// stdout carries the native messaging protocol, so diagnostics go to a file.
// Never log prompts, diffs or answers: logs must not contain code.
let file = LOG_FILE;
let ready = false;
let rotate: { maxBytes: number; keep: number } | null = null;
let writes = 0;

/** Points the log at another file (the server logs to server.log), optionally rotated by size. */
export function configureLog(next: string, rotation?: { maxBytes: number; keep: number }): void {
  file = next;
  ready = false;
  rotate = rotation ?? null;
}

function rotateIfNeeded(): void {
  if (!rotate || ++writes % 100 !== 1) return;
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size < rotate.maxBytes) return;
  // server.log -> server.log.1 -> ... -> server.log.<keep-1>; the oldest is dropped.
  for (let i = rotate.keep - 1; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i}`);
  }
}

export function log(...parts: unknown[]): void {
  try {
    if (!ready) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      ready = true;
    }
    rotateIfNeeded();
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {
    // Logging must never break the host.
  }
}

/**
 * One pilot metric per line, easy to grep: `pilot review_ready pr=acme/web#7 ms=3768 sha=9d1d784`.
 * Values with spaces are quoted. The pilot measures Start reviewing → ready, label time and agent, and ask timings.
 */
export function logPilot(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`);
  log('pilot', event, ...kv);
}
