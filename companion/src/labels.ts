import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentId, FileRisk, PrKey, RiskLabelsMessage } from '@quack/shared';
import { adapters as defaultAdapters } from './adapters/index.ts';
import type { Adapter } from './adapters/types.ts';
import { type Config, loadConfig } from './config.ts';
import type { Db } from './db.ts';
import { runGit } from './exec.ts';
import { log, logPilot } from './log.ts';
import { resolvePr } from './pr.ts';
import { type CloneSearchResult, findCloneWithDiagnostics } from './repo.ts';
import { asCommitSha } from './validate.ts';
import { changedFiles, endRead, readWorktreeAt, worktreePath } from './worktree.ts';

/**
 * Risk labels for a PR being reviewed: every changed file gets high, medium, low or unlabeled, with a
 * one-line reason, ranked so the riskiest files come first.
 *
 *   1. Rules: lockfiles, snapshots, vendor/, dist/, generated files and pure renames are low, without the agent.
 *   2. Agent: the rest go to the labels agent, read-only in the review worktree, with the title, body,
 *      numstat and as much diff as fits in 40,000 characters, largest files first.
 *   3. Large PRs (over 150 files or 6,000 lines): only the 60 largest files go to the agent.
 *   4. Validate: strict JSON, one repair turn, paths outside the diff dropped, missing files unlabeled.
 *   5. Rank: tier, then changed lines.
 *
 * Results are cached in state.db by (pr, headSha, agent, model, PROMPT_VERSION).
 */

/** Bump when the prompt or the rules change: cached labels from older versions are ignored. */
export const PROMPT_VERSION = 1;
export const DIFF_BUDGET = 40_000;
export const LARGE_FILES = 150;
export const LARGE_LINES = 6_000;
export const LARGE_AGENT_FILES = 60;
export const MAX_JOBS = 2;
export const LABEL_TIMEOUT_MS = 8 * 60_000;
export const REASON_MAX = 90;
const RETENTION_MS = 30 * 24 * 3600_000;

export type LabelsView = Omit<RiskLabelsMessage, 'type' | 'requestId'>;
export type LabelsListener = (pr: PrKey, view: LabelsView) => void;

export interface NumstatEntry {
  path: string;
  /** Set for renames and copies. */
  oldPath?: string;
  added: number;
  deleted: number;
  binary: boolean;
}

// --- pure parts ------------------------------------------------------------------

/** Parses `git diff --numstat -z -M`: `a\td\tpath\0`, or `a\td\t\0old\0new\0` for a rename. */
export function parseNumstat(out: string): NumstatEntry[] {
  const parts = out.split('\0');
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^\n?(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    const binary = m[1] === '-';
    const base = { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary };
    if (m[3] === '') {
      const oldPath = parts[++i];
      const newPath = parts[++i];
      if (oldPath && newPath) entries.push({ path: newPath, oldPath, ...base });
    } else {
      entries.push({ path: m[3], ...base });
    }
  }
  return entries;
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Gemfile.lock',
  'Podfile.lock',
  'Cargo.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'go.sum',
  'Package.resolved',
  'gradle.lockfile',
  'flake.lock',
  'mix.lock',
  'pubspec.lock',
]);

/**
 * The rule that labels a file without the agent, if any. `head` is the start of the file at the PR's
 * head (for the `@generated` marker); null when deleted or unreadable.
 */
export function ruleReason(entry: NumstatEntry, head: string | null): string | null {
  const p = entry.path;
  const name = path.posix.basename(p);
  const segments = p.split('/');
  if (LOCKFILES.has(name)) return 'Lockfile';
  if (segments.includes('__snapshots__') || name.endsWith('.snap')) return 'Snapshot';
  if (segments.slice(0, -1).includes('vendor')) return 'Vendored code';
  if (segments.slice(0, -1).includes('dist')) return 'Build output';
  if (/\.(gen|pb)\./.test(name) || /\.pb$/.test(name)) return 'Generated file';
  if (entry.oldPath && entry.added === 0 && entry.deleted === 0 && !entry.binary) return 'Rename only';
  if (head && /@generated\b/.test(head)) return 'Generated file';
  return null;
}

/** Splits a unified diff into per-file chunks, keyed by the numstat path (the new path for renames). */
export function splitDiff(diff: string, entries: NumstatEntry[]): Map<string, string> {
  const header = new Map(entries.map((e) => [`diff --git a/${e.oldPath ?? e.path} b/${e.path}`, e.path]));
  const chunks = new Map<string, string>();
  const starts = [...diff.matchAll(/^diff --git .*$/gm)];
  starts.forEach((m, i) => {
    const file = header.get(m[0]);
    if (file) chunks.set(file, diff.slice(m.index, starts[i + 1]?.index ?? diff.length));
  });
  return chunks;
}

const lines = (e: NumstatEntry) => e.added + e.deleted;

export interface PromptParts {
  pr: PrKey;
  title: string;
  body: string;
  /** Every changed file, so the agent sees the whole shape of the PR. */
  all: NumstatEntry[];
  /** The files the agent must label. */
  toLabel: NumstatEntry[];
  chunks: Map<string, string>;
}

/** The label prompt. Diffs of the files to label, largest first, within DIFF_BUDGET characters. */
export function buildLabelPrompt(parts: PromptParts): string {
  const numstat = parts.all.map((e) => `${e.binary ? '-\t-' : `${e.added}\t${e.deleted}`}\t${e.oldPath ? `${e.oldPath} => ` : ''}${e.path}`).join('\n');
  let budget = DIFF_BUDGET;
  const diffs: string[] = [];
  const omitted: string[] = [];
  for (const e of [...parts.toLabel].sort((a, b) => lines(b) - lines(a))) {
    const chunk = parts.chunks.get(e.path);
    if (!chunk) {
      omitted.push(e.path);
    } else if (chunk.length <= budget) {
      diffs.push(chunk);
      budget -= chunk.length;
    } else if (budget >= 2_000) {
      diffs.push(`${chunk.slice(0, budget)}\n[diff of ${e.path} truncated]\n`);
      budget = 0;
    } else {
      omitted.push(e.path);
    }
  }
  return [
    `You are ranking the changed files of pull request ${parts.pr.owner}/${parts.pr.repo}#${parts.pr.number} by review risk,`,
    'so a reviewer knows where to look first. The working directory is a read-only checkout of the PR head.',
    'You may open other files to check callers and tests. Do not change any file.',
    '',
    'Risk means: how likely a mistake in this file breaks production, loses data, or opens a security hole,',
    'and how hard such a mistake would be to spot.',
    '- high: auth, permissions, payments, data migrations, concurrency, public API contracts, security-sensitive code,',
    '  or large logic changes with no test changes.',
    '- medium: ordinary logic changes with reasonable test coverage, configuration that changes behaviour.',
    '- low: tests, docs, copy, styling, mechanical refactors, comments, logging.',
    '',
    'Reply with ONLY this JSON, no prose and no code fence:',
    '{"files": [{"path": "<path exactly as listed>", "risk": "high" | "medium" | "low", "reason": "<under 90 characters, plain text>"}]}',
    'Include every file listed under "Files to label", and no others.',
    '',
    `Title: ${parts.title}`,
    '',
    'Description:',
    parts.body.trim() || '(none)',
    '',
    'All changed files (git diff --numstat: added, deleted, path):',
    numstat,
    '',
    'Files to label:',
    ...parts.toLabel.map((e) => `- ${e.path}`),
    '',
    omitted.length ? `No diff included for these files; open them if needed:\n${omitted.map((p) => `- ${p}`).join('\n')}\n` : '',
    'Diff:',
    diffs.join('') || '(none)',
  ].join('\n');
}

export const REPAIR_PROMPT =
  'Your reply was not valid. Reply again with ONLY the JSON object {"files": [{"path", "risk", "reason"}]}, ' +
  'risk one of "high", "medium", "low", covering every file listed under "Files to label". No prose, no code fence.';

export class LabelParseError extends Error {}

/**
 * Validates the agent's reply. Tolerates a code fence or text around the object; everything else is strict.
 * Paths not in `allowed` are dropped. Reasons become one line of at most REASON_MAX characters.
 */
export function parseLabels(text: string, allowed: ReadonlySet<string>): Map<string, { risk: 'high' | 'medium' | 'low'; reason: string }> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new LabelParseError('no JSON object in the reply');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new LabelParseError(`invalid JSON: ${(err as Error).message}`);
  }
  const files = (parsed as { files?: unknown })?.files;
  if (!Array.isArray(files)) throw new LabelParseError('"files" is not an array');
  const out = new Map<string, { risk: 'high' | 'medium' | 'low'; reason: string }>();
  for (const f of files) {
    if (!f || typeof f !== 'object') throw new LabelParseError('a file entry is not an object');
    const { path: p, risk, reason } = f as Record<string, unknown>;
    if (typeof p !== 'string' || typeof reason !== 'string') throw new LabelParseError('path and reason must be strings');
    if (risk !== 'high' && risk !== 'medium' && risk !== 'low') throw new LabelParseError(`unknown risk ${JSON.stringify(risk)}`);
    if (!allowed.has(p)) continue;
    out.set(p, { risk, reason: oneLine(reason) });
  }
  if (allowed.size && !out.size) throw new LabelParseError('no listed file was labeled');
  return out;
}

const oneLine = (s: string) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= REASON_MAX ? flat : `${flat.slice(0, REASON_MAX - 1).trimEnd()}…`;
};

const TIER: Record<FileRisk['risk'], number> = { high: 0, medium: 1, low: 2, unlabeled: 3 };

/** Orders by tier, then changed lines (largest first), then path; `rank` is the final index. */
export function rankFiles(files: (Omit<FileRisk, 'rank'> & { lines: number })[]): FileRisk[] {
  return [...files]
    .sort((a, b) => TIER[a.risk] - TIER[b.risk] || b.lines - a.lines || a.path.localeCompare(b.path))
    .map(({ lines: _lines, ...f }, rank) => ({ ...f, rank }));
}

// --- the runner --------------------------------------------------------------------

/** Git, filesystem and worktree access, injectable for tests. */
export interface LabelOps {
  findClone(config: Config, owner: string, repo: string): Promise<CloneSearchResult>;
  /** Title, body and base commit of the PR at `headSha`. */
  context(clone: string, pr: PrKey, headSha: string): Promise<{ baseSha: string; title: string; body: string }>;
  numstat(clone: string, baseSha: string, headSha: string): Promise<NumstatEntry[]>;
  diff(clone: string, baseSha: string, headSha: string): Promise<string>;
  /** The first bytes of a file in the worktree; null when it doesn't exist. */
  readStart(dir: string, file: string): Promise<string | null>;
  /** Takes a read lock on the review worktree at `sha` (never moving it); resolves to its release. */
  read(clone: string, dir: string, sha: string, signal: AbortSignal): Promise<() => Promise<void>>;
}

const MAX_DIFF_BUFFER = 256 * 1024 * 1024;

async function gitDiff(clone: string, args: string[], baseSha: string, headSha: string): Promise<string> {
  const base = asCommitSha(baseSha);
  const head = asCommitSha(headSha);
  if (!base || !head) throw new Error('refusing to diff a non-commit id');
  const res = await runGit(['-C', clone, 'diff', '--no-color', '--no-ext-diff', '-M', ...args, `${base}...${head}`], { timeoutMs: 60_000, maxBuffer: MAX_DIFF_BUFFER });
  if (res.code !== 0) throw new Error(`git diff failed: ${res.stderr.trim().split('\n')[0]}`);
  return res.stdout;
}

export const realLabelOps: LabelOps = {
  findClone: findCloneWithDiagnostics,
  async context(clone, pr, headSha) {
    const ctx = await resolvePr(clone, { ...pr, headSha });
    return { baseSha: ctx.baseSha, title: ctx.title, body: ctx.body };
  },
  numstat: async (clone, base, head) => parseNumstat(await gitDiff(clone, ['--numstat', '-z'], base, head)),
  diff: (clone, base, head) => gitDiff(clone, [], base, head),
  async readStart(dir, file) {
    const full = path.resolve(dir, file);
    if (!full.startsWith(dir + path.sep)) return null;
    try {
      // Follow links the way the kernel does: only read files that really live in the worktree.
      const [real, realDir] = await Promise.all([fs.realpath(full), fs.realpath(dir)]);
      if (!real.startsWith(realDir + path.sep)) return null;
      const fh = await fs.open(full, 'r');
      try {
        if (!(await fh.stat()).isFile()) return null;
        const buf = Buffer.alloc(2048);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  },
  async read(clone, dir, sha, signal) {
    const release = await readWorktreeAt(clone, dir, sha, signal, { prepare: false });
    const baseline = new Set(await changedFiles(dir, { ignored: true }).catch(() => []));
    return async () => {
      const changed = await endRead(dir, release, baseline);
      if (changed.length) log('labels: agent left', changed.length, 'changed file(s); they will be discarded');
    };
  },
};

export interface LabelSettings {
  agent?: AgentId;
  model?: string;
}

export interface LabelRunnerOptions {
  db: Db;
  config?: () => Config;
  ops?: LabelOps;
  adapters?: Record<AgentId, Adapter>;
  now?: () => Date;
  /** Mirrors the job's status into the review (`ReviewState.labels`). */
  onStatus?: (pr: PrKey, status: 'running' | 'ready' | 'failed') => void;
  timeoutMs?: number;
}

interface Job {
  key: string;
  pr: PrKey;
  headSha: string;
  agent: AgentId;
  model: string;
  controller: AbortController;
  view: LabelsView;
  started: boolean;
}

const prKey = (pr: PrKey) => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();

interface Row {
  head_sha: string;
  agent: string;
  model: string;
  generated_at: string;
  files: string;
}

export class LabelRunner {
  private readonly db: Db;
  private readonly config: () => Config;
  private readonly ops: LabelOps;
  private readonly adapters: Record<AgentId, Adapter>;
  private readonly now: () => Date;
  private readonly onStatus?: LabelRunnerOptions['onStatus'];
  private readonly timeoutMs: number;
  private readonly listeners = new Set<LabelsListener>();
  /** One job per PR, running or queued. */
  private readonly jobs = new Map<string, Job>();
  /** The last failure per PR, so a client subscribing later sees why. */
  private readonly failures = new Map<string, LabelsView>();
  private readonly running = new Set<Promise<void>>();

  constructor(opts: LabelRunnerOptions) {
    this.db = opts.db;
    this.config = opts.config ?? (() => loadConfig());
    this.ops = opts.ops ?? realLabelOps;
    this.adapters = opts.adapters ?? defaultAdapters;
    this.now = opts.now ?? (() => new Date());
    this.onStatus = opts.onStatus;
    this.timeoutMs = opts.timeoutMs ?? LABEL_TIMEOUT_MS;
  }

  subscribe(listener: LabelsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * What a client should show for the PR: the job in progress, else the cached labels at `headSha`
   * (any agent and model, newest first), else the last failure. Without `headSha`, the newest labels.
   */
  get(pr: PrKey, headSha?: string): LabelsView | undefined {
    const k = prKey(pr);
    const job = this.jobs.get(k);
    if (job && (!headSha || job.headSha === headSha)) return job.view;
    const failure = this.failures.get(k);
    if (failure && (!headSha || failure.headSha === headSha)) return failure;
    const row = this.latest(pr, headSha);
    return row ? this.viewOf(pr, row) : undefined;
  }

  /**
   * Labels the PR at `headSha`. Cached results publish at once unless `rerun`. A job already running for
   * the same commit and settings is reused; one for another commit is cancelled.
   */
  run(pr: PrKey, headSha: string, settings: LabelSettings = {}, opts: { rerun?: boolean } = {}): LabelsView {
    const agent = settings.agent ?? 'cursor';
    const model = settings.model ?? '';
    const k = prKey(pr);
    const existing = this.jobs.get(k);
    if (existing && existing.headSha === headSha && existing.agent === agent && existing.model === model && !opts.rerun) return existing.view;

    if (!opts.rerun) {
      const cached = this.cached(pr, headSha, agent, model);
      if (cached) {
        if (existing) this.cancel(pr);
        const view = this.viewOf(pr, cached);
        this.failures.delete(k);
        this.onStatus?.(pr, 'ready');
        this.publish(pr, view);
        return view;
      }
    }
    if (existing) this.cancel(pr);
    this.failures.delete(k);

    const previous = this.latest(pr);
    const job: Job = {
      key: k,
      pr,
      headSha,
      agent,
      model,
      controller: new AbortController(),
      started: false,
      view: {
        pr,
        headSha,
        status: 'running',
        agent,
        model,
        files: previous ? (JSON.parse(previous.files) as FileRisk[]) : [],
        ...(previous && previous.head_sha !== headSha && { previousHeadSha: previous.head_sha }),
      },
    };
    this.jobs.set(k, job);
    this.onStatus?.(pr, 'running');
    this.pump();
    if (!job.started) this.update(job, { queued: true });
    return job.view;
  }

  /** Stops the PR's job (review stopped, or a new commit replaced it). */
  cancel(pr: PrKey): void {
    const job = this.jobs.get(prKey(pr));
    if (!job) return;
    job.controller.abort();
    this.jobs.delete(job.key);
    this.pump();
  }

  /** Deletes labels older than 30 days. */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - RETENTION_MS).toISOString();
    return Number(this.db.prepare('DELETE FROM risk_labels WHERE generated_at < ?').run(cutoff).changes);
  }

  /** Waits for every running job (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  stopAll(): void {
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
  }

  private pump(): void {
    let active = [...this.jobs.values()].filter((j) => j.started).length;
    for (const job of this.jobs.values()) {
      if (active >= MAX_JOBS) break;
      if (job.started) continue;
      job.started = true;
      active++;
      if (job.view.queued) this.update(job, { queued: undefined });
      const p = this.execute(job).finally(() => {
        this.running.delete(p);
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.pump();
      });
      this.running.add(p);
    }
  }

  private async execute(job: Job): Promise<void> {
    const { pr, headSha, agent, model } = job;
    const started = this.now().getTime();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([job.controller.signal, timeout]);
    let release: (() => Promise<void>) | null = null;
    try {
      const config = this.config();
      const { clone } = await this.ops.findClone(config, pr.owner, pr.repo);
      if (!clone) throw new Error(`No local clone of ${pr.owner}/${pr.repo} found.`);
      const dir = worktreePath(config, pr.owner, pr.repo, pr.number);
      release = await this.ops.read(clone, dir, headSha, signal);

      const ctx = await this.ops.context(clone, pr, headSha);
      const all = await this.ops.numstat(clone, ctx.baseSha, headSha);
      const labeled: (Omit<FileRisk, 'rank'> & { lines: number })[] = [];
      const rest: NumstatEntry[] = [];
      for (const e of all) {
        const reason = ruleReason(e, e.added > 0 ? await this.ops.readStart(dir, e.path) : null);
        if (reason) labeled.push({ path: e.path, risk: 'low', reason, source: 'rule', lines: lines(e) });
        else rest.push(e);
      }

      let toLabel = rest;
      const totalLines = all.reduce((n, e) => n + lines(e), 0);
      if (all.length > LARGE_FILES || totalLines > LARGE_LINES) {
        const bySize = [...rest].sort((a, b) => lines(b) - lines(a));
        toLabel = bySize.slice(0, LARGE_AGENT_FILES);
        for (const e of bySize.slice(LARGE_AGENT_FILES)) {
          labeled.push({ path: e.path, risk: 'unlabeled', reason: 'Too big to label. Review by hand', source: 'rule', lines: lines(e) });
        }
      }

      if (toLabel.length) {
        const prompt = buildLabelPrompt({ pr, title: ctx.title, body: ctx.body, all, toLabel, chunks: splitDiff(await this.ops.diff(clone, ctx.baseSha, headSha), all) });
        const result = await this.askAgent(job, dir, prompt, new Set(toLabel.map((e) => e.path)), signal);
        for (const e of toLabel) {
          const got = result.get(e.path);
          labeled.push(
            got
              ? { path: e.path, risk: got.risk, reason: got.reason, source: 'agent', lines: lines(e) }
              : { path: e.path, risk: 'unlabeled', reason: 'Not labeled by the agent. Review by hand', source: 'agent', lines: lines(e) },
          );
        }
      }

      if (signal.aborted) throw signal.reason;
      const files = rankFiles(labeled);
      const generatedAt = this.now().toISOString();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO risk_labels (owner, repo, number, head_sha, agent, model, prompt_version, generated_at, files)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number, headSha, agent, model, PROMPT_VERSION, generatedAt, JSON.stringify(files));
      log('labels ready', job.key, headSha.slice(0, 7), `${files.length} files`, `${agent}${model ? `/${model}` : ''}`, `${this.now().getTime() - started}ms`);
      logPilot('labels_ready', {
        pr: job.key,
        ms: this.now().getTime() - started,
        sha: headSha.slice(0, 7),
        files: files.length,
        agent_files: files.filter((f) => f.source === 'agent').length,
        agent,
        model,
      });
      if (this.jobs.get(job.key) !== job) return;
      this.onStatus?.(pr, 'ready');
      this.update(job, { status: 'ready', generatedAt, files, previousHeadSha: undefined, queued: undefined });
    } catch (err) {
      if (job.controller.signal.aborted || this.jobs.get(job.key) !== job) return; // cancelled: someone else publishes
      const message = timeout.aborted
        ? `Labeling timed out after ${this.timeoutMs / 60_000} minutes.`
        : err instanceof LabelParseError
          ? `The agent's labels could not be read: ${err.message}`
          : (err as Error).message;
      log('labels failed', job.key, message);
      logPilot('labels_failed', { pr: job.key, ms: this.now().getTime() - started, agent, model, timeout: timeout.aborted });
      this.onStatus?.(pr, 'failed');
      const view: LabelsView = { ...job.view, status: 'failed', error: message, queued: undefined };
      this.failures.set(job.key, view);
      this.publish(pr, view);
    } finally {
      await release?.().catch((err: unknown) => log('labels: release failed', String(err)));
    }
  }

  /** One turn, plus one repair turn in the same session when the reply doesn't parse. */
  private async askAgent(job: Job, cwd: string, prompt: string, allowed: Set<string>, signal: AbortSignal) {
    const adapter = this.adapters[job.agent];
    if (!adapter) throw new Error(`Unknown labels agent ${job.agent}.`);
    let sessionId: string | null = null;
    const turn = async (text: string) => {
      let reply = '';
      for await (const ev of adapter.ask({ cwd, prompt: text, model: job.model, sessionId, signal })) {
        if (ev.type === 'text') reply += ev.delta;
        // Same rule as session ids from the socket: it becomes a CLI argument for the repair turn.
        else if (ev.type === 'session' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(ev.sessionId)) sessionId = ev.sessionId;
        else if (ev.type === 'error') throw new Error(`${adapter.label} failed: ${ev.message}`);
      }
      if (signal.aborted) throw signal.reason;
      return reply;
    };
    try {
      const first = await turn(prompt);
      try {
        return parseLabels(first, allowed);
      } catch (err) {
        if (!(err instanceof LabelParseError)) throw err;
        log('labels: reply did not parse, repairing:', err.message);
        return parseLabels(await turn(REPAIR_PROMPT), allowed);
      }
    } finally {
      if (sessionId) adapter.closeSession?.(sessionId);
    }
  }

  private update(job: Job, patch: Partial<LabelsView>): void {
    job.view = { ...job.view, ...patch };
    for (const [k, v] of Object.entries(job.view)) if (v === undefined) delete (job.view as unknown as Record<string, unknown>)[k];
    this.publish(job.pr, job.view);
  }

  private cached(pr: PrKey, headSha: string, agent: AgentId, model: string): Row | undefined {
    return this.db
      .prepare(
        `SELECT head_sha, agent, model, generated_at, files FROM risk_labels
         WHERE owner = ? AND repo = ? AND number = ? AND head_sha = ? AND agent = ? AND model = ? AND prompt_version = ?`,
      )
      .get(pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number, headSha, agent, model, PROMPT_VERSION) as Row | undefined;
  }

  private latest(pr: PrKey, headSha?: string): Row | undefined {
    return this.db
      .prepare(
        `SELECT head_sha, agent, model, generated_at, files FROM risk_labels
         WHERE owner = ? AND repo = ? AND number = ? AND prompt_version = ? AND (? IS NULL OR head_sha = ?)
         ORDER BY generated_at DESC LIMIT 1`,
      )
      .get(pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number, PROMPT_VERSION, headSha ?? null, headSha ?? null) as Row | undefined;
  }

  private viewOf(pr: PrKey, row: Row): LabelsView {
    return { pr, headSha: row.head_sha, status: 'ready', agent: row.agent as AgentId, model: row.model, generatedAt: row.generated_at, files: JSON.parse(row.files) as FileRisk[] };
  }

  private publish(pr: PrKey, view: LabelsView): void {
    for (const l of this.listeners) {
      try {
        l(pr, view);
      } catch (err) {
        log('labels listener failed', String(err));
      }
    }
  }
}
