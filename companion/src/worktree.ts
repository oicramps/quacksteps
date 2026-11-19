import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { runGit } from './exec.ts';
import { log } from './log.ts';
import { type Release, acquireRead, acquireWrite, lockState, markDirty, takeDirty } from './rwlock.ts';
import { asCommitSha } from './validate.ts';

export class GitError extends Error {}

async function git(clone: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const res = await runGit(['-C', clone, ...args], { timeoutMs });
  if (res.code !== 0) throw new GitError(`git ${args[0]} failed: ${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return res.stdout.trim();
}

export function prRef(prNumber: number): string {
  return `refs/pr-review/${prNumber}`;
}

/** Fetches `pull/<n>/head` from origin into `refs/pr-review/<n>` and returns the commit SHA. */
export async function fetchPr(clone: string, prNumber: number): Promise<string> {
  await git(clone, ['fetch', '--no-tags', '--quiet', 'origin', `+pull/${prNumber}/head:${prRef(prNumber)}`]);
  return commitId(await git(clone, ['rev-parse', `${prRef(prNumber)}^{commit}`]));
}

export async function hasCommit(clone: string, sha: string): Promise<boolean> {
  const commit = asCommitSha(sha);
  if (!commit) return false;
  const res = await runGit(['-C', clone, 'cat-file', '-e', `${commit}^{commit}`], { timeoutMs: 10_000 });
  return res.code === 0;
}

/** Ensures `sha` exists in the local object store, fetching it from `origin` if missing. */
export async function ensureCommit(clone: string, sha: string): Promise<void> {
  const commit = asCommitSha(sha);
  if (!commit) throw new GitError('refusing to fetch a non-commit id');
  if (await hasCommit(clone, commit)) return;
  await git(clone, ['fetch', '--no-tags', '--quiet', 'origin', commit]);
}

function commitId(sha: string): string {
  const commit = asCommitSha(sha);
  if (!commit) throw new GitError('refusing a non-commit id');
  return commit;
}

export function worktreePath(config: Config, owner: string, repo: string, prNumber: number): string {
  return path.join(config.worktreeRoot, owner.toLowerCase(), repo.toLowerCase(), `pr-${prNumber}`);
}

/** Creates or hard-resets a detached worktree at `sha`. Caller must hold `acquireWrite(dir)`. */
export async function prepareWorktree(clone: string, dir: string, sha: string): Promise<void> {
  const commit = asCommitSha(sha);
  if (!commit) throw new GitError('refusing to check out a non-commit id');
  if (fs.existsSync(path.join(dir, '.git'))) {
    await git(dir, ['reset', '--hard', '--quiet']);
    await git(dir, ['clean', '-ffdxq']);
    await git(dir, ['checkout', '--detach', '--quiet', commit]);
    await unlinkEscapingSymlinks(dir);
    return;
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(clone, ['worktree', 'prune']);
  await git(clone, ['worktree', 'add', '--detach', '--quiet', dir, commit]);
  await unlinkEscapingSymlinks(dir);
}

/**
 * Returns modified or untracked entries in `dir` via `git status --porcelain`.
 * With `ignored`, files matched by .gitignore count too (an agent could write `node_modules/`).
 */
export async function changedFiles(dir: string, opts: { ignored?: boolean } = {}): Promise<string[]> {
  const res = await runGit(['-C', dir, 'status', '--porcelain', ...(opts.ignored ? ['--ignored'] : [])], { timeoutMs: 10_000 });
  return res.code === 0 ? res.stdout.split('\n').filter(Boolean) : [];
}

/** The commit `dir` has checked out, or null when it isn't a worktree. */
export async function worktreeHead(dir: string): Promise<string | null> {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const res = await runGit(['-C', dir, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 });
  return res.code === 0 ? asCommitSha(res.stdout) : null;
}

/**
 * Holds a read lock on `dir` with the tree at `sha`. When `prepare` is set and the tree is elsewhere
 * (or dirty), it is checked out under a write lock first. A writer can slip in between the two
 * locks, so the head is checked again under the read lock and the dance is retried a few times.
 * Without `prepare` (a PR being reviewed), the tree is never moved: a mismatch is an error.
 */
export async function readWorktreeAt(
  clone: string,
  dir: string,
  sha: string,
  signal: AbortSignal,
  opts: { prepare: boolean },
): Promise<Release> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.prepare && ((await worktreeHead(dir)) !== sha || lockState(dir).dirty)) {
      const release = await acquireWrite(dir, signal);
      try {
        takeDirty(dir);
        // prepareWorktree resets and cleans before checking out, which also discards reader changes.
        await prepareWorktree(clone, dir, sha);
      } finally {
        release();
      }
    }
    const release = await acquireRead(dir, signal);
    if ((await worktreeHead(dir)) === sha) return release;
    release();
    if (!opts.prepare) throw new GitError(`the review worktree is not at ${sha.slice(0, 7)}`);
  }
  throw new GitError('the worktree kept moving; try again');
}

/**
 * Ends a read. When the reader left changes, the tree is flagged and a cleanup is queued as a writer,
 * so it runs only after every other reader has finished.
 */
export async function endRead(dir: string, release: Release, baseline: ReadonlySet<string>): Promise<string[]> {
  const changed = (await changedFiles(dir, { ignored: true })).filter((line) => !baseline.has(line));
  if (changed.length) markDirty(dir);
  release();
  if (changed.length) {
    void (async () => {
      const w = await acquireWrite(dir);
      try {
        if (takeDirty(dir)) await discardWorktreeChanges(dir);
      } finally {
        w();
      }
    })().catch((err) => log('worktree cleanup failed', String(err)));
  }
  return changed;
}

/**
 * Deletes tracked symlinks whose target resolves outside `dir`. Git records the
 * link itself, so `git show` stays inside the repo, but an agent reading the
 * worktree would follow it.
 */
export async function unlinkEscapingSymlinks(dir: string): Promise<number> {
  const res = await runGit(['-C', dir, 'ls-files', '-z', '-s'], { timeoutMs: 20_000 });
  if (res.code !== 0) throw new GitError('could not list worktree files');
  const root = path.resolve(dir);
  const realRoot = fs.realpathSync(root);
  let removed = 0;
  for (const entry of res.stdout.split('\0')) {
    if (!entry.startsWith('120000 ')) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const rel = entry.slice(tab + 1);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    let target: string;
    try {
      target = fs.readlinkSync(abs);
    } catch {
      continue;
    }
    const resolved = path.resolve(path.dirname(abs), target);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      // The path text stays inside, but the kernel follows other links on the way (`r -> ../..`, then
      // `x -> r/../secret`). Check where it really ends up; a link that doesn't resolve goes too.
      let real: string | null = null;
      try {
        real = fs.realpathSync(abs);
      } catch {
        real = null;
      }
      if (real && (real === realRoot || real.startsWith(realRoot + path.sep))) continue;
    }
    fs.unlinkSync(abs);
    removed++;
  }
  if (removed) log('removed', removed, 'symlink(s) that pointed outside the worktree');
  return removed;
}

/** Puts a worktree back to a clean checkout, including ignored files an agent wrote. */
export async function discardWorktreeChanges(dir: string): Promise<void> {
  if (!fs.existsSync(path.join(dir, '.git'))) return;
  await runGit(['-C', dir, 'reset', '--hard', '--quiet'], { timeoutMs: 30_000 });
  await runGit(['-C', dir, 'clean', '-ffdxq'], { timeoutMs: 30_000 });
  await unlinkEscapingSymlinks(dir);
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface PrDir {
  owner: string;
  repo: string;
  prNumber: number;
  dir: string;
  mtimeMs: number;
  symlink: boolean;
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function realDirInside(rootReal: string, dir: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  try {
    return isInside(rootReal, fs.realpathSync(dir));
  } catch {
    return false;
  }
}

function retentionLimits(config: Config): { days: number; max: number } {
  const days = Number(config.retentionDays);
  const max = Number(config.maxWorktrees);
  return {
    days: Number.isFinite(days) && days >= 0 ? days : 7,
    max: Number.isFinite(max) && max >= 0 ? Math.floor(max) : 20,
  };
}

/** Lists `pr-<n>` directories under `root`. Symlink owners, repos, and escaping targets are skipped. */
function listPrDirs(root: string): PrDir[] {
  const rootReal = fs.realpathSync(root);
  const found: PrDir[] = [];
  for (const owner of fs.readdirSync(root)) {
    const ownerDir = path.join(root, owner);
    if (!realDirInside(rootReal, ownerDir)) continue;
    for (const repo of fs.readdirSync(ownerDir)) {
      const repoDir = path.join(ownerDir, repo);
      if (!realDirInside(rootReal, repoDir)) continue;
      for (const entry of fs.readdirSync(repoDir)) {
        const match = /^pr-(\d+)$/.exec(entry);
        if (!match) continue;
        const dir = path.join(repoDir, entry);
        if (!isInside(root, dir)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(dir);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) {
          found.push({ owner, repo, prNumber: Number(match[1]), dir, mtimeMs: stat.mtimeMs, symlink: true });
          continue;
        }
        if (!stat.isDirectory()) continue;
        try {
          if (!isInside(rootReal, fs.realpathSync(dir))) continue;
        } catch {
          continue;
        }
        found.push({ owner, repo, prNumber: Number(match[1]), dir, mtimeMs: stat.mtimeMs, symlink: false });
      }
    }
  }
  return found;
}

/**
 * Deletes one `pr-<n>` entry under `root`. A symlink is unlinked and its target
 * is left alone. A directory is removed only when its real path stays inside `root`.
 */
async function removePrDir(root: string, entry: PrDir, clone: string | null): Promise<boolean> {
  if (!isInside(root, entry.dir)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entry.dir);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(entry.dir);
    return true;
  }
  if (!stat.isDirectory()) return false;
  let real: string;
  try {
    real = fs.realpathSync(entry.dir);
  } catch {
    return false;
  }
  if (!isInside(fs.realpathSync(root), real)) return false;
  if (clone) {
    await runGit(['-C', clone, 'worktree', 'remove', '--force', entry.dir]);
    await runGit(['-C', clone, 'update-ref', '-d', prRef(entry.prNumber)]);
  }
  fs.rmSync(entry.dir, { recursive: true, force: true });
  return true;
}

/**
 * Removes one PR's worktree (and its `refs/pr-review/<n>` ref) under `config.worktreeRoot`,
 * with the same containment checks as retention. Caller must hold `acquireWrite(dir)`.
 */
export async function removeWorktree(config: Config, clone: string | null, owner: string, repo: string, prNumber: number): Promise<boolean> {
  const dir = worktreePath(config, owner, repo, prNumber);
  const removed = await removePrDir(config.worktreeRoot, { owner, repo, prNumber, dir, mtimeMs: 0, symlink: false }, clone);
  if (removed && clone) await runGit(['-C', clone, 'worktree', 'prune']);
  return removed;
}

/**
 * Applies `retentionDays` and `maxWorktrees` to `pr-<n>` directories under
 * `config.worktreeRoot` only. Clones, scan roots, and anything outside that
 * directory are not scanned or deleted.
 */
export async function enforceRetention(
  config: Config,
  findCloneFor: (owner: string, repo: string) => Promise<string | null>,
  now = Date.now(),
  /** Worktrees to keep regardless of age or count: PRs being reviewed. Owner and repo arrive lower-cased. */
  keep: (owner: string, repo: string, prNumber: number) => boolean = () => false,
): Promise<string[]> {
  if (!fs.existsSync(config.worktreeRoot)) return [];
  const { days, max } = retentionLimits(config);
  const cutoff = now - days * DAY_MS;
  const entries = listPrDirs(config.worktreeRoot).filter((e) => !keep(e.owner, e.repo, e.prNumber));
  const expired = entries.filter((entry) => entry.mtimeMs < cutoff);
  const fresh = entries.filter((entry) => entry.mtimeMs >= cutoff).sort((a, b) => a.mtimeMs - b.mtimeMs || a.dir.localeCompare(b.dir));
  const over = Math.max(0, fresh.length - max);
  const doomed = [...expired, ...fresh.slice(0, over)];
  const removed: string[] = [];
  const clones = new Map<string, string | null>();
  const pruned = new Set<string>();
  for (const entry of doomed) {
    const key = `${entry.owner}\0${entry.repo}`;
    if (!clones.has(key)) clones.set(key, await findCloneFor(entry.owner, entry.repo));
    const clone = clones.get(key) ?? null;
    // Pruning is a writer: it waits for agent turns on the tree to finish.
    const release = await acquireWrite(entry.dir);
    let removedDir = false;
    try {
      removedDir = await removePrDir(config.worktreeRoot, entry, clone);
    } finally {
      release();
    }
    if (removedDir) {
      removed.push(entry.dir);
      if (clone) pruned.add(clone);
    }
  }
  for (const clone of pruned) await runGit(['-C', clone, 'worktree', 'prune']);
  return removed;
}

/**
 * Worktrees of PRs that closed or merged go one day after closing (tech spec, Worktree policy), sooner
 * than the age-based retention. `closedAt` looks a PR up and returns when it closed (null: still open or
 * unknown); `skip` leaves out PRs known to be open or being reviewed, so they cost no lookup. At most
 * `limit` lookups per run.
 */
export async function removeClosedWorktrees(
  config: Config,
  findCloneFor: (owner: string, repo: string) => Promise<string | null>,
  closedAt: (owner: string, repo: string, prNumber: number) => Promise<string | null>,
  skip: (owner: string, repo: string, prNumber: number) => boolean,
  now = Date.now(),
  limit = 20,
): Promise<string[]> {
  if (!fs.existsSync(config.worktreeRoot)) return [];
  const candidates = listPrDirs(config.worktreeRoot)
    .filter((e) => !skip(e.owner, e.repo, e.prNumber))
    .slice(0, limit);
  const removed: string[] = [];
  for (const entry of candidates) {
    let closed: string | null;
    try {
      closed = await closedAt(entry.owner, entry.repo, entry.prNumber);
    } catch {
      continue; // unknown: try again next run
    }
    if (!closed || now - Date.parse(closed) < DAY_MS) continue;
    const clone = await findCloneFor(entry.owner, entry.repo);
    const release = await acquireWrite(entry.dir);
    try {
      if (await removePrDir(config.worktreeRoot, entry, clone)) {
        removed.push(entry.dir);
        if (clone) await runGit(['-C', clone, 'worktree', 'prune']);
      }
    } finally {
      release();
    }
  }
  return removed;
}
