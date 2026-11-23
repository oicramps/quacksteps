import type { AuthorState, ClosedInfo, ReviewState, InboxEvent, InboxItem, InboxMessage, PrKey, StackInfo } from '@quacksteps/shared';
import { type Db, getKv, setKv, tx } from './db.ts';
import { GhError, type GhRunner, type GraphQLErrorEntry, MERGE_CHUNK, fixSso, graphql, samlErrors } from './gh.ts';
import { log } from './log.ts';

// ---------------------------------------------------------------------------
// Raw GraphQL shapes (only the fields the queries in gh.ts ask for)
// ---------------------------------------------------------------------------

type Reviewer = { __typename: 'User'; login: string } | { __typename: 'Team'; slug: string } | { __typename: string } | null;

export interface RawPr {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  author: { login: string } | null;
  repository: { nameWithOwner: string; owner?: { __typename: string } | null; defaultBranchRef?: { name: string } | null };
  headRefOid: string;
  headRefName?: string;
  baseRefName: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  commits: { nodes: { commit: { committedDate: string; statusCheckRollup: { state: string } | null } }[] };
  // Reviewer search only
  reviewRequests?: { nodes: { requestedReviewer: Reviewer }[] };
  timelineItems?: {
    nodes: ({ __typename: 'ReviewRequestedEvent'; createdAt: string; requestedReviewer: Reviewer } | { __typename: 'ReadyForReviewEvent'; createdAt: string } | { __typename: string; createdAt?: string })[];
  };
  // Author search only
  reviewThreads?: { totalCount: number; nodes: { isResolved: boolean }[] };
  latestReviews?: { nodes: { state: string; submittedAt: string | null; author: { login: string } | null }[] };
}

export interface RawSearch {
  issueCount: number;
  nodes: (RawPr | Record<string, never>)[];
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface MergeInfo {
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string;
  mergeStateStatus: string;
}

// ---------------------------------------------------------------------------
// Pure derivations (tested against fixtures)
// ---------------------------------------------------------------------------

export const prKeyOf = (pr: RawPr): PrKey => {
  const [owner, repo] = pr.repository.nameWithOwner.split('/');
  return { owner, repo, number: pr.number };
};

export const keyString = (pr: PrKey) => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();

const isPr = (n: RawPr | Record<string, never>): n is RawPr => typeof (n as RawPr).number === 'number' && !!(n as RawPr).repository;

const sameLogin = (a: string | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function ciOf(pr: RawPr): InboxItem['ci'] {
  const state = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  switch (state) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

const newest = (dates: string[]) => dates.reduce<string | null>((best, d) => (best === null || d > best ? d : best), null);

/**
 * When I (or my team) was last asked to review, and whether the ask names me or a team.
 * The clock starts at the newest ReviewRequestedEvent for me, or for the team that requested me;
 * a re-request resets it. Without one: when the PR was marked ready, then when it was created.
 */
export function reviewerInfo(pr: RawPr, viewer: string): NonNullable<InboxItem['reviewer']> {
  const requests = (pr.reviewRequests?.nodes ?? []).map((n) => n.requestedReviewer);
  const events = (pr.timelineItems?.nodes ?? []).filter((e) => e.__typename === 'ReviewRequestedEvent') as {
    createdAt: string;
    requestedReviewer: Reviewer;
  }[];

  const isMe = (r: Reviewer) => r?.__typename === 'User' && sameLogin((r as { login: string }).login, viewer);
  const direct = requests.some(isMe);
  // Search only returns this PR for me if it names me or one of my teams; without a direct ask, it's a team's.
  const team = direct ? undefined : (requests.find((r) => r?.__typename === 'Team') as { slug: string } | undefined)?.slug;

  const relevant = events.filter((e) =>
    direct
      ? isMe(e.requestedReviewer)
      : e.requestedReviewer?.__typename === 'Team' && (!team || (e.requestedReviewer as { slug: string }).slug === team),
  );
  const ready = (pr.timelineItems?.nodes ?? []).filter((e) => e.__typename === 'ReadyForReviewEvent').map((e) => e.createdAt as string);
  const requestedAt = newest(relevant.map((e) => e.createdAt)) ?? newest(ready) ?? pr.createdAt;

  return direct ? { requestedAt, via: 'user' } : { requestedAt, via: 'team', ...(team && { team }) };
}

/**
 * For a PR I'm reviewing whose request is gone (I submitted a review): when I was last asked, from the
 * timeline, so the item keeps a sensible date. Marked `requested: false`, so it never counts as waiting.
 */
export function pastReviewerInfo(pr: RawPr, viewer: string): NonNullable<InboxItem['reviewer']> {
  const events = (pr.timelineItems?.nodes ?? []).filter((e) => e.__typename === 'ReviewRequestedEvent') as { createdAt: string; requestedReviewer: Reviewer }[];
  const mine = events.filter((e) => e.requestedReviewer?.__typename === 'User' && sameLogin((e.requestedReviewer as { login: string }).login, viewer));
  const teams = events.filter((e) => e.requestedReviewer?.__typename === 'Team');
  if (mine.length) return { requestedAt: newest(mine.map((e) => e.createdAt))!, via: 'user', requested: false };
  const team = teams.at(-1)?.requestedReviewer as { slug: string } | undefined;
  return { requestedAt: newest(teams.map((e) => e.createdAt)) ?? pr.createdAt, via: 'team', ...(team && { team: team.slug }), requested: false };
}

/**
 * Other reviewers whose latest review approves the PR. A review request someone else already approved
 * isn't waiting on me: the app shows it below the ones that are, and leaves it out of the menu bar count.
 */
export function approvedByOthers(pr: RawPr, viewer: string): string[] {
  return (pr.latestReviews?.nodes ?? [])
    .filter((r) => r.state === 'APPROVED' && r.author?.login && !sameLogin(r.author.login, viewer))
    .map((r) => r.author!.login);
}

export interface AuthorDerivation {
  state: AuthorState | null;
  reasons: string[];
  /** Best guess at when this state began, used the first time the server sees the PR. */
  estimatedSince: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * My PR's waiting state, in order of precedence:
 * draft (no state) → waiting_on_me → blocked_by_ci → ready_to_merge → waiting_on_reviewers.
 * `merge` is null when GitHub hasn't computed it yet; then the PR is never called ready or conflicting.
 */
export function authorState(pr: RawPr, merge: MergeInfo | null): AuthorDerivation {
  if (pr.isDraft) return { state: null, reasons: [], estimatedSince: pr.updatedAt };

  const changesBy = (pr.latestReviews?.nodes ?? []).filter((r) => r.state === 'CHANGES_REQUESTED');
  const unresolved = (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length;
  const reasons: string[] = [];
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || changesBy.length) {
    const names = [...new Set(changesBy.map((r) => r.author?.login).filter(Boolean))];
    reasons.push(names.length ? `Changes requested by ${names.join(', ')}` : 'Changes requested');
  }
  if (unresolved) reasons.push(plural(unresolved, 'unresolved thread'));
  if (merge?.mergeable === 'CONFLICTING') reasons.push('Merge conflicts');

  if (reasons.length) {
    const lastChangeRequest = newest(changesBy.map((r) => r.submittedAt).filter((d): d is string => !!d));
    return { state: 'waiting_on_me', reasons, estimatedSince: lastChangeRequest ?? pr.updatedAt };
  }
  if (ciOf(pr) === 'failing') {
    return { state: 'blocked_by_ci', reasons: ['Checks failing'], estimatedSince: pr.commits.nodes[0]?.commit.committedDate ?? pr.updatedAt };
  }
  const mergeReady = merge?.mergeStateStatus === 'CLEAN' || merge?.mergeStateStatus === 'HAS_HOOKS';
  const approvalOk = pr.reviewDecision === 'APPROVED' || pr.reviewDecision === null;
  if (mergeReady && approvalOk) return { state: 'ready_to_merge', reasons: [], estimatedSince: pr.updatedAt };
  return { state: 'waiting_on_reviewers', reasons: [], estimatedSince: pr.updatedAt };
}

/** States worth a notification when a PR moves into them. */
const NOTIFY_STATES = new Set<AuthorState | null>(['waiting_on_me', 'blocked_by_ci', 'ready_to_merge']);

/**
 * What changed between two polls. With no previous poll there are no events, so the first run
 * after install doesn't notify about everything already waiting.
 */
export function diffInbox(prev: InboxItem[] | null, next: InboxItem[], reviewing: (pr: PrKey) => boolean = () => false): InboxEvent[] {
  if (prev === null) return [];
  const before = new Map(prev.map((i) => [`${i.role}:${keyString(i.pr)}`, i]));
  const events: InboxEvent[] = [];
  for (const item of next) {
    const old = before.get(`${item.role}:${keyString(item.pr)}`);
    if (item.role === 'reviewer') {
      const requested = item.reviewer?.requested !== false;
      if (requested && (!old || old.reviewer?.requestedAt !== item.reviewer?.requestedAt)) events.push({ kind: 'review_requested', pr: item.pr });
    } else {
      const from = old?.author?.state ?? null;
      const to = item.author?.state ?? null;
      if (old && from !== to && NOTIFY_STATES.has(to)) events.push({ kind: 'state_changed', pr: item.pr, from, to });
    }
    if (item.ci === 'failing' && (!old || old.ci !== 'failing' || old.headSha !== item.headSha)) {
      events.push({ kind: 'ci_failed', pr: item.pr, headSha: item.headSha });
    }
    if (old && old.headSha !== item.headSha && reviewing(item.pr)) events.push({ kind: 'new_commits', pr: item.pr, headSha: item.headSha });
  }
  return events;
}

/** Notification dedupe key: PR, event kind and head SHA (plus the target state for state changes). */
export function eventKey(e: InboxEvent, items: InboxItem[]): string {
  const item = items.find((i) => keyString(i.pr) === keyString(e.pr));
  const head = 'headSha' in e ? e.headSha : (item?.headSha ?? '');
  const extra = e.kind === 'state_changed' ? `:${e.to}` : e.kind === 'review_requested' ? `:${item?.reviewer?.requestedAt ?? ''}` : '';
  return `${e.kind}:${keyString(e.pr)}:${head}${extra}`;
}

/** Review requests longest-waiting first; my PRs by state, drafts last. */
export function sortItems(items: InboxItem[]): InboxItem[] {
  const order: Record<string, number> = { waiting_on_me: 0, blocked_by_ci: 1, ready_to_merge: 2, waiting_on_reviewers: 3, null: 4 };
  // Open requests longest-waiting first, then PRs I already reviewed but am still reviewing here.
  const past = (i: InboxItem) => (i.reviewer!.requested === false ? 1 : 0);
  const reviews = items
    .filter((i) => i.role === 'reviewer')
    .sort((a, b) => past(a) - past(b) || (a.reviewer!.requestedAt < b.reviewer!.requestedAt ? -1 : 1));
  const mine = items
    .filter((i) => i.role === 'author')
    .sort((a, b) => order[String(a.author?.state ?? null)] - order[String(b.author?.state ?? null)] || (a.author!.since < b.author!.since ? -1 : 1));
  return [...reviews, ...mine];
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

/** A PR as far as stacks care: where its branch sits. */
export interface StackNode {
  repo: string; // "owner/repo", lower-cased
  number: number;
  title: string;
  head: string;
  base: string;
}

const nodeKey = (repo: string, number: number) => `${repo}#${number}`;

/**
 * Works out each PR's place in its stack. A PR sits on top of the open PR whose head branch is its base
 * branch. `parents` holds PRs found only to complete a chain (not in the inbox themselves). Stacks branch
 * rarely; when two PRs sit on the same parent, the one listed first continues the chain shown.
 * Returns stack info for every inbox PR in a stack of two or more.
 */
export function computeStacks(inbox: StackNode[], parents: StackNode[] = []): Map<string, StackInfo> {
  const all = [...inbox, ...parents];
  const byHead = new Map<string, StackNode>();
  for (const n of all) if (!byHead.has(`${n.repo}:${n.head}`)) byHead.set(`${n.repo}:${n.head}`, n);
  const parentOf = (n: StackNode) => {
    const p = byHead.get(`${n.repo}:${n.base}`);
    return p && p.number !== n.number ? p : undefined;
  };
  // Children from every known PR (inbox ones first), so a parent fetched by branch links the chain both ways.
  const firstChild = new Map<string, StackNode>();
  for (const n of all) {
    const p = parentOf(n);
    if (p && !firstChild.has(nodeKey(p.repo, p.number))) firstChild.set(nodeKey(p.repo, p.number), n);
  }
  const out = new Map<string, StackInfo>();
  for (const n of inbox) {
    // Walk down to the bottom, then up through the first children to the top (cycles stop the walk).
    const seen = new Set([nodeKey(n.repo, n.number)]);
    let below = 0;
    let parent = parentOf(n);
    const direct = parent;
    while (parent && !seen.has(nodeKey(parent.repo, parent.number))) {
      seen.add(nodeKey(parent.repo, parent.number));
      below++;
      parent = parentOf(parent);
    }
    let above = 0;
    let child = firstChild.get(nodeKey(n.repo, n.number));
    while (child && !seen.has(nodeKey(child.repo, child.number))) {
      seen.add(nodeKey(child.repo, child.number));
      above++;
      child = firstChild.get(nodeKey(child.repo, child.number));
    }
    const size = below + 1 + above;
    if (size < 2) continue;
    out.set(nodeKey(n.repo, n.number), { position: below + 1, size, ...(direct && { parent: { number: direct.number, title: direct.title } }) });
  }
  return out;
}

/** Stacked PRs whose parent isn't in the inbox are looked up, at most this many per poll. */
export const MAX_STACK_LOOKUPS = 15;

// ---------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------

export interface InboxSnapshot {
  fetchedAt: string | null;
  items: InboxItem[];
  more?: { reviewer: number; author: number };
  error?: InboxMessage['error'];
}

export type InboxListener = (snapshot: InboxSnapshot, events: InboxEvent[]) => void;

export interface InboxOptions {
  db: Db;
  runner?: GhRunner;
  now?: () => Date;
  /** Poll interval while at least one client is subscribed. */
  activeMs?: number;
  /** Poll interval with no subscriber, so notifications still arrive. */
  idleMs?: number;
  /** Review lookups: attaches ReviewState to items and enables new_commits events. */
  reviewOf?: (pr: PrKey) => ReviewState | undefined;
  /** Sees every poll's items before events are derived: reviews use it to notice new commits. */
  onPoll?: (items: InboxItem[]) => void;
  /** The org checked for SSO-hidden results. */
  org?: string;
  /** PRs I'm reviewing. Ones the searches miss are looked up one by one, so they stay in the inbox. */
  reviewed?: () => PrKey[];
  /** A PR I'm reviewing was closed or merged. */
  onClosed?: (pr: PrKey, closed: ClosedInfo) => void;
}

/** At most this many reviewed PRs are looked up per poll (one request each). */
export const MAX_REVIEWED_LOOKUPS = 20;

type ReviewedPr = RawPr & { state: 'OPEN' | 'CLOSED' | 'MERGED'; closedAt: string | null; mergedBy?: { login: string } | null };

const REVIEW_QUERY = 'is:open is:pr archived:false review-requested:@me';
const AUTHOR_QUERY = 'is:open is:pr archived:false author:@me';
const RETENTION_MS = 30 * 24 * 3600_000;
const SECONDARY_BACKOFF_START_MS = 2 * 60_000;
const SECONDARY_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Polls GitHub for my review requests and my PRs, derives waiting states, stores a snapshot,
 * and tells subscribers what changed. Owned by the server, so it outlives any connection.
 */
export class InboxService {
  private readonly db: Db;
  private readonly runner?: GhRunner;
  private readonly now: () => Date;
  private activeMs: number;
  private idleMs: number;
  private readonly reviewOf: (pr: PrKey) => ReviewState | undefined;
  private readonly onPoll?: (items: InboxItem[]) => void;
  private readonly reviewed: () => PrKey[];
  private readonly onClosed?: (pr: PrKey, closed: ClosedInfo) => void;
  private readonly org: string;
  private readonly listeners = new Set<InboxListener>();
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: InboxMessage['error'] | undefined;
  private nextPollAt = 0;
  private secondaryBackoffMs = 0;

  constructor(opts: InboxOptions) {
    this.db = opts.db;
    this.runner = opts.runner;
    this.now = opts.now ?? (() => new Date());
    this.activeMs = opts.activeMs ?? 60_000;
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.reviewOf = opts.reviewOf ?? (() => undefined);
    this.onPoll = opts.onPoll;
    this.reviewed = opts.reviewed ?? (() => []);
    this.onClosed = opts.onClosed;
    this.org = opts.org ?? 'polarsteps';
  }

  /** Changes the poll intervals (Settings); the next poll is rescheduled. */
  setIntervals(activeMs: number, idleMs: number): void {
    this.activeMs = activeMs;
    this.idleMs = idleMs;
    if (this.running) this.reschedule();
  }

  /** The tightest GitHub rate limit seen in the last poll. */
  get rateLimit(): RateLimit | null {
    const raw = getKv(this.db, 'inbox.rateLimit');
    return raw ? (JSON.parse(raw) as RateLimit) : null;
  }

  /** Re-sends the stored snapshot (e.g. a review started or stopped) without asking GitHub. */
  republish(): void {
    if (getKv(this.db, 'inbox.fetchedAt')) this.publish([]);
  }

  /** The GitHub login of the last successful poll. */
  get viewer(): string | null {
    return getKv(this.db, 'inbox.viewer');
  }

  /** The stored snapshot, with review state attached fresh. */
  snapshot(): InboxSnapshot {
    const rows = this.db.prepare('SELECT item FROM inbox_items').all() as { item: string }[];
    const items = sortItems(rows.map((r) => JSON.parse(r.item) as InboxItem)).map((i) => {
      const review = this.reviewOf(i.pr);
      return review ? { ...i, review } : i;
    });
    const more = getKv(this.db, 'inbox.more');
    return {
      fetchedAt: getKv(this.db, 'inbox.fetchedAt'),
      items,
      ...(more && { more: JSON.parse(more) }),
      ...(this.lastError && { error: this.lastError }),
    };
  }

  /** Starts the poll loop. The first poll runs right away. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Subscribing makes polling active (every minute); a stale snapshot is refreshed at once. */
  subscribe(listener: InboxListener): () => void {
    this.listeners.add(listener);
    const fetched = getKv(this.db, 'inbox.fetchedAt');
    const stale = !fetched || this.now().getTime() - Date.parse(fetched) >= this.activeMs;
    if (this.running && stale && this.now().getTime() >= this.nextPollAt) void this.refresh();
    else if (this.running) this.reschedule();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Polls now (coalescing with a poll already running) unless a rate limit says to wait. */
  refresh(): Promise<void> {
    this.inFlight ??= this.poll().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextPollAt = Math.max(this.nextPollAt, this.now().getTime() + ms);
    this.timer = setTimeout(() => void this.refresh(), Math.max(0, this.nextPollAt - this.now().getTime()));
    this.timer.unref?.();
  }

  /** After a subscribe/unsubscribe, moves the next poll to the active or idle interval. */
  private reschedule(): void {
    const fetched = getKv(this.db, 'inbox.fetchedAt');
    const interval = this.listeners.size ? this.activeMs : this.idleMs;
    const due = fetched ? Date.parse(fetched) + interval : 0;
    this.nextPollAt = Math.max(due, this.blockedUntil);
    this.schedule(0);
  }

  /** Earliest time a rate limit allows the next poll. */
  private blockedUntil = 0;

  private publish(events: InboxEvent[]): void {
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap, events);
      } catch (err) {
        log('inbox listener failed', String(err));
      }
    }
  }

  private async poll(): Promise<void> {
    const started = this.now();
    if (started.getTime() < this.blockedUntil) {
      this.publish([]);
      this.nextPollAt = this.blockedUntil;
      this.schedule(0);
      return;
    }
    const delay = this.listeners.size ? this.activeMs : this.idleMs;
    try {
      const { events, warning } = await this.fetchAndStore(started);
      // A warning (SSO-hidden PRs) rides along with a successful poll; the items are still current.
      this.lastError = warning;
      this.secondaryBackoffMs = 0;
      this.publish(events);
    } catch (err) {
      const e = err instanceof GhError ? err : new GhError('gh_unavailable', (err as Error).message);
      log('inbox poll failed:', e.code, e.message);
      this.lastError = { code: e.code, message: e.message, ...(e.fixSteps.length && { fixSteps: e.fixSteps }) };
      if (e.code === 'rate_limited') {
        if (e.secondary) {
          this.secondaryBackoffMs = Math.min(SECONDARY_BACKOFF_MAX_MS, this.secondaryBackoffMs ? this.secondaryBackoffMs * 2 : SECONDARY_BACKOFF_START_MS);
          this.blockedUntil = started.getTime() + this.secondaryBackoffMs;
        } else if (e.retryAt) {
          this.blockedUntil = e.retryAt.getTime();
        }
        this.lastError.message = `GitHub asked us to slow down. Next check at ${new Date(Math.max(this.blockedUntil, started.getTime() + delay)).toISOString()}.`;
      }
      this.publish([]);
    }
    this.nextPollAt = 0;
    this.schedule(Math.max(delay, this.blockedUntil - this.now().getTime()));
  }

  /** One poll: three GitHub requests, then derive, diff, dedupe and store. Returns the new events. */
  private async fetchAndStore(started: Date): Promise<{ events: InboxEvent[]; warning?: InboxMessage['error'] }> {
    const [review, mine] = await Promise.all([
      graphql<{ viewer: { login: string }; rateLimit: RateLimit; search: RawSearch }>('inboxReview', { q: REVIEW_QUERY }, this.runner),
      graphql<{ rateLimit: RateLimit; search: RawSearch }>('inboxMine', { q: AUTHOR_QUERY }, this.runner),
    ]);
    const viewer = review.data.viewer.login;
    const reviewPrs = review.data.search.nodes.filter(isPr);
    const minePrs = mine.data.search.nodes.filter(isPr);
    const merges = await this.mergeStates(minePrs.filter((p) => !p.isDraft));

    const nowIso = started.toISOString();
    const items: InboxItem[] = [];
    for (const pr of reviewPrs) {
      const approvedBy = approvedByOthers(pr, viewer);
      items.push({ ...baseItem(pr), role: 'reviewer', reviewer: { ...reviewerInfo(pr, viewer), ...(approvedBy.length && { approvedBy }) } });
    }
    for (const pr of minePrs) {
      const derived = authorState(pr, merges.get(keyString(prKeyOf(pr))) ?? null);
      items.push({ ...baseItem(pr), role: 'author', author: { state: derived.state, since: this.since(pr, derived, nowIso), reasons: derived.reasons } });
    }

    const prev = this.previousItems();
    const lookups = await this.reviewedElsewhere(items, prev, viewer);
    items.push(...lookups.items);
    await this.attachStacks(items, [...reviewPrs, ...minePrs, ...lookups.raw]);

    try {
      this.onPoll?.(items);
    } catch (err) {
      log('inbox onPoll failed', String(err));
    }
    const sso = samlErrors([...review.errors, ...mine.errors, ...lookups.errors]);
    const events = this.dedupe(diffInbox(prev, items, (pr) => !!this.reviewOf(pr)), items, nowIso);

    tx(this.db, () => {
      this.db.exec('DELETE FROM inbox_items');
      const insert = this.db.prepare('INSERT INTO inbox_items (role, owner, repo, number, item) VALUES (?, ?, ?, ?, ?)');
      for (const i of items) insert.run(i.role, i.pr.owner, i.pr.repo, i.pr.number, JSON.stringify(i));
      setKv(this.db, 'inbox.fetchedAt', nowIso);
      setKv(this.db, 'inbox.viewer', viewer);
      setKv(this.db, 'inbox.polled', '1');
      setKv(
        this.db,
        'inbox.more',
        JSON.stringify({
          reviewer: Math.max(0, review.data.search.issueCount - reviewPrs.length),
          author: Math.max(0, mine.data.search.issueCount - minePrs.length),
        }),
      );
      const cutoff = new Date(started.getTime() - RETENTION_MS).toISOString();
      this.db.prepare('DELETE FROM state_history WHERE last_seen < ?').run(cutoff);
      this.db.prepare('DELETE FROM notifications_sent WHERE sent_at < ?').run(cutoff);
    });

    this.applyRateLimit([review.data.rateLimit, mine.data.rateLimit]);
    log('inbox polled', `${reviewPrs.length} review, ${minePrs.length} mine, ${lookups.items.length} reviewed elsewhere, ${events.length} event(s)`, `${this.now().getTime() - started.getTime()}ms`);
    return { events, ...(sso.length && { warning: ssoWarning(this.org, sso) }) };
  }

  /**
   * PRs I'm reviewing that neither search returned: usually because I submitted a review, so GitHub no
   * longer lists me as requested. Open ones stay as `requested: false` reviewer items; closed and merged
   * ones are reported through `onClosed`. A failed lookup keeps the previous poll's item.
   */
  private async reviewedElsewhere(items: InboxItem[], prev: InboxItem[] | null, viewer: string): Promise<{ items: InboxItem[]; raw: RawPr[]; errors: GraphQLErrorEntry[] }> {
    const seen = new Set(items.map((i) => keyString(i.pr)));
    const missing = this.reviewed()
      .filter((pr) => !seen.has(keyString(pr)))
      .slice(0, MAX_REVIEWED_LOOKUPS);
    const out: InboxItem[] = [];
    const raw: RawPr[] = [];
    const errors: GraphQLErrorEntry[] = [];
    await Promise.all(
      missing.map(async (pr) => {
        let found: ReviewedPr | null;
        try {
          const res = await graphql<{ repository: { pullRequest: ReviewedPr | null } | null }>('reviewedPr', { owner: pr.owner, name: pr.repo, number: pr.number }, this.runner);
          errors.push(...res.errors);
          found = res.data.repository?.pullRequest ?? null;
        } catch (err) {
          log('inbox: lookup of reviewed PR failed', keyString(pr), (err as Error).message);
          const kept = prev?.find((i) => i.role === 'reviewer' && keyString(i.pr) === keyString(pr));
          if (kept) out.push(kept);
          return;
        }
        if (!found) {
          log('inbox: reviewed PR not found (deleted, or no access)', keyString(pr));
        } else if (found.state === 'OPEN') {
          out.push({ ...baseItem(found), role: 'reviewer', reviewer: pastReviewerInfo(found, viewer) });
          raw.push(found);
        } else {
          try {
            this.onClosed?.(prKeyOf(found), {
              state: found.state === 'MERGED' ? 'merged' : 'closed',
              at: found.closedAt ?? this.now().toISOString(),
              ...(found.mergedBy?.login && { by: found.mergedBy.login }),
            });
          } catch (err) {
            log('inbox onClosed failed', String(err));
          }
        }
      }),
    );
    return { items: out, raw, errors };
  }

  /**
   * Marks stacked PRs. Parents already in the inbox cost nothing; other parents are looked up by branch
   * (a few per poll). A failed lookup just leaves that chain shorter.
   */
  private async attachStacks(items: InboxItem[], raw: RawPr[]): Promise<void> {
    const nodes: StackNode[] = [];
    const seen = new Set<string>();
    for (const pr of raw) {
      const key = keyString(prKeyOf(pr));
      if (seen.has(key) || !pr.headRefName) continue;
      seen.add(key);
      nodes.push({ repo: pr.repository.nameWithOwner.toLowerCase(), number: pr.number, title: pr.title, head: pr.headRefName, base: pr.baseRefName });
    }
    const defaults = new Map(raw.map((pr) => [pr.repository.nameWithOwner.toLowerCase(), pr.repository.defaultBranchRef?.name]));
    const heads = new Set(nodes.map((n) => `${n.repo}:${n.head}`));
    const parents: StackNode[] = [];
    // Walk up: each round looks up the parents still missing, up to the cap.
    let wanted = nodes.filter((n) => n.base !== defaults.get(n.repo) && !heads.has(`${n.repo}:${n.base}`));
    let budget = MAX_STACK_LOOKUPS;
    while (wanted.length && budget > 0) {
      const batch = wanted.slice(0, budget);
      budget -= batch.length;
      const found = await Promise.all(
        batch.map(async (n) => {
          const [owner, name] = n.repo.split('/');
          try {
            const res = await graphql<{ repository: { pullRequests: { nodes: { number: number; title: string; headRefName: string; baseRefName: string }[] } } | null }>(
              'stackParent',
              { owner, name, head: n.base },
              this.runner,
            );
            const p = res.data.repository?.pullRequests.nodes[0];
            return p ? { repo: n.repo, number: p.number, title: p.title, head: p.headRefName, base: p.baseRefName } : null;
          } catch (err) {
            log('inbox: stack parent lookup failed', n.repo, (err as Error).message);
            return null;
          }
        }),
      );
      const next: StackNode[] = [];
      for (const p of found) {
        if (!p || heads.has(`${p.repo}:${p.head}`)) continue;
        heads.add(`${p.repo}:${p.head}`);
        parents.push(p);
        if (p.base !== defaults.get(p.repo) && !heads.has(`${p.repo}:${p.base}`)) next.push(p);
      }
      wanted = next;
    }
    const stacks = computeStacks(nodes, parents);
    for (const item of items) {
      const stack = stacks.get(`${item.pr.owner}/${item.pr.repo}`.toLowerCase() + `#${item.pr.number}`);
      if (stack) item.stack = stack;
      else delete item.stack;
    }
  }

  /** Below 10% of the hourly budget, wait for the reset instead of polling. */
  private applyRateLimit(limits: RateLimit[]): void {
    const tightest = limits.filter(Boolean).sort((a, b) => a.remaining - b.remaining)[0];
    if (tightest) setKv(this.db, 'inbox.rateLimit', JSON.stringify(tightest));
    const tight = limits.filter((l) => l && l.remaining < l.limit * 0.1);
    if (tight.length) {
      this.blockedUntil = Math.max(...tight.map((l) => Date.parse(l.resetAt)));
      log('inbox: rate limit low, next poll at', new Date(this.blockedUntil).toISOString());
    }
  }

  /** Merge state for my non-draft PRs, in parallel chunks. Failures and UNKNOWN fall back to the last known value at the same head. */
  private async mergeStates(prs: RawPr[]): Promise<Map<string, MergeInfo>> {
    const out = new Map<string, MergeInfo>();
    const chunks: RawPr[][] = [];
    for (let i = 0; i < prs.length; i += MERGE_CHUNK) chunks.push(prs.slice(i, i + MERGE_CHUNK));
    const results = await Promise.all(
      chunks.map((chunk) =>
        graphql<{ nodes: ({ id: string } & MergeInfo)[] }>('mergeState', { ids: chunk.map((p) => p.id) }, this.runner).catch((err: unknown) => {
          log('merge state chunk failed:', (err as Error).message);
          return null;
        }),
      ),
    );
    const byId = new Map(prs.map((p) => [p.id, p]));
    const save = this.db.prepare(
      `INSERT INTO merge_state (owner, repo, number, mergeable, merge_state_status, head_sha) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner, repo, number) DO UPDATE SET mergeable = excluded.mergeable, merge_state_status = excluded.merge_state_status, head_sha = excluded.head_sha`,
    );
    for (const res of results) {
      for (const node of res?.data.nodes ?? []) {
        const pr = node && byId.get(node.id);
        if (!pr || node.mergeable === 'UNKNOWN') continue;
        const key = prKeyOf(pr);
        out.set(keyString(key), { mergeable: node.mergeable, mergeStateStatus: node.mergeStateStatus });
        save.run(key.owner, key.repo, key.number, node.mergeable, node.mergeStateStatus, pr.headRefOid);
      }
    }
    const load = this.db.prepare('SELECT mergeable, merge_state_status, head_sha FROM merge_state WHERE owner = ? AND repo = ? AND number = ?');
    for (const pr of prs) {
      const key = prKeyOf(pr);
      if (out.has(keyString(key))) continue;
      const row = load.get(key.owner, key.repo, key.number) as { mergeable: string; merge_state_status: string; head_sha: string } | undefined;
      if (row && row.head_sha === pr.headRefOid) out.set(keyString(key), { mergeable: row.mergeable, mergeStateStatus: row.merge_state_status });
    }
    return out;
  }

  /** When the current state began: unchanged state keeps its start; a new state starts now; a first sighting is estimated. */
  private since(pr: RawPr, derived: AuthorDerivation, nowIso: string): string {
    const key = prKeyOf(pr);
    const row = this.db.prepare('SELECT state, since FROM state_history WHERE owner = ? AND repo = ? AND number = ?').get(key.owner, key.repo, key.number) as
      | { state: string | null; since: string }
      | undefined;
    const since = !row ? derived.estimatedSince : row.state === derived.state ? row.since : nowIso;
    this.db
      .prepare(
        `INSERT INTO state_history (owner, repo, number, state, since, last_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, repo, number) DO UPDATE SET state = excluded.state, since = excluded.since, last_seen = excluded.last_seen`,
      )
      .run(key.owner, key.repo, key.number, derived.state, since, nowIso);
    return since;
  }

  private previousItems(): InboxItem[] | null {
    if (!getKv(this.db, 'inbox.polled')) return null;
    return (this.db.prepare('SELECT item FROM inbox_items').all() as { item: string }[]).map((r) => JSON.parse(r.item));
  }

  /** Drops events already sent (across restarts) and records the rest. */
  private dedupe(events: InboxEvent[], items: InboxItem[], nowIso: string): InboxEvent[] {
    const insert = this.db.prepare('INSERT OR IGNORE INTO notifications_sent (key, sent_at) VALUES (?, ?)');
    return events.filter((e) => Number(insert.run(eventKey(e, items), nowIso).changes) > 0);
  }
}

function baseItem(pr: RawPr): Omit<InboxItem, 'role'> {
  return {
    pr: prKeyOf(pr),
    title: pr.title,
    url: pr.url,
    authorLogin: pr.author?.login ?? 'ghost',
    isDraft: pr.isDraft,
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    ci: ciOf(pr),
    ...(pr.repository.owner && { ownerType: pr.repository.owner.__typename === 'Organization' ? 'org' : 'user' }),
  };
}

function ssoWarning(org: string, errors: GraphQLErrorEntry[]): NonNullable<InboxMessage['error']> {
  log('inbox: SAML-hidden results:', errors.length);
  return { code: 'gh_sso_required', message: `Some ${org} PRs may be missing.`, fixSteps: fixSso(org) };
}
