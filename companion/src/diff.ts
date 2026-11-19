import type { ErrorCode, FixStep, PrDiffFile, PrKey } from '@quack/shared';
import { type Config, loadConfig } from './config.ts';
import { GhError, REST, restGet } from './gh.ts';
import { type NumstatEntry, parseNumstat, splitDiff } from './labels.ts';
import { runGit } from './exec.ts';
import { log } from './log.ts';
import { resolvePr } from './pr.ts';
import { type CloneSearchResult, findCloneWithDiagnostics } from './repo.ts';
import { asCommitSha } from './validate.ts';

/**
 * `pr_diff`: every changed file of a PR with its patch, so the app can show the diff before (or
 * without) a review worktree.
 *
 * - With a local clone: `git diff base...head` at exactly the commit asked for (a reviewed PR's
 *   commit, or an older one). Fast after the first fetch, and no API calls.
 * - Without one: GitHub's PR files endpoint through `gh`, which only knows the PR's latest head.
 *
 * Patches are capped per file and per message; capped files arrive with `truncated` and no patch.
 */

export const MAX_FILE_PATCH = 1_000_000;
export const MAX_TOTAL_PATCH = 8_000_000;
/** Up to 8 MB each, so a small cache. */
const CACHE_ENTRIES = 10;

export interface PrDiff {
  baseSha: string;
  headSha: string;
  files: PrDiffFile[];
  source: 'git' | 'github';
}

export class DiffError extends Error {
  readonly code: ErrorCode;
  readonly fixSteps: FixStep[];
  constructor(code: ErrorCode, message: string, fixSteps: FixStep[] = []) {
    super(message);
    this.code = code;
    this.fixSteps = fixSteps;
  }
}

/** Applies the per-file and per-message patch caps, in file order. */
function capPatches(files: PrDiffFile[]): PrDiffFile[] {
  let left = MAX_TOTAL_PATCH;
  return files.map((f) => {
    if (f.patch === undefined) return f;
    if (f.patch.length > MAX_FILE_PATCH || f.patch.length > left) {
      const { patch: _patch, ...rest } = f;
      return { ...rest, truncated: true };
    }
    left -= f.patch.length;
    return f;
  });
}

/** Builds the file list from `git diff --numstat -z` and the unified diff. Patches start at the first hunk. */
export function filesFromGit(entries: NumstatEntry[], diff: string): PrDiffFile[] {
  const chunks = splitDiff(diff, entries);
  return capPatches(
    entries.map((e) => {
      const chunk = chunks.get(e.path) ?? '';
      const hunk = chunk.indexOf('\n@@');
      const header = hunk >= 0 ? chunk.slice(0, hunk) : chunk;
      const status: PrDiffFile['status'] = /^new file mode/m.test(header)
        ? 'added'
        : /^deleted file mode/m.test(header)
          ? 'deleted'
          : e.oldPath
            ? 'renamed'
            : 'modified';
      const patch = !e.binary && hunk >= 0 ? chunk.slice(hunk + 1) : undefined;
      return {
        path: e.path,
        ...(e.oldPath && { oldPath: e.oldPath }),
        status,
        additions: e.added,
        deletions: e.deleted,
        binary: e.binary,
        ...(patch !== undefined && { patch }),
        // A changed text file whose patch is missing could not be matched to its diff header (an unusual path).
        truncated: !e.binary && patch === undefined && e.added + e.deleted > 0,
      };
    }),
  );
}

/** The fields the REST fallback asks gh to keep, one JSON object per line. */
export const REST_FILES_JQ = '.[] | {filename, previous_filename, status, additions, deletions, patch}';

const REST_STATUS: Record<string, PrDiffFile['status']> = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'added',
  changed: 'modified',
  unchanged: 'modified',
};

/** Parses the REST fallback's JSON lines. GitHub leaves `patch` out for binaries and very large files. */
export function filesFromRest(out: string): PrDiffFile[] {
  const files: PrDiffFile[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const f = JSON.parse(line) as { filename: string; previous_filename?: string | null; status: string; additions: number; deletions: number; patch?: string | null };
    const changes = f.additions + f.deletions;
    const hasPatch = typeof f.patch === 'string';
    files.push({
      path: f.filename,
      ...(f.previous_filename && { oldPath: f.previous_filename }),
      status: REST_STATUS[f.status] ?? 'modified',
      additions: f.additions,
      deletions: f.deletions,
      // GitHub doesn't flag binaries; a file with no patch and no line changes is one (or an empty rename/mode change).
      binary: !hasPatch && changes === 0 && f.status !== 'renamed',
      ...(hasPatch && { patch: f.patch as string }),
      truncated: !hasPatch && changes > 0,
    });
  }
  return capPatches(files);
}

/** Git and gh access, injectable for tests. */
export interface DiffOps {
  findClone(config: Config, owner: string, repo: string): Promise<CloneSearchResult>;
  /** Fetches the PR and resolves its base and head (the latest head when `headSha` is absent). */
  context(clone: string, pr: PrKey, headSha?: string): Promise<{ baseSha: string; headSha: string }>;
  gitDiff(clone: string, args: string[], baseSha: string, headSha: string): Promise<string>;
  rest(path: string, opts: { paginate?: boolean; jq?: string }): Promise<string>;
}

export const realDiffOps: DiffOps = {
  findClone: findCloneWithDiagnostics,
  async context(clone, pr, headSha) {
    const ctx = await resolvePr(clone, { ...pr, ...(headSha && { headSha }) });
    return { baseSha: ctx.baseSha, headSha: ctx.headSha };
  },
  async gitDiff(clone, args, baseSha, headSha) {
    const base = asCommitSha(baseSha);
    const head = asCommitSha(headSha);
    if (!base || !head) throw new Error('refusing to diff a non-commit id');
    const res = await runGit(['-C', clone, 'diff', '--no-color', '--no-ext-diff', '-M', ...args, `${base}...${head}`], { timeoutMs: 60_000, maxBuffer: 256 * 1024 * 1024 });
    if (res.code !== 0) throw new Error(`git diff failed: ${res.stderr.trim().split('\n')[0]}`);
    return res.stdout;
  },
  rest: (path, opts) => restGet(path, opts),
};

const key = (pr: PrKey, headSha: string) => `${pr.owner}/${pr.repo}#${pr.number}@${headSha}`.toLowerCase();

export class DiffService {
  private readonly config: () => Config;
  private readonly ops: DiffOps;
  /** Recent diffs by PR and head commit; a commit's diff never changes. Oldest first. */
  private readonly cache = new Map<string, PrDiff>();

  constructor(opts: { config?: () => Config; ops?: DiffOps } = {}) {
    this.config = opts.config ?? (() => loadConfig());
    this.ops = opts.ops ?? realDiffOps;
  }

  /** The PR's diff at `headSha`, or at its latest head. Throws DiffError with fix steps. */
  async get(pr: PrKey, headSha?: string): Promise<PrDiff> {
    if (headSha) {
      const hit = this.cache.get(key(pr, headSha));
      if (hit) return hit;
    }
    const started = Date.now();
    const { clone } = await this.ops.findClone(this.config(), pr.owner, pr.repo);
    const diff = clone ? await this.viaGit(clone, pr, headSha) : await this.viaGitHub(pr, headSha);
    log('pr diff', key(pr, diff.headSha.slice(0, 7)), diff.source, `${diff.files.length} files`, `${Date.now() - started}ms`);
    this.remember(pr, diff);
    return diff;
  }

  private async viaGit(clone: string, pr: PrKey, headSha?: string): Promise<PrDiff> {
    let ctx: { baseSha: string; headSha: string };
    try {
      ctx = await this.ops.context(clone, pr, headSha);
    } catch (err) {
      throw new DiffError('fetch_failed', `Could not fetch PR #${pr.number}: ${(err as Error).message}`, [
        { text: 'Check that git can reach GitHub from your clone', command: `git -C "${clone}" fetch origin` },
      ]);
    }
    if (headSha && ctx.headSha !== headSha) throw new DiffError('fetch_failed', `Commit ${headSha.slice(0, 7)} is not part of PR #${pr.number} any more.`);
    const [numstat, diff] = await Promise.all([this.ops.gitDiff(clone, ['--numstat', '-z'], ctx.baseSha, ctx.headSha), this.ops.gitDiff(clone, [], ctx.baseSha, ctx.headSha)]);
    return { ...ctx, files: filesFromGit(parseNumstat(numstat), diff), source: 'git' };
  }

  private async viaGitHub(pr: PrKey, headSha?: string): Promise<PrDiff> {
    try {
      const pull = JSON.parse(await this.ops.rest(REST.pull(pr.owner, pr.repo, pr.number), { jq: '{head: .head.sha, base: .base.sha}' })) as { head: string; base: string };
      if (headSha && pull.head !== headSha) {
        throw new DiffError('repo_not_found', `Showing commit ${headSha.slice(0, 7)} needs a local clone of ${pr.owner}/${pr.repo}; GitHub only lists the PR's latest files.`, [
          { text: `Clone ${pr.owner}/${pr.repo} into one of your project folders`, command: `git clone https://github.com/${pr.owner}/${pr.repo}.git` },
        ]);
      }
      const files = filesFromRest(await this.ops.rest(REST.pullFiles(pr.owner, pr.repo, pr.number), { paginate: true, jq: REST_FILES_JQ }));
      return { baseSha: pull.base, headSha: pull.head, files, source: 'github' };
    } catch (err) {
      if (err instanceof DiffError) throw err;
      if (err instanceof GhError) throw new DiffError(err.code, err.message, err.fixSteps);
      throw new DiffError('fetch_failed', `Could not read PR #${pr.number} from GitHub: ${(err as Error).message}`);
    }
  }

  private remember(pr: PrKey, diff: PrDiff): void {
    const k = key(pr, diff.headSha);
    this.cache.delete(k);
    this.cache.set(k, diff);
    while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }
}
