import type { AgentId, ClosedInfo, FixStep, PrKey, ReviewState, ReviewStep } from '@quack/shared';
import { type Config, loadConfig } from './config.ts';
import type { Db } from './db.ts';
import { log, logPilot } from './log.ts';
import { type CloneSearchResult, cloneNotFound, findCloneWithDiagnostics } from './repo.ts';
import { acquireWrite, takeDirty } from './rwlock.ts';
import { fetchPr, prepareWorktree, removeWorktree, worktreePath } from './worktree.ts';

/**
 * "Start reviewing" (the tech spec's claim): a PR the reviewer committed to gets a warm worktree at a
 * known commit. New commits never move it; the reviewer chooses Update. Owned by the server, so it
 * survives app restarts, and stored in state.db, so it survives server restarts.
 *
 *   start  → preparing (finding_clone → fetching → checking_out) → ready
 *   poll sees a new head → stale ── update → preparing → ready
 *   any step fails → failed ── start/update again retries
 *   stop → no review (the worktree stays for lazy asks unless removed)
 */

/** Git and filesystem operations, injectable so tests don't need a GitHub remote. */
export interface ReviewOps {
  findClone(config: Config, owner: string, repo: string): Promise<CloneSearchResult>;
  fetchHead(clone: string, prNumber: number): Promise<string>;
  checkout(clone: string, dir: string, sha: string): Promise<void>;
  remove(config: Config, clone: string | null, pr: PrKey): Promise<boolean>;
}

export const realOps: ReviewOps = {
  findClone: findCloneWithDiagnostics,
  fetchHead: fetchPr,
  checkout: prepareWorktree,
  remove: (config, clone, pr) => removeWorktree(config, clone, pr.owner, pr.repo, pr.number),
};

export type ReviewListener = (pr: PrKey, review: ReviewState | null) => void;

export interface ReviewingOptions {
  db: Db;
  config?: () => Config;
  ops?: ReviewOps;
  now?: () => Date;
  /** How many commits `head` is ahead of `base` (null: unknown). Defaults to nothing; the server passes GitHub's compare. */
  countCommits?: (pr: PrKey, base: string, head: string) => Promise<number | null>;
  /** Called when a review reaches ready at a new commit; the label runner hooks in here. */
  onReady?: (pr: PrKey, review: ReviewState, settings: { agent?: AgentId; model?: string }) => void;
}

const key = (pr: PrKey) => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();

class StepFailure extends Error {
  readonly fixSteps: FixStep[];
  constructor(message: string, fixSteps: FixStep[] = []) {
    super(message);
    this.fixSteps = fixSteps;
  }
}

export class ReviewingService {
  private readonly db: Db;
  private readonly config: () => Config;
  private readonly ops: ReviewOps;
  private readonly now: () => Date;
  private readonly onReady?: ReviewingOptions['onReady'];
  private readonly countCommits?: ReviewingOptions['countCommits'];
  private readonly listeners = new Set<ReviewListener>();
  /** One operation at a time per PR: start, update and stop are queued, never interleaved. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(opts: ReviewingOptions) {
    this.db = opts.db;
    this.config = opts.config ?? (() => loadConfig());
    this.ops = opts.ops ?? realOps;
    this.now = opts.now ?? (() => new Date());
    this.onReady = opts.onReady;
    this.countCommits = opts.countCommits;
  }

  /** Every review, for retention and the inbox's "Reviewing" filter. */
  all(): { pr: PrKey; review: ReviewState }[] {
    return (this.db.prepare('SELECT owner, repo, number, state FROM reviews').all() as { owner: string; repo: string; number: number; state: string }[]).map(
      (r) => ({ pr: { owner: r.owner, repo: r.repo, number: r.number }, review: JSON.parse(r.state) as ReviewState }),
    );
  }

  get(pr: PrKey): ReviewState | undefined {
    const row = this.db.prepare('SELECT state FROM reviews WHERE owner = ? AND repo = ? AND number = ?').get(pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number) as
      | { state: string }
      | undefined;
    return row ? (JSON.parse(row.state) as ReviewState) : undefined;
  }

  subscribe(listener: ReviewListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-runs preparation for reviews a server restart interrupted. */
  resume(): void {
    for (const { pr, review } of this.all()) {
      if (review.phase === 'preparing') {
        log('review: resuming', key(pr));
        void this.enqueue(pr, () => this.prepare(pr));
      }
    }
  }

  /**
   * Starts reviewing. Returns at once with the `preparing` state; progress follows through listeners.
   * Already reviewing: returns the current state (a failed review is retried).
   */
  start(pr: PrKey, settings: { agent?: AgentId; model?: string } = {}): ReviewState {
    const current = this.get(pr);
    if (current && current.phase !== 'failed') return current;
    const review: ReviewState = {
      startedAt: current?.startedAt ?? this.now().toISOString(),
      headSha: current?.headSha ?? '',
      latestHeadSha: current?.latestHeadSha ?? '',
      worktreePath: worktreePath(this.config(), pr.owner, pr.repo, pr.number),
      phase: 'preparing',
      step: 'finding_clone',
      labels: 'none',
    };
    this.save(pr, review, settings);
    void this.enqueue(pr, () => this.prepare(pr));
    return review;
  }

  /** Moves a stale (or failed) review to the PR's latest head. A ready review is left alone. */
  update(pr: PrKey): ReviewState | null {
    const current = this.get(pr);
    if (!current) return null;
    if (current.phase !== 'stale' && current.phase !== 'failed') return current;
    const review: ReviewState = { ...current, phase: 'preparing', step: 'fetching', error: undefined, fixSteps: undefined };
    this.save(pr, review);
    void this.enqueue(pr, () => this.prepare(pr));
    return review;
  }

  /** Stops reviewing. With `removeWorktree`, the worktree is deleted once no agent is reading it. */
  async stop(pr: PrKey, removeWorktree = false): Promise<void> {
    const had = this.get(pr);
    this.db.prepare('DELETE FROM reviews WHERE owner = ? AND repo = ? AND number = ?').run(pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number);
    if (had) this.publish(pr, null);
    if (!removeWorktree) return;
    await this.enqueue(pr, async () => {
      const config = this.config();
      const dir = worktreePath(config, pr.owner, pr.repo, pr.number);
      const { clone } = await this.ops.findClone(config, pr.owner, pr.repo);
      const release = await acquireWrite(dir);
      try {
        takeDirty(dir);
        await this.ops.remove(config, clone, pr);
      } finally {
        release();
      }
    });
  }

  /**
   * Called with every inbox poll: a new head on a ready review makes it stale. The worktree stays
   * where it is; only Update moves it. Returns true when the PR is being reviewed.
   */
  noteHead(pr: PrKey, headSha: string): boolean {
    const current = this.get(pr);
    if (!current) return false;
    if (current.latestHeadSha === headSha) return true;
    const next: ReviewState = { ...current, latestHeadSha: headSha, newCommits: undefined };
    if (current.phase === 'ready' && current.headSha && current.headSha !== headSha) next.phase = 'stale';
    this.save(pr, next);
    if (next.phase === 'stale') void this.countNewCommits(pr, next.headSha, headSha);
    return true;
  }

  /** "3 new commits": asks GitHub once per new head. Kept only if the review still points at those commits. */
  private async countNewCommits(pr: PrKey, base: string, head: string): Promise<void> {
    if (!this.countCommits) return;
    try {
      const count = await this.countCommits(pr, base, head);
      const current = this.get(pr);
      if (count === null || !current || current.phase !== 'stale' || current.headSha !== base || current.latestHeadSha !== head) return;
      if (current.newCommits !== count) this.save(pr, { ...current, newCommits: count });
    } catch (err) {
      log('review: counting new commits failed', key(pr), (err as Error).message);
    }
  }

  /** Records that the PR was merged or closed, so the PR tab can say so before the review ends. */
  setClosed(pr: PrKey, closed: ClosedInfo): void {
    const current = this.get(pr);
    if (current && JSON.stringify(current.closed) !== JSON.stringify(closed)) this.save(pr, { ...current, closed });
  }

  /** Mirrors the label job's status into the review, so the inbox and PR window show it. */
  setLabels(pr: PrKey, labels: ReviewState['labels']): void {
    const current = this.get(pr);
    if (current && current.labels !== labels) this.save(pr, { ...current, labels });
  }

  /** Waits for every queued operation (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  private enqueue<T>(pr: PrKey, fn: () => Promise<T>): Promise<T> {
    const k = key(pr);
    const previous = this.chains.get(k) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    this.chains.set(k, tail);
    void tail.then(() => {
      if (this.chains.get(k) === tail) this.chains.delete(k);
    });
    return run;
  }

  /** The preparation pipeline. Stops quietly when the review was stopped meanwhile. */
  private async prepare(pr: PrKey): Promise<void> {
    const started = this.now().getTime();
    const config = this.config();
    const dir = worktreePath(config, pr.owner, pr.repo, pr.number);
    const step = (s: ReviewStep): boolean => {
      const current = this.get(pr);
      if (!current || current.phase !== 'preparing') return false;
      if (current.step !== s) this.save(pr, { ...current, step: s });
      return true;
    };
    try {
      if (!step('finding_clone')) return;
      const found = await this.ops.findClone(config, pr.owner, pr.repo);
      if (!found.clone) {
        const { message, fixSteps } = cloneNotFound(config, pr, found.blockedRoots, found.overrideIssue, 'server');
        throw new StepFailure(message, fixSteps);
      }
      const clone = found.clone;

      if (!step('fetching')) return;
      let sha: string;
      try {
        sha = await this.ops.fetchHead(clone, pr.number);
      } catch (err) {
        throw new StepFailure(`Could not fetch PR #${pr.number}: ${(err as Error).message}`, [
          { text: 'Check that git can reach GitHub from your clone', command: `git -C "${clone}" fetch origin` },
        ]);
      }

      if (!step('checking_out')) return;
      // A writer: waits for agent turns reading the old commit, then moves the tree.
      const release = await acquireWrite(dir);
      try {
        if (!this.get(pr)) return; // stopped while waiting
        takeDirty(dir);
        await this.ops.checkout(clone, dir, sha);
      } finally {
        release();
      }

      const current = this.get(pr);
      if (!current || current.phase !== 'preparing') return;
      // The fetch just read the PR's head from GitHub, so it is the latest one known.
      const ready: ReviewState = { ...current, headSha: sha, latestHeadSha: sha, phase: 'ready', step: undefined, error: undefined, fixSteps: undefined, newCommits: undefined };
      this.save(pr, ready);
      log('review ready', key(pr), sha.slice(0, 7), `${this.now().getTime() - started}ms`);
      logPilot('review_ready', { pr: key(pr), ms: this.now().getTime() - started, sha: sha.slice(0, 7), update: current.headSha !== '' });
      this.onReady?.(pr, ready, this.settingsOf(pr));
    } catch (err) {
      const current = this.get(pr);
      if (!current) return;
      const failure = err instanceof StepFailure ? err : new StepFailure((err as Error).message);
      log('review failed', key(pr), failure.message);
      logPilot('review_failed', { pr: key(pr), ms: this.now().getTime() - started });
      this.save(pr, { ...current, phase: 'failed', step: undefined, error: failure.message, ...(failure.fixSteps.length && { fixSteps: failure.fixSteps }) });
    }
  }

  /** The labels agent and model chosen when reviewing started. */
  settingsOf(pr: PrKey): { agent?: AgentId; model?: string } {
    const row = this.db.prepare('SELECT agent, model FROM reviews WHERE owner = ? AND repo = ? AND number = ?').get(pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number) as
      | { agent: string | null; model: string | null }
      | undefined;
    return { ...(row?.agent && { agent: row.agent as AgentId }), ...(row?.model && { model: row.model }) };
  }

  /** Stores and publishes. Keys are lower-cased so `Polarsteps/Web` and `polarsteps/web` are one review. */
  private save(pr: PrKey, review: ReviewState, settings?: { agent?: AgentId; model?: string }): void {
    const args = [pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number, JSON.stringify(review)] as const;
    if (settings) {
      this.db
        .prepare(
          `INSERT INTO reviews (owner, repo, number, state, agent, model) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner, repo, number) DO UPDATE SET state = excluded.state, agent = excluded.agent, model = excluded.model`,
        )
        .run(...args, settings.agent ?? null, settings.model ?? null);
    } else {
      this.db.prepare(`UPDATE reviews SET state = ? WHERE owner = ? AND repo = ? AND number = ?`).run(args[3], args[0], args[1], args[2]);
    }
    this.publish(pr, review);
  }

  private publish(pr: PrKey, review: ReviewState | null): void {
    for (const l of this.listeners) {
      try {
        l(pr, review);
      } catch (err) {
        log('review listener failed', String(err));
      }
    }
  }
}
