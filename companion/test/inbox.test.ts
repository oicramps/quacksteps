// Inbox derivations and the poller, against synthetic GraphQL responses shaped like GitHub's.
// The repo is public, so fixtures never contain real PR data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InboxEvent, InboxItem } from '@quacksteps/shared';
import { openDb } from '../src/db.ts';
import type { RunResult } from '../src/exec.ts';
import { type GhRunner, QUERIES } from '../src/gh.ts';
import { InboxService, type InboxSnapshot, type RawPr, approvalsOf, approvedByOthers, authorState, computeStacks, diffInbox, reviewerInfo } from '../src/inbox.ts';

const VIEWER = 'me-dev';
let seq = 0;

function pr(over: Partial<RawPr> & { ci?: string | null } = {}): RawPr {
  const { ci = 'SUCCESS', ...rest } = over;
  const n = rest.number ?? ++seq;
  return {
    id: `PR_${n}`,
    number: n,
    title: `Change ${n}`,
    url: `https://github.com/acme/web/pull/${n}`,
    isDraft: false,
    createdAt: '2026-11-01T09:00:00Z',
    updatedAt: '2026-11-10T09:00:00Z',
    additions: 10,
    deletions: 2,
    author: { login: 'someone' },
    repository: { nameWithOwner: 'acme/web' },
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    reviewDecision: 'REVIEW_REQUIRED',
    commits: { nodes: [{ commit: { committedDate: '2026-11-09T12:00:00Z', statusCheckRollup: ci ? { state: ci } : null } }] },
    reviewRequests: { nodes: [] },
    timelineItems: { nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    latestReviews: { nodes: [] },
    ...rest,
  };
}

const user = (login: string) => ({ __typename: 'User', login });
const team = (slug: string) => ({ __typename: 'Team', slug });
const requested = (createdAt: string, reviewer: object) => ({ __typename: 'ReviewRequestedEvent', createdAt, requestedReviewer: reviewer });
const clean = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };

// --- author state precedence ------------------------------------------------

test('drafts have no waiting state', () => {
  assert.equal(authorState(pr({ isDraft: true, reviewDecision: 'CHANGES_REQUESTED', ci: 'FAILURE' }), clean).state, null);
});

test('changes requested puts the PR on me, naming who asked', () => {
  const d = authorState(
    pr({
      reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: { nodes: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-11-12T10:00:00Z', author: { login: 'sven' } }] },
    }),
    clean,
  );
  assert.equal(d.state, 'waiting_on_me');
  assert.deepEqual(d.reasons, ['Changes requested by sven']);
  assert.equal(d.estimatedSince, '2026-11-12T10:00:00Z');
});

test('unresolved threads and merge conflicts are each a reason to wait on me', () => {
  const d = authorState(
    pr({ reviewThreads: { totalCount: 3, nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } }),
    { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
  );
  assert.equal(d.state, 'waiting_on_me');
  assert.deepEqual(d.reasons, ['2 unresolved threads', 'Merge conflicts']);
});

test('changes requested outranks failing CI', () => {
  const d = authorState(pr({ reviewDecision: 'CHANGES_REQUESTED', ci: 'FAILURE' }), clean);
  assert.equal(d.state, 'waiting_on_me');
});

test('failing or erroring CI blocks the PR', () => {
  for (const ci of ['FAILURE', 'ERROR']) {
    const d = authorState(pr({ ci, reviewDecision: 'APPROVED' }), clean);
    assert.equal(d.state, 'blocked_by_ci', ci);
    assert.equal(d.estimatedSince, '2026-11-09T12:00:00Z', 'estimated from the last commit');
  }
});

test('ready to merge needs a clean merge state and approval (or no review requirement)', () => {
  assert.equal(authorState(pr({ reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: null, author: { __typename: 'User', login: 'noor' } }] } }), clean).state, 'ready_to_merge');
  assert.equal(authorState(pr({ reviewDecision: null, latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: null, author: { __typename: 'User', login: 'noor' } }] } }), { mergeable: 'MERGEABLE', mergeStateStatus: 'HAS_HOOKS' }).state, 'ready_to_merge');
  assert.equal(authorState(pr({ reviewDecision: 'REVIEW_REQUIRED' }), clean).state, 'waiting_on_reviewers');
  assert.equal(authorState(pr({ reviewDecision: 'APPROVED' }), { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }).state, 'waiting_on_reviewers');
});

test('review bots never count as the approval a PR needs', () => {
  const bot = { __typename: 'Bot', login: 'coderabbitai' };
  const botOnly = pr({ reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: null, author: bot }] } });
  assert.equal(authorState(botOnly, clean).state, 'waiting_on_reviewers', 'a bot approval alone is not ready');
  assert.deepEqual(approvalsOf(botOnly), [{ login: 'coderabbitai', bot: true }]);
  // A known bot even without the Bot type, and "[bot]" logins, lose the suffix.
  const named = pr({ latestReviews: { nodes: [
    { state: 'APPROVED', submittedAt: null, author: { login: 'coderabbitai' } },
    { state: 'APPROVED', submittedAt: null, author: { __typename: 'Bot', login: 'renovate[bot]' } },
    { state: 'APPROVED', submittedAt: null, author: { __typename: 'User', login: 'noor' } },
  ] } });
  assert.deepEqual(approvalsOf(named), [{ login: 'coderabbitai', bot: true }, { login: 'renovate', bot: true }, { login: 'noor', bot: false }]);
  assert.deepEqual(approvedByOthers(named, 'me'), ['noor'], 'a review request approved only by bots still waits on me');
  // A bot's change request alone isn't my turn; its unresolved threads are.
  const botChanges = pr({ reviewDecision: 'CHANGES_REQUESTED', latestReviews: { nodes: [{ state: 'CHANGES_REQUESTED', submittedAt: null, author: bot }] } });
  assert.equal(authorState(botChanges, clean).state, 'waiting_on_reviewers');
  const withThreads = pr({ ...botChanges, reviewThreads: { totalCount: 2, nodes: [{ isResolved: false }, { isResolved: true }] } });
  assert.deepEqual(authorState(withThreads, clean).reasons, ['1 unresolved thread']);
});

test('unknown merge state is never ready and never conflicting', () => {
  assert.equal(authorState(pr({ reviewDecision: 'APPROVED' }), null).state, 'waiting_on_reviewers');
});

test('pending checks wait on reviewers', () => {
  assert.equal(authorState(pr({ ci: 'PENDING' }), clean).state, 'waiting_on_reviewers');
});

// --- reviewer wait time ------------------------------------------------------

test('a direct request starts the clock at the newest request for me', () => {
  const info = reviewerInfo(
    pr({
      reviewRequests: { nodes: [{ requestedReviewer: user('Me-Dev') }] },
      timelineItems: {
        nodes: [
          requested('2026-11-02T09:00:00Z', user('me-dev')),
          requested('2026-11-03T09:00:00Z', user('other')),
          requested('2026-11-05T09:00:00Z', user('ME-DEV')), // re-request resets
        ],
      },
    }),
    VIEWER,
  );
  assert.deepEqual(info, { requestedAt: '2026-11-05T09:00:00Z', via: 'user' });
});

test('a team request is timed from the request to that team', () => {
  const info = reviewerInfo(
    pr({
      reviewRequests: { nodes: [{ requestedReviewer: user('other') }, { requestedReviewer: team('web-core') }] },
      timelineItems: { nodes: [requested('2026-11-04T09:00:00Z', team('web-core')), requested('2026-11-06T09:00:00Z', user('other'))] },
    }),
    VIEWER,
  );
  assert.deepEqual(info, { requestedAt: '2026-11-04T09:00:00Z', via: 'team', team: 'web-core' });
});

test('without a request event the clock starts when the PR was marked ready, then when it was created', () => {
  const ready = reviewerInfo(
    pr({ reviewRequests: { nodes: [{ requestedReviewer: user(VIEWER) }] }, timelineItems: { nodes: [{ __typename: 'ReadyForReviewEvent', createdAt: '2026-11-07T09:00:00Z' }] } }),
    VIEWER,
  );
  assert.equal(ready.requestedAt, '2026-11-07T09:00:00Z');
  const created = reviewerInfo(pr({ reviewRequests: { nodes: [{ requestedReviewer: user(VIEWER) }] } }), VIEWER);
  assert.equal(created.requestedAt, '2026-11-01T09:00:00Z');
});

// --- events -----------------------------------------------------------------

const item = (over: Partial<InboxItem>): InboxItem => ({
  pr: { owner: 'acme', repo: 'web', number: 1 },
  title: 't',
  url: 'u',
  authorLogin: 'a',
  isDraft: false,
  headSha: 'a'.repeat(40),
  baseRef: 'main',
  updatedAt: '2026-11-10T09:00:00Z',
  additions: 1,
  deletions: 1,
  role: 'author',
  author: { state: 'waiting_on_reviewers', since: '2026-11-10T09:00:00Z', reasons: [] },
  ci: 'passing',
  ...over,
});

test('the first poll produces no events', () => {
  assert.deepEqual(diffInbox(null, [item({})]), []);
});

test('a new or repeated review request is an event', () => {
  const r = (requestedAt: string) => item({ role: 'reviewer', author: undefined, reviewer: { requestedAt, via: 'user' } });
  assert.deepEqual(diffInbox([], [r('2026-11-01T00:00:00Z')]).map((e) => e.kind), ['review_requested']);
  assert.deepEqual(diffInbox([r('2026-11-01T00:00:00Z')], [r('2026-11-01T00:00:00Z')]), []);
  assert.deepEqual(diffInbox([r('2026-11-01T00:00:00Z')], [r('2026-11-02T00:00:00Z')]).map((e) => e.kind), ['review_requested']);
});

test('only moves into waiting_on_me, blocked_by_ci or ready_to_merge notify', () => {
  const at = (state: InboxItem['author'] extends infer A ? (A extends { state: infer S } ? S : never) : never) =>
    item({ author: { state, since: 'x', reasons: [] } });
  assert.deepEqual(diffInbox([at('waiting_on_reviewers')], [at('waiting_on_me')]), [
    { kind: 'state_changed', pr: { owner: 'acme', repo: 'web', number: 1 }, from: 'waiting_on_reviewers', to: 'waiting_on_me' },
  ]);
  assert.deepEqual(diffInbox([at('waiting_on_me')], [at('waiting_on_reviewers')]), []);
  assert.equal(diffInbox([at('waiting_on_reviewers')], [at('ready_to_merge')])[0].kind, 'state_changed');
});

test('CI failing on a new head is an event once per head', () => {
  const failing = (sha: string) => item({ ci: 'failing', headSha: sha });
  assert.deepEqual(diffInbox([item({})], [failing('b'.repeat(40))]).map((e) => e.kind), ['ci_failed']);
  assert.deepEqual(diffInbox([failing('b'.repeat(40))], [failing('b'.repeat(40))]), []);
  assert.deepEqual(diffInbox([failing('b'.repeat(40))], [failing('c'.repeat(40))]).map((e) => e.kind), ['ci_failed']);
});

test('new commits are an event only on a PR being reviewed', () => {
  const next = [item({ headSha: 'b'.repeat(40) })];
  assert.deepEqual(diffInbox([item({})], next), []);
  assert.deepEqual(diffInbox([item({})], next, () => true).map((e) => e.kind), ['new_commits']);
});

// --- the poller ---------------------------------------------------------------

interface World {
  review: RawPr[];
  mine: RawPr[];
  merge: Record<string, { mergeable: string; mergeStateStatus: string }>;
  rateLimit?: { limit: number; remaining: number; resetAt: string };
  failMerge?: boolean;
  failAll?: Partial<RunResult>;
  errors?: { type: string; message: string }[];
  /** reviewedPr lookups by PR number: the PR (with state), null for not found, 'fail' for an error. */
  lookup?: Record<number, (RawPr & { state: string; closedAt: string | null; mergedBy?: { login: string } }) | null | 'fail'>;
  /** stackParent answers by head branch name; 'fail' errors. */
  parents?: Record<string, { number: number; title: string; headRefName: string; baseRefName: string } | 'fail'>;
  calls: string[];
}

/** A fake `gh` that answers the compiled-in documents from `world`. */
function fakeGh(world: World): GhRunner {
  return async (args) => {
    const query = args.find((a) => a.startsWith('query='))!.slice(6);
    const name = Object.entries(QUERIES).find(([, q]) => q === query)?.[0] ?? 'unknown';
    world.calls.push(name);
    if (world.failAll) return { code: 1, stdout: '', stderr: '', ...world.failAll };
    const rateLimit = world.rateLimit ?? { limit: 5000, remaining: 4900, resetAt: '2026-11-17T12:00:00Z' };
    const ok = (data: unknown, errors?: unknown) => ({ code: 0, stdout: JSON.stringify({ data, ...(errors ? { errors } : {}) }), stderr: '' });
    switch (name) {
      case 'inboxReview':
        return ok({ viewer: { login: VIEWER }, rateLimit, search: { issueCount: world.review.length, nodes: world.review } }, world.errors);
      case 'inboxMine':
        return ok({ rateLimit, search: { issueCount: world.mine.length, nodes: world.mine } });
      case 'mergeState': {
        if (world.failMerge) return { code: 1, stdout: '', stderr: 'gh: HTTP 502' };
        const ids = args.filter((a) => a.startsWith('ids[]=')).map((a) => a.slice(6));
        return ok({ nodes: ids.map((id) => ({ id, ...(world.merge[id] ?? { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) })) });
      }
      case 'reviewedPr': {
        const n = Number(args[args.indexOf('-F') + 1].split('=')[1]);
        const found = world.lookup?.[n];
        if (found === 'fail') return { code: 1, stdout: '', stderr: 'gh: HTTP 502' };
        return ok({ repository: { pullRequest: found ?? null } });
      }
      case 'stackParent': {
        const head = args.find((a) => a.startsWith('head='))!.slice(5);
        const p = world.parents?.[head];
        if (p === 'fail') return { code: 1, stdout: '', stderr: 'gh: HTTP 502' };
        return ok({ repository: { pullRequests: { nodes: p ? [p] : [] } } });
      }
      default:
        throw new Error(`unexpected query ${name}`);
    }
  };
}

function setup(world: Partial<World> = {}, opts: Partial<ConstructorParameters<typeof InboxService>[0]> = {}) {
  const w: World = { review: [], mine: [], merge: {}, calls: [], ...world };
  let now = new Date('2026-11-17T10:00:00Z');
  const db = openDb(':memory:');
  const make = () => new InboxService({ db, runner: fakeGh(w), now: () => now, ...opts });
  const inbox = make();
  const seen: { snap: InboxSnapshot; events: InboxEvent[] }[] = [];
  inbox.subscribe((snap, events) => seen.push({ snap, events }));
  return { w, db, inbox, seen, make, advance: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
}

test('a poll stores items, sorted, and the viewer', async () => {
  const mineReady = pr({ number: 10, author: { login: VIEWER }, reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: null, author: { __typename: 'User', login: 'noor' } }] } });
  const mineBlocked = pr({ number: 11, author: { login: VIEWER }, ci: 'FAILURE' });
  const draft = pr({ number: 12, author: { login: VIEWER }, isDraft: true });
  const older = pr({ number: 20, reviewRequests: { nodes: [{ requestedReviewer: user(VIEWER) }] }, timelineItems: { nodes: [requested('2026-11-02T00:00:00Z', user(VIEWER))] } });
  const newer = pr({ number: 21, reviewRequests: { nodes: [{ requestedReviewer: user(VIEWER) }] }, timelineItems: { nodes: [requested('2026-11-08T00:00:00Z', user(VIEWER))] } });
  const t = setup({ review: [newer, older], mine: [draft, mineReady, mineBlocked], merge: { PR_10: clean, PR_11: clean } });
  await t.inbox.refresh();

  const snap = t.inbox.snapshot();
  assert.equal(t.inbox.viewer, VIEWER);
  assert.equal(snap.fetchedAt, '2026-11-17T10:00:00.000Z');
  assert.deepEqual(
    snap.items.map((i) => [i.role, i.pr.number, i.role === 'author' ? i.author!.state : i.reviewer!.requestedAt]),
    [
      ['reviewer', 20, '2026-11-02T00:00:00Z'],
      ['reviewer', 21, '2026-11-08T00:00:00Z'],
      ['author', 11, 'blocked_by_ci'],
      ['author', 10, 'ready_to_merge'],
      ['author', 12, null],
    ],
  );
  assert.deepEqual(t.w.calls.sort(), ['inboxMine', 'inboxReview', 'mergeState'], 'merge state only for non-draft PRs, one chunk');
  assert.equal(t.seen.length, 1);
  assert.deepEqual(t.seen[0].events, [], 'no events on the very first poll');
});

test('merge state is fetched in chunks of 10', async () => {
  const mine = Array.from({ length: 23 }, (_, i) => pr({ number: 100 + i, author: { login: VIEWER } }));
  const t = setup({ mine });
  await t.inbox.refresh();
  assert.equal(t.w.calls.filter((c) => c === 'mergeState').length, 3);
});

test('a later poll emits events, and the same event is never sent twice, even after a restart', async () => {
  const t = setup({ review: [] });
  await t.inbox.refresh();
  t.w.review = [pr({ number: 30, reviewRequests: { nodes: [{ requestedReviewer: user(VIEWER) }] } })];
  t.advance(60_000);
  await t.inbox.refresh();
  assert.deepEqual(t.seen.at(-1)!.events.map((e) => e.kind), ['review_requested']);

  // A restarted server reads the stored snapshot: no repeat.
  const restarted = t.make();
  const events: InboxEvent[][] = [];
  restarted.subscribe((_, e) => events.push(e));
  t.advance(60_000);
  await restarted.refresh();
  assert.deepEqual(events.at(-1), []);
});

test('since keeps its start while the state holds, and moves when the state changes', async () => {
  const mine = pr({ number: 40, author: { login: VIEWER }, reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-11-15T08:00:00Z' });
  const t = setup({ mine: [mine], merge: { PR_40: clean } });
  await t.inbox.refresh();
  const first = t.inbox.snapshot().items[0].author!;
  assert.deepEqual([first.state, first.since], ['waiting_on_reviewers', '2026-11-15T08:00:00Z'], 'estimated on first sight');

  t.advance(3600_000);
  await t.inbox.refresh();
  assert.equal(t.inbox.snapshot().items[0].author!.since, '2026-11-15T08:00:00Z', 'unchanged state keeps its start');

  t.w.mine = [{ ...mine, reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: null, author: { __typename: 'User', login: 'noor' } }] } }];
  t.advance(3600_000);
  await t.inbox.refresh();
  const moved = t.inbox.snapshot().items[0].author!;
  assert.deepEqual([moved.state, moved.since], ['ready_to_merge', t.now().toISOString()]);
  assert.deepEqual(t.seen.at(-1)!.events.map((e) => e.kind), ['state_changed']);
});

test('when merge state fails, the last known value at the same head is used', async () => {
  const mine = pr({ number: 50, author: { login: VIEWER }, reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: null, author: { __typename: 'User', login: 'noor' } }] } });
  const t = setup({ mine: [mine], merge: { PR_50: clean } });
  await t.inbox.refresh();
  assert.equal(t.inbox.snapshot().items[0].author!.state, 'ready_to_merge');

  t.w.failMerge = true;
  t.advance(60_000);
  await t.inbox.refresh();
  assert.equal(t.inbox.snapshot().items[0].author!.state, 'ready_to_merge', 'kept');

  t.w.mine = [{ ...mine, headRefOid: 'f'.repeat(40) }];
  t.advance(60_000);
  await t.inbox.refresh();
  assert.equal(t.inbox.snapshot().items[0].author!.state, 'waiting_on_reviewers', 'a new head makes it unknown');
});

test('a failed poll keeps the last items and reports the error with fix steps', async () => {
  const t = setup({ review: [pr({ number: 60, reviewRequests: { nodes: [{ requestedReviewer: user(VIEWER) }] } })] });
  await t.inbox.refresh();
  t.w.failAll = { stderr: 'To get started with GitHub CLI, please run:  gh auth login' };
  t.advance(60_000);
  await t.inbox.refresh();
  const snap = t.seen.at(-1)!.snap;
  assert.equal(snap.items.length, 1, 'items from the last good poll');
  assert.equal(snap.error?.code, 'gh_not_logged_in');
  assert.ok(snap.error?.fixSteps?.some((s) => s.command?.startsWith('gh auth login')));
  assert.equal(snap.fetchedAt, '2026-11-17T10:00:00.000Z', 'age of the list stays visible');
});

test('a GitHub timeout is transient and asks nothing of the user', async () => {
  const t = setup();
  t.w.failAll = { stderr: 'gh: HTTP 502' };
  await t.inbox.refresh();
  const err = t.seen.at(-1)!.snap.error!;
  assert.equal(err.code, 'gh_unavailable');
  assert.equal(err.fixSteps, undefined);
});

test('SSO-hidden results keep the items and add a warning', async () => {
  const t = setup({
    review: [pr({ number: 70, reviewRequests: { nodes: [{ requestedReviewer: user(VIEWER) }] } })],
    errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement. You must grant your OAuth token access.' }],
  });
  await t.inbox.refresh();
  const snap = t.seen.at(-1)!.snap;
  assert.equal(snap.items.length, 1);
  assert.equal(snap.error?.code, 'gh_sso_required');
  assert.match(snap.error!.message, /polarsteps PRs may be missing/);
});

test('below 10% of the rate limit, polling waits for the reset', async () => {
  const t = setup({ rateLimit: { limit: 5000, remaining: 400, resetAt: '2026-11-17T10:45:00Z' } });
  await t.inbox.refresh();
  t.w.calls.length = 0;
  t.advance(60_000);
  await t.inbox.refresh();
  assert.deepEqual(t.w.calls, [], 'no request before the reset');
  t.advance(45 * 60_000);
  await t.inbox.refresh();
  assert.ok((t.w.calls as string[]).includes('inboxReview'), 'polls again after the reset');
});

test('a secondary rate limit backs off from 2 minutes, doubling', async () => {
  const t = setup();
  t.w.failAll = { stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)' };
  await t.inbox.refresh();
  assert.equal(t.seen.at(-1)!.snap.error?.code, 'rate_limited');
  t.w.calls.length = 0;
  t.advance(90_000);
  await t.inbox.refresh();
  assert.deepEqual(t.w.calls, [], 'still backing off at 1.5 min');
  t.advance(60_000);
  await t.inbox.refresh();
  assert.ok(t.w.calls.length > 0, 'retries after 2 min');
});

test('the poller only sends the compiled-in documents', async () => {
  const sent: string[][] = [];
  const db = openDb(':memory:');
  const inbox = new InboxService({ db, runner: async (args) => (sent.push(args), { code: 1, stdout: '', stderr: 'gh: HTTP 502' }) });
  await inbox.refresh();
  const documents = new Set(Object.values(QUERIES));
  for (const args of sent) {
    assert.deepEqual(args.slice(0, 4), ['api', 'graphql', '--hostname', 'github.com']);
    const query = args.find((a) => a.startsWith('query='))!.slice(6);
    assert.ok(documents.has(query as never));
    assert.doesNotMatch(query, /\bmutation\b/);
  }
});

// --- PRs I'm reviewing that the searches no longer return -------------------------

const reviewedKey = (n: number) => ({ owner: 'acme', repo: 'web', number: n });

test('a PR I already reviewed stays in the inbox, marked not requested, and makes no event', async () => {
  const requestedEarlier = pr({ number: 30, timelineItems: { nodes: [requested('2026-11-05T09:00:00Z', user(VIEWER))] } });
  const t = setup(
    { review: [requestedEarlier], lookup: {} },
    { reviewed: () => [reviewedKey(30)] },
  );
  await t.inbox.refresh();
  assert.ok(!t.w.calls.includes('reviewedPr'), 'still requested: no lookup');

  // I submit my review: the search drops it, the lookup keeps it.
  t.w.review = [];
  t.w.lookup = { 30: { ...requestedEarlier, state: 'OPEN', closedAt: null } };
  t.advance(60_000);
  await t.inbox.refresh();
  const item = t.inbox.snapshot().items.find((i) => i.pr.number === 30)!;
  assert.deepEqual(item.reviewer, { requestedAt: '2026-11-05T09:00:00Z', via: 'user', requested: false });
  assert.deepEqual(t.seen.at(-1)!.events, []);
});

test('reviewed items sort after open requests', async () => {
  const open = pr({ number: 31, timelineItems: { nodes: [requested('2026-11-15T09:00:00Z', user(VIEWER))] }, reviewRequests: { nodes: [{ requestedReviewer: user(VIEWER) }] } });
  const done = pr({ number: 32, timelineItems: { nodes: [requested('2026-11-01T09:00:00Z', user(VIEWER))] } });
  const t = setup({ review: [open], lookup: { 32: { ...done, state: 'OPEN', closedAt: null } } }, { reviewed: () => [reviewedKey(32)] });
  await t.inbox.refresh();
  assert.deepEqual(t.inbox.snapshot().items.map((i) => i.pr.number), [31, 32]);
});

test('a reviewed PR that closed is reported, not listed', async () => {
  const closed: { pr: object; info: object }[] = [];
  const t = setup(
    { lookup: { 33: { ...pr({ number: 33 }), state: 'MERGED', closedAt: '2026-11-16T08:00:00Z', mergedBy: { login: 'noor' } } } },
    { reviewed: () => [reviewedKey(33)], onClosed: (p, info) => closed.push({ pr: p, info }) },
  );
  await t.inbox.refresh();
  assert.deepEqual(closed, [{ pr: { owner: 'acme', repo: 'web', number: 33 }, info: { state: 'merged', at: '2026-11-16T08:00:00Z', by: 'noor' } }]);
  assert.equal(t.inbox.snapshot().items.length, 0);
});

test('a failed lookup keeps the previous item; a missing PR is dropped', async () => {
  const done = pr({ number: 34 });
  const t = setup({ lookup: { 34: { ...done, state: 'OPEN', closedAt: null }, 35: null } }, { reviewed: () => [reviewedKey(34), reviewedKey(35)] });
  await t.inbox.refresh();
  t.w.lookup = { 34: 'fail', 35: null };
  t.advance(60_000);
  await t.inbox.refresh();
  assert.deepEqual(t.inbox.snapshot().items.map((i) => i.pr.number), [34]);
});

test('reviewed PRs reach onPoll, so new commits make their review stale', async () => {
  const heads: string[] = [];
  const t = setup(
    { lookup: { 36: { ...pr({ number: 36, headRefOid: 'c'.repeat(40) }), state: 'OPEN', closedAt: null } } },
    { reviewed: () => [reviewedKey(36)], onPoll: (items) => heads.push(...items.map((i) => i.headSha)) },
  );
  await t.inbox.refresh();
  assert.deepEqual(heads, ['c'.repeat(40)]);
});

test('the reviewed-PR lookup sends its number as an integer', async () => {
  const sent: string[][] = [];
  const db = openDb(':memory:');
  const inbox = new InboxService({ db, reviewed: () => [reviewedKey(37)], runner: async (args) => (sent.push(args), { code: 1, stdout: '', stderr: 'gh: HTTP 502' }) });
  await inbox.refresh();
  // The searches fail first, so no lookup runs; check the variable encoding directly instead.
  const { graphql } = await import('../src/gh.ts');
  await graphql('reviewedPr', { owner: 'acme', name: 'web', number: 37 }, async (args) => (sent.push(args), { code: 0, stdout: '{"data":{}}', stderr: '' }));
  const last = sent.at(-1)!;
  assert.deepEqual(last.slice(last.indexOf('-F'), last.indexOf('-F') + 2), ['-F', 'number=37']);
  await assert.rejects(graphql('reviewedPr', { owner: 'acme', name: 'web', number: 1.5 }, async () => ({ code: 0, stdout: '{}', stderr: '' })), /bad number/);
});

// --- stacked PRs -------------------------------------------------------------------

const node = (number: number, head: string, base: string) => ({ repo: 'acme/web', number, title: `PR ${number}`, head, base });

test('stacks: position counts from the bottom, size spans the whole chain', () => {
  const s = computeStacks([node(1, 'a', 'main'), node(2, 'b', 'a'), node(3, 'c', 'b'), node(9, 'solo', 'main')]);
  assert.deepEqual(s.get('acme/web#1'), { position: 1, size: 3 });
  assert.deepEqual(s.get('acme/web#2'), { position: 2, size: 3, parent: { number: 1, title: 'PR 1' } });
  assert.deepEqual(s.get('acme/web#3'), { position: 3, size: 3, parent: { number: 2, title: 'PR 2' } });
  assert.equal(s.has('acme/web#9'), false, 'a PR alone is no stack');
});

test('stacks: parents found outside the inbox complete the chain but get no entry', () => {
  const s = computeStacks([node(3, 'c', 'b')], [node(2, 'b', 'a'), node(1, 'a', 'main')]);
  assert.deepEqual(s.get('acme/web#3'), { position: 3, size: 3, parent: { number: 2, title: 'PR 2' } });
  assert.equal(s.size, 1);
});

test('stacks: the same branch name in another repo is not a parent, and cycles stop', () => {
  const other = { ...node(5, 'a', 'main'), repo: 'acme/api' };
  assert.equal(computeStacks([other, node(2, 'b', 'a')]).size, 0);
  const loop = computeStacks([node(1, 'x', 'y'), node(2, 'y', 'x')]);
  assert.deepEqual(loop.get('acme/web#1'), { position: 2, size: 2, parent: { number: 2, title: 'PR 2' } });
});

const stacked = (number: number, head: string, base: string, extra: Partial<RawPr> = {}) =>
  pr({ number, headRefName: head, baseRefName: base, repository: { nameWithOwner: 'acme/web', defaultBranchRef: { name: 'main' } }, ...extra });

test('a poll marks stacked PRs, looking up a parent the inbox does not have', async () => {
  const t = setup({
    review: [stacked(41, 'feat/top', 'feat/middle'), stacked(30, 'feat/base', 'main')],
    parents: { 'feat/middle': { number: 40, title: 'Middle', headRefName: 'feat/middle', baseRefName: 'feat/base' } },
  });
  await t.inbox.refresh();
  const byNumber = new Map(t.inbox.snapshot().items.map((i) => [i.pr.number, i.stack]));
  assert.deepEqual(byNumber.get(41), { position: 3, size: 3, parent: { number: 40, title: 'Middle' } });
  assert.deepEqual(byNumber.get(30), { position: 1, size: 3 });
  assert.equal(t.w.calls.filter((c) => c === 'stackParent').length, 1, 'feat/base is already in the inbox: no second lookup');
});

test('PRs on the default branch cost no lookups, and a failed lookup leaves no stack', async () => {
  const t = setup({ review: [stacked(50, 'feat/x', 'main'), stacked(51, 'feat/y', 'feat/gone')], parents: { 'feat/gone': 'fail' } });
  await t.inbox.refresh();
  assert.equal(t.inbox.snapshot().items.some((i) => i.stack), false);
  assert.deepEqual(t.w.calls.filter((c) => c === 'stackParent'), ['stackParent']);
});

// --- review requests someone else already approved ------------------------------------

test('approvals by other reviewers are listed; mine, pending and changes-requested reviews are not', () => {
  const p = pr({
    latestReviews: {
      nodes: [
        { state: 'APPROVED', submittedAt: null, author: { login: 'noor' } },
        { state: 'APPROVED', submittedAt: null, author: { login: VIEWER.toUpperCase() } },
        { state: 'CHANGES_REQUESTED', submittedAt: null, author: { login: 'sven' } },
        { state: 'COMMENTED', submittedAt: null, author: { login: 'joris' } },
        { state: 'APPROVED', submittedAt: null, author: null },
      ],
    },
  });
  assert.deepEqual(approvedByOthers(p, VIEWER), ['noor']);
  assert.deepEqual(approvedByOthers(pr(), VIEWER), []);
});

test('a poll marks review requests someone else approved', async () => {
  const approved = pr({ number: 60, latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: null, author: { login: 'noor' } }] } });
  const t = setup({ review: [approved, pr({ number: 61 })] });
  await t.inbox.refresh();
  const byNumber = new Map(t.inbox.snapshot().items.map((i) => [i.pr.number, i.reviewer]));
  assert.deepEqual(byNumber.get(60)!.approvedBy, ['noor']);
  assert.equal(byNumber.get(61)!.approvedBy, undefined);
});
