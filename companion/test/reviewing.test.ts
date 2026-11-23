import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrKey, ReviewState } from '@quacksteps/shared';
import type { Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { type ReviewOps, ReviewingService } from '../src/reviewing.ts';
import { acquireRead } from '../src/rwlock.ts';

const PR: PrKey = { owner: 'Acme', repo: 'Web', number: 7 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const config = { worktreeRoot: '/virtual/worktrees', scanRoots: ['~/Projects'], repoPaths: {}, retentionDays: 7, maxWorktrees: 20 } as unknown as Config;

function fakeOps(over: Partial<ReviewOps> = {}) {
  const calls: string[] = [];
  let head = A;
  const ops: ReviewOps = {
    async findClone() {
      calls.push('find');
      return { clone: '/clones/web', blockedRoots: [] };
    },
    async fetchHead() {
      calls.push('fetch');
      return head;
    },
    async checkout(_clone, _dir, sha) {
      calls.push(`checkout ${sha.slice(0, 1)}`);
    },
    async remove() {
      calls.push('remove');
      return true;
    },
    ...over,
  };
  return { ops, calls, setHead: (sha: string) => (head = sha) };
}

function setup(over: Partial<ReviewOps> = {}) {
  const db = openDb(':memory:');
  const f = fakeOps(over);
  const ready: { pr: PrKey; review: ReviewState; settings: object }[] = [];
  const make = () => new ReviewingService({ db, config: () => config, ops: f.ops, onReady: (pr, review, settings) => ready.push({ pr, review, settings }) });
  const svc = make();
  const seen: (ReviewState | null)[] = [];
  svc.subscribe((_, r) => seen.push(r));
  return { db, svc, seen, ready, make, ...f };
}

test('start reviewing walks the four steps and ends ready at the fetched head', async () => {
  const t = setup();
  const first = t.svc.start(PR, { agent: 'cursor', model: 'fast' });
  assert.equal(first.phase, 'preparing');
  assert.equal(first.worktreePath, '/virtual/worktrees/acme/web/pr-7');
  await t.svc.idle();

  const review = t.svc.get(PR)!;
  assert.deepEqual([review.phase, review.headSha, review.latestHeadSha, review.step], ['ready', A, A, undefined]);
  assert.deepEqual(t.calls, ['find', 'fetch', 'checkout a']);
  assert.deepEqual(
    t.seen.map((r) => r?.step ?? r?.phase),
    ['finding_clone', 'fetching', 'checking_out', 'ready'],
  );
  assert.deepEqual(t.ready[0].settings, { agent: 'cursor', model: 'fast' }, 'labels get the agent chosen at start');
});

test('starting a PR already being reviewed returns its state and does nothing else', async () => {
  const t = setup();
  t.svc.start(PR);
  await t.svc.idle();
  const again = t.svc.start({ ...PR, owner: 'acme', repo: 'web' });
  assert.equal(again.phase, 'ready');
  await t.svc.idle();
  assert.equal(t.calls.filter((c) => c === 'fetch').length, 1, 'owner and repo are case-insensitive');
});

test('a missing clone fails with fix steps for Quacksteps, and starting again retries', async () => {
  let found = false;
  const t = setup({
    async findClone() {
      return found ? { clone: '/clones/web', blockedRoots: [] } : { clone: null, blockedRoots: ['/Users/me/Documents'] };
    },
  });
  t.svc.start(PR);
  await t.svc.idle();
  const failed = t.svc.get(PR)!;
  assert.equal(failed.phase, 'failed');
  assert.match(failed.error!, /Quacksteps does not have permission/);
  assert.ok(failed.fixSteps!.some((s) => /Allow Quacksteps/.test(s.text)));
  assert.ok(failed.fixSteps!.some((s) => s.command?.startsWith('git clone')));

  found = true;
  assert.equal(t.svc.start(PR).phase, 'preparing');
  await t.svc.idle();
  assert.equal(t.svc.get(PR)!.phase, 'ready');
});

test('a failed fetch says how to check git access', async () => {
  const t = setup({
    async fetchHead() {
      throw new Error('could not read from remote');
    },
  });
  t.svc.start(PR);
  await t.svc.idle();
  const failed = t.svc.get(PR)!;
  assert.equal(failed.phase, 'failed');
  assert.match(failed.error!, /Could not fetch PR #7: could not read from remote/);
  assert.match(failed.fixSteps![0].command!, /git -C "\/clones\/web" fetch origin/);
});

test('new commits make the review stale without moving the worktree; Update moves it', async () => {
  const t = setup();
  t.svc.start(PR);
  await t.svc.idle();

  assert.equal(t.svc.noteHead(PR, A), true, 'same head: still ready');
  assert.equal(t.svc.get(PR)!.phase, 'ready');

  t.setHead(B);
  t.svc.noteHead(PR, B);
  const stale = t.svc.get(PR)!;
  assert.deepEqual([stale.phase, stale.headSha, stale.latestHeadSha], ['stale', A, B]);
  assert.deepEqual(t.calls, ['find', 'fetch', 'checkout a'], 'no checkout on stale');

  assert.equal(t.svc.update(PR)!.phase, 'preparing');
  await t.svc.idle();
  const updated = t.svc.get(PR)!;
  assert.deepEqual([updated.phase, updated.headSha, updated.latestHeadSha], ['ready', B, B]);
  assert.equal(t.ready.length, 2, 'labels re-run after Update');
});

test('Update on a ready review changes nothing', async () => {
  const t = setup();
  t.svc.start(PR);
  await t.svc.idle();
  assert.equal(t.svc.update(PR)!.phase, 'ready');
  await t.svc.idle();
  assert.equal(t.calls.filter((c) => c.startsWith('checkout')).length, 1);
});

test('noteHead ignores PRs that are not being reviewed', () => {
  const t = setup();
  assert.equal(t.svc.noteHead(PR, A), false);
  assert.equal(t.svc.get(PR), undefined);
});

test('Update waits for agents reading the old commit before checking out', async () => {
  const t = setup();
  t.svc.start(PR);
  await t.svc.idle();
  t.setHead(B);
  t.svc.noteHead(PR, B);

  const reader = await acquireRead('/virtual/worktrees/acme/web/pr-7');
  t.svc.update(PR);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.calls.filter((c) => c === 'checkout b').length, 0, 'blocked by the reader');
  assert.equal(t.svc.get(PR)!.step, 'checking_out');
  reader();
  await t.svc.idle();
  assert.equal(t.svc.get(PR)!.headSha, B);
});

test('stopping while preparing stops the pipeline and leaves no review behind', async () => {
  let unblock!: () => void;
  const t = setup({
    async fetchHead() {
      await new Promise<void>((r) => (unblock = r));
      return A;
    },
  });
  t.svc.start(PR);
  await new Promise((r) => setTimeout(r, 5));
  const stopping = t.svc.stop(PR);
  unblock();
  await stopping;
  await t.svc.idle();
  assert.equal(t.svc.get(PR), undefined);
  assert.equal(t.seen.at(-1), null);
  assert.ok(!t.calls.some((c) => c.startsWith('checkout')));
});

test('stop with removeWorktree deletes it; without, keeps it', async () => {
  const t = setup();
  t.svc.start(PR);
  await t.svc.idle();
  await t.svc.stop(PR);
  assert.ok(!t.calls.includes('remove'));
  t.svc.start(PR);
  await t.svc.idle();
  await t.svc.stop(PR, true);
  assert.ok(t.calls.includes('remove'));
});

test('a review interrupted by a restart resumes preparing', async () => {
  let unblock!: () => void;
  const t = setup({
    async fetchHead() {
      await new Promise<void>((r) => (unblock = r));
      return A;
    },
  });
  t.svc.start(PR);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(t.svc.get(PR)!.step, 'fetching');

  // "Restart": a new service over the same database, with a working fetch.
  const restarted = new ReviewingService({ db: t.db, config: () => config, ops: { ...t.ops, fetchHead: async () => A } });
  restarted.resume();
  await restarted.idle();
  assert.equal(restarted.get(PR)!.phase, 'ready');
  unblock();
  await t.svc.idle();
});

test('a merged PR is recorded on the review (once) so the PR tab can say so', async () => {
  const t = setup();
  t.svc.start(PR);
  await t.svc.idle();
  const closed = { state: 'merged' as const, at: '2026-11-18T10:00:00Z', by: 'noor' };
  const before = t.seen.length;
  t.svc.setClosed(PR, closed);
  t.svc.setClosed(PR, closed);
  assert.deepEqual(t.svc.get(PR)!.closed, closed);
  assert.equal(t.seen.length, before + 1, 'unchanged info is not re-published');
});

test('a stale review learns how many new commits there are; Update clears it', async () => {
  const db = openDb(':memory:');
  const f = fakeOps();
  const asked: string[] = [];
  const svc = new ReviewingService({
    db,
    config: () => config,
    ops: f.ops,
    countCommits: async (_pr, base, head) => (asked.push(`${base[0]}..${head[0]}`), 3),
  });
  svc.start(PR);
  await svc.idle();
  f.setHead(B);
  svc.noteHead(PR, B);
  for (let i = 0; i < 20 && svc.get(PR)!.newCommits === undefined; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(svc.get(PR)!.newCommits, 3);
  assert.deepEqual(asked, ['a..b']);
  svc.noteHead(PR, B);
  assert.deepEqual(asked, ['a..b'], 'same head: not asked again');
  svc.update(PR);
  await svc.idle();
  assert.equal(svc.get(PR)!.newCommits, undefined);
});

test('a count that arrives after the review moved on is dropped', async () => {
  const db = openDb(':memory:');
  const f = fakeOps();
  const pending: ((n: number) => void)[] = [];
  const svc = new ReviewingService({ db, config: () => config, ops: f.ops, countCommits: () => new Promise((r) => pending.push(r)) });
  svc.start(PR);
  await svc.idle();
  svc.noteHead(PR, B);
  svc.noteHead(PR, 'c'.repeat(40));
  pending[0](3); // the count for a..b arrives after the head moved to c
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(svc.get(PR)!.newCommits, undefined);
});
