import { randomUUID } from 'node:crypto';
import type {
  CommentAnchor,
  DraftComment,
  DraftOrigin,
  PrKey,
  ReviewEvent,
  ReviewThread,
  ReviewThreadsMessage,
  ViewedState,
} from '@quacksteps/shared';
import type { Db } from './db.ts';
import { GhError, type GhRunner, type GraphQLResult, graphql, mutate } from './gh.ts';
import { log } from './log.ts';

/**
 * Writing reviews (socket protocol v3). Drafts live in state.db until a submit posts them as one
 * GitHub review; resolving threads, viewed ticks and "Assign me" go to GitHub right away.
 * Everything here runs for an explicit request from the app. Agents never call into this module.
 */

/** Drafts kept per PR; GitHub's own review UI gets slow well before this. */
export const MAX_DRAFTS_PER_PR = 200;
/** GitHub's limit for a comment or review body. */
export const MAX_BODY = 65_536;

/** A request the app can fix (bad state, nothing to post), as opposed to a GitHub failure. */
export class ReviewWriteError extends Error {
  readonly code: 'bad_request' | 'review_pending_on_github';
  constructor(code: 'bad_request' | 'review_pending_on_github', message: string) {
    super(message);
    this.code = code;
  }
}

const key = (pr: PrKey) => [pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number] as const;

interface DraftRow {
  id: string;
  head_sha: string;
  path: string | null;
  side: string | null;
  line: number | null;
  start_line: number | null;
  reply_to: string | null;
  body: string;
  origin: string;
  created_at: string;
  updated_at: string;
}

export interface NewDraft {
  id?: string;
  headSha: string;
  anchor?: CommentAnchor;
  replyTo?: string;
  body: string;
  origin: DraftOrigin;
}

/** Pending comments, replies and the summary per PR, in state.db. */
export class DraftStore {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  list(pr: PrKey): { comments: DraftComment[]; summary: string; event: ReviewEvent | null } {
    const rows = this.db
      .prepare('SELECT * FROM review_drafts WHERE owner = ? AND repo = ? AND number = ? ORDER BY created_at, rowid')
      .all(...key(pr)) as unknown as DraftRow[];
    const summary = this.db.prepare('SELECT body, event FROM review_summaries WHERE owner = ? AND repo = ? AND number = ?').get(...key(pr)) as
      | { body: string; event: string | null }
      | undefined;
    return { comments: rows.map(toDraft), summary: summary?.body ?? '', event: (summary?.event as ReviewEvent | null) ?? null };
  }

  /** Adds a draft, or replaces the one with `draft.id`. Returns its id. */
  save(pr: PrKey, draft: NewDraft): string {
    if (!!draft.anchor === !!draft.replyTo) throw new ReviewWriteError('bad_request', 'A draft is either a comment on lines or a reply to a thread.');
    if (!draft.body.trim()) throw new ReviewWriteError('bad_request', 'The comment is empty.');
    if (draft.body.length > MAX_BODY) throw new ReviewWriteError('bad_request', 'The comment is too long for GitHub.');
    const at = this.now().toISOString();
    const a = draft.anchor;
    if (draft.id) {
      const changed = this.db
        .prepare(
          `UPDATE review_drafts SET head_sha = ?, path = ?, side = ?, line = ?, start_line = ?, reply_to = ?, body = ?, origin = ?, updated_at = ?
           WHERE id = ? AND owner = ? AND repo = ? AND number = ?`,
        )
        .run(draft.headSha, a?.path ?? null, a?.side ?? null, a?.line ?? null, a?.startLine ?? null, draft.replyTo ?? null, draft.body, draft.origin, at, draft.id, ...key(pr)).changes;
      if (!changed) throw new ReviewWriteError('bad_request', 'That draft no longer exists.');
      return draft.id;
    }
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM review_drafts WHERE owner = ? AND repo = ? AND number = ?').get(...key(pr)) as { n: number }).n;
    if (count >= MAX_DRAFTS_PER_PR) throw new ReviewWriteError('bad_request', `A review can hold ${MAX_DRAFTS_PER_PR} pending comments. Submit some first.`);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO review_drafts (id, owner, repo, number, head_sha, path, side, line, start_line, reply_to, body, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ...key(pr), draft.headSha, a?.path ?? null, a?.side ?? null, a?.line ?? null, a?.startLine ?? null, draft.replyTo ?? null, draft.body, draft.origin, at, at);
    return id;
  }

  delete(pr: PrKey, id: string): void {
    this.db.prepare('DELETE FROM review_drafts WHERE id = ? AND owner = ? AND repo = ? AND number = ?').run(id, ...key(pr));
  }

  saveSummary(pr: PrKey, body: string, event: ReviewEvent | null): void {
    if (body.length > MAX_BODY) throw new ReviewWriteError('bad_request', 'The summary is too long for GitHub.');
    this.db
      .prepare(
        `INSERT INTO review_summaries (owner, repo, number, body, event, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner, repo, number) DO UPDATE SET body = excluded.body, event = excluded.event, updated_at = excluded.updated_at`,
      )
      .run(...key(pr), body, event, this.now().toISOString());
  }

  /** After a successful submit: everything for the PR goes. */
  clear(pr: PrKey): void {
    this.db.prepare('DELETE FROM review_drafts WHERE owner = ? AND repo = ? AND number = ?').run(...key(pr));
    this.db.prepare('DELETE FROM review_summaries WHERE owner = ? AND repo = ? AND number = ?').run(...key(pr));
  }

  /** The pending review a submit started, if it never finished. */
  submission(pr: PrKey): string | null {
    const row = this.db.prepare('SELECT review_id FROM review_submissions WHERE owner = ? AND repo = ? AND number = ?').get(...key(pr)) as
      | { review_id: string }
      | undefined;
    return row?.review_id ?? null;
  }

  setSubmission(pr: PrKey, reviewId: string | null): void {
    if (reviewId === null) {
      this.db.prepare('DELETE FROM review_submissions WHERE owner = ? AND repo = ? AND number = ?').run(...key(pr));
      return;
    }
    this.db
      .prepare(
        `INSERT INTO review_submissions (owner, repo, number, review_id, started_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner, repo, number) DO UPDATE SET review_id = excluded.review_id, started_at = excluded.started_at`,
      )
      .run(...key(pr), reviewId, this.now().toISOString());
  }
}

function toDraft(r: DraftRow): DraftComment {
  const d: DraftComment = { id: r.id, headSha: r.head_sha, body: r.body, origin: r.origin as DraftOrigin, createdAt: r.created_at, updatedAt: r.updated_at };
  if (r.reply_to) d.replyTo = r.reply_to;
  else if (r.path && r.side && r.line) {
    d.anchor = { path: r.path, side: r.side as 'LEFT' | 'RIGHT', line: r.line };
    if (r.start_line) d.anchor.startLine = r.start_line;
  }
  return d;
}

// GitHub responses

interface ContextData {
  viewer: { login: string; id: string };
  repository: {
    pullRequest: {
      id: string;
      headRefOid: string;
      url: string;
      author: { login: string } | null;
      assignees: { nodes: { login: string }[] };
      reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string } | null }[] };
      pending: { nodes: { id: string; author: { login: string } | null }[] };
      submitted: { nodes: { state: string; submittedAt: string | null; author: { login: string } | null; commit: { oid: string } | null }[] };
    } | null;
  } | null;
}

interface ThreadsData {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          path: string;
          line: number | null;
          startLine: number | null;
          originalLine: number | null;
          diffSide: 'LEFT' | 'RIGHT';
          isResolved: boolean;
          isOutdated: boolean;
          viewerCanResolve: boolean;
          viewerCanUnresolve: boolean;
          viewerCanReply: boolean;
          comments: { nodes: { id: string; author: { login: string } | null; body: string; createdAt: string; url: string }[] };
        }[];
      };
    } | null;
  } | null;
}

type ThreadsConnection = NonNullable<NonNullable<ThreadsData['repository']>['pullRequest']>['reviewThreads'];
type FilesConnection = NonNullable<NonNullable<NonNullable<FilesData['repository']>['pullRequest']>['files']>;

interface FilesData {
  repository: {
    pullRequest: { files: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { path: string; viewerViewedState: ViewedState }[] } | null } | null;
  } | null;
}

/** Pages a connection fetches at most: 3,000 files or threads, GitHub's own cap for files. */
const MAX_PAGES = 30;

const same = (a: string | undefined | null, b: string | undefined | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Talks to GitHub for one review at a time. `runner` is swapped for recorded responses in tests. */
export class ReviewWriter {
  private readonly drafts: DraftStore;
  private readonly runner?: GhRunner;
  /** One submit per PR at a time. */
  private readonly submitting = new Set<string>();

  constructor(drafts: DraftStore, runner?: GhRunner) {
    this.drafts = drafts;
    this.runner = runner;
  }

  private vars(pr: PrKey) {
    return { owner: pr.owner, name: pr.repo, number: pr.number };
  }

  private async context(pr: PrKey) {
    const { data } = await graphql<ContextData>('reviewContext', this.vars(pr), this.runner);
    const p = data.repository?.pullRequest;
    if (!p) throw new GhError('repo_not_found', `GitHub has no ${pr.owner}/${pr.repo}#${pr.number}, or this login can't see it.`);
    return { viewer: data.viewer, pr: p };
  }

  /** Threads, viewed files and my last review, as the app shows them. */
  async threads(pr: PrKey): Promise<Omit<ReviewThreadsMessage, 'type' | 'requestId'>> {
    const ctx = await this.context(pr);
    const threads: ReviewThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: GraphQLResult<ThreadsData> = await graphql<ThreadsData>('reviewThreads', { ...this.vars(pr), ...(after && { after }) }, this.runner);
      const conn: ThreadsConnection | undefined = res.data.repository?.pullRequest?.reviewThreads;
      if (!conn) break;
      for (const t of conn.nodes) {
        threads.push({
          id: t.id,
          path: t.path,
          side: t.diffSide,
          line: t.line,
          startLine: t.startLine,
          originalLine: t.originalLine,
          isResolved: t.isResolved,
          isOutdated: t.isOutdated,
          canResolve: t.isResolved ? t.viewerCanUnresolve : t.viewerCanResolve,
          canReply: t.viewerCanReply,
          comments: t.comments.nodes.map((c) => ({ id: c.id, author: c.author?.login ?? 'ghost', body: c.body, createdAt: c.createdAt, url: c.url })),
        });
      }
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    const viewed: Record<string, ViewedState> = {};
    after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: GraphQLResult<FilesData> = await graphql<FilesData>('viewedFiles', { ...this.vars(pr), ...(after && { after }) }, this.runner);
      const conn: FilesConnection | null | undefined = res.data.repository?.pullRequest?.files;
      if (!conn) break;
      for (const f of conn.nodes) viewed[f.path] = f.viewerViewedState;
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    const mine = ctx.pr.submitted.nodes.filter((r) => same(r.author?.login, ctx.viewer.login) && r.commit && r.submittedAt);
    const last = mine.at(-1);
    return {
      pr,
      viewer: ctx.viewer.login,
      headSha: ctx.pr.headRefOid,
      threads,
      viewed,
      assignedToMe: ctx.pr.assignees.nodes.some((a) => same(a.login, ctx.viewer.login)),
      lastReview: last ? { commit: last.commit!.oid, submittedAt: last.submittedAt!, state: last.state as 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' } : null,
    };
  }

  async resolve(pr: PrKey, threadId: string, resolved: boolean): Promise<void> {
    await mutate(resolved ? 'resolveThread' : 'unresolveThread', { thread: threadId }, this.runner);
    log('review write', 'resolve', `${pr.owner}/${pr.repo}#${pr.number}`, resolved ? 'resolved' : 'unresolved');
  }

  async markViewed(pr: PrKey, path: string, viewed: boolean): Promise<void> {
    const ctx = await this.context(pr);
    await mutate(viewed ? 'markViewed' : 'unmarkViewed', { pr: ctx.pr.id, path }, this.runner);
  }

  /** Adds me as assignee, and as a requested reviewer unless I wrote the PR or am already requested. */
  async assignMe(pr: PrKey): Promise<void> {
    const { viewer, pr: p } = await this.context(pr);
    if (!p.assignees.nodes.some((a) => same(a.login, viewer.login))) await mutate('assign', { pr: p.id, users: [viewer.id] }, this.runner);
    const requested = p.reviewRequests.nodes.some((r) => same(r.requestedReviewer?.login, viewer.login));
    if (!same(p.author?.login, viewer.login) && !requested) await mutate('requestReview', { pr: p.id, users: [viewer.id] }, this.runner);
    log('review write', 'assign me', `${pr.owner}/${pr.repo}#${pr.number}`);
  }

  /**
   * Posts every draft and the summary as one review at `headSha`. Built as a pending review, then
   * submitted; if any step fails the pending review is deleted and the drafts stay on this Mac.
   */
  async submit(pr: PrKey, headSha: string, event: ReviewEvent, summary: string): Promise<{ url: string; comments: number; replies: number }> {
    const id = key(pr).join('/');
    if (this.submitting.has(id)) throw new ReviewWriteError('bad_request', 'This review is already being sent.');
    this.submitting.add(id);
    try {
      return await this.submitOnce(pr, headSha, event, summary);
    } finally {
      this.submitting.delete(id);
    }
  }

  private async submitOnce(pr: PrKey, headSha: string, event: ReviewEvent, summary: string) {
    const { comments: drafts } = this.drafts.list(pr);
    const comments = drafts.filter((d) => d.anchor);
    const replies = drafts.filter((d) => d.replyTo);
    const stale = comments.filter((d) => d.headSha !== headSha);
    if (stale.length) {
      throw new ReviewWriteError('bad_request', `${stale.length} pending comment${stale.length === 1 ? ' is' : 's are'} on an older commit. Move or delete ${stale.length === 1 ? 'it' : 'them'} first.`);
    }
    const body = summary.trim();
    if (body.length > MAX_BODY) throw new ReviewWriteError('bad_request', 'The summary is too long for GitHub.');
    if (event === 'REQUEST_CHANGES' && !body) throw new ReviewWriteError('bad_request', 'Requesting changes needs a summary.');
    if (event === 'COMMENT' && !body && drafts.length === 0) throw new ReviewWriteError('bad_request', 'There is nothing to send: add a summary or a comment.');

    const ctx = await this.context(pr);
    // GitHub keeps one pending review per person per PR. One we started and never finished is ours
    // to clean up; any other was started on github.com, and only its owner should decide its fate.
    const leftover = this.drafts.submission(pr);
    for (const p of ctx.pr.pending.nodes.filter((n) => same(n.author?.login, ctx.viewer.login))) {
      if (p.id !== leftover) {
        throw new ReviewWriteError(
          'review_pending_on_github',
          'You have a review in progress on GitHub for this PR. Submit or discard it there, then try again.',
        );
      }
      await mutate('deleteReview', { review: p.id }, this.runner);
    }
    this.drafts.setSubmission(pr, null);

    const started = await mutate<{ addPullRequestReview: { pullRequestReview: { id: string } } }>('startReview', { pr: ctx.pr.id, commit: headSha }, this.runner);
    const reviewId = started.addPullRequestReview.pullRequestReview.id;
    this.drafts.setSubmission(pr, reviewId);
    try {
      for (const c of comments) {
        const a = c.anchor!;
        await mutate(
          'addThread',
          { review: reviewId, path: a.path, body: c.body, line: a.line, side: a.side, ...(a.startLine && a.startLine < a.line && { startLine: a.startLine, startSide: a.side }) },
          this.runner,
        );
      }
      for (const r of replies) await mutate('addReply', { review: reviewId, thread: r.replyTo!, body: r.body }, this.runner);
      const done = await mutate<{ submitPullRequestReview: { pullRequestReview: { url: string } } }>(
        'submitReview',
        { review: reviewId, event, ...(body && { body }) },
        this.runner,
      );
      this.drafts.clear(pr);
      this.drafts.setSubmission(pr, null);
      log('review write', 'submitted', `${pr.owner}/${pr.repo}#${pr.number}`, event, `comments=${comments.length}`, `replies=${replies.length}`);
      return { url: done.submitPullRequestReview.pullRequestReview.url, comments: comments.length, replies: replies.length };
    } catch (err) {
      // Nothing half-posted: drop the pending review. If even that fails, the record stays and the next try cleans up.
      try {
        await mutate('deleteReview', { review: reviewId }, this.runner);
        this.drafts.setSubmission(pr, null);
      } catch (cleanup) {
        log('review write', 'cleanup failed', `${pr.owner}/${pr.repo}#${pr.number}`, String(cleanup));
      }
      log('review write', 'submit failed', `${pr.owner}/${pr.repo}#${pr.number}`, String(err));
      throw err;
    }
  }
}
