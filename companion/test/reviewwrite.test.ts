import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrKey, ServerMessage } from '@quacksteps/shared';
import { openDb } from '../src/db.ts';
import { GhError, type GhRunner, MUTATIONS, QUERIES } from '../src/gh.ts';
import { createRouter } from '../src/router.ts';
import { DraftStore, MAX_DRAFTS_PER_PR, ReviewWriteError, ReviewWriter } from '../src/reviewwrite.ts';
import { ValidationError, validateAppMessage } from '../src/validate.ts';

// Synthetic data only: this repo is public.
const PR: PrKey = { owner: 'Acme', repo: 'Web', number: 7 };
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const VIEWER = 'sam-reviewer';

interface Call {
  name: string;
  vars: Record<string, string | string[]>;
}

interface World {
  author?: string;
  assignees?: string[];
  requested?: string[];
  /** Pending reviews on GitHub, by author. */
  pending?: { id: string; author: string }[];
  submitted?: { state: string; submittedAt: string; author: string; commit: string }[];
  /** Fail the named mutation with this stderr. */
  fail?: Partial<Record<keyof typeof MUTATIONS, string>>;
  threadPages?: unknown[][];
  calls: Call[];
}

const ALL_DOCS = new Map<string, string>([...Object.entries(QUERIES), ...Object.entries(MUTATIONS)].map(([k, v]) => [v, k]));

/** A fake `gh` that answers the compiled-in documents and records every call with its variables. */
function fakeGh(w: World): GhRunner {
  return async (args) => {
    const doc = args.find((a) => a.startsWith('query='))!.slice(6);
    const name = ALL_DOCS.get(doc);
    assert.ok(name, 'only compiled-in documents are ever sent');
    const vars: Record<string, string | string[]> = {};
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-f' || args[i] === '-F') && !args[i + 1].startsWith('query=')) {
        const [k, ...v] = args[i + 1].split('=');
        if (k.endsWith('[]')) ((vars[k.slice(0, -2)] ??= []) as string[]).push(v.join('='));
        else vars[k] = v.join('=');
      }
    }
    w.calls.push({ name, vars });
    const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: '' });
    const failure = w.fail?.[name as keyof typeof MUTATIONS];
    if (failure) return { code: 1, stdout: '', stderr: failure };
    switch (name) {
      case 'reviewContext':
        return ok({
          viewer: { login: VIEWER, id: 'U_viewer' },
          repository: {
            pullRequest: {
              id: 'PR_node',
              headRefOid: HEAD,
              url: 'https://github.com/acme/web/pull/7',
              author: { login: w.author ?? 'pat-author' },
              assignees: { nodes: (w.assignees ?? []).map((login) => ({ login })) },
              reviewRequests: { nodes: (w.requested ?? []).map((login) => ({ requestedReviewer: { __typename: 'User', login } })) },
              pending: { nodes: (w.pending ?? []).map((p) => ({ id: p.id, author: { login: p.author } })) },
              submitted: { nodes: (w.submitted ?? []).map((r) => ({ state: r.state, submittedAt: r.submittedAt, author: { login: r.author }, commit: { oid: r.commit } })) },
            },
          },
        });
      case 'reviewThreads': {
        const pages = w.threadPages ?? [[]];
        const index = vars.after ? Number(vars.after) : 0;
        const next = index + 1 < pages.length;
        return ok({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next, endCursor: next ? String(index + 1) : null }, nodes: pages[index] } } } });
      }
      case 'viewedFiles':
        return ok({ repository: { pullRequest: { files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ path: 'src/a.ts', viewerViewedState: 'VIEWED' }] } } } });
      case 'startReview':
        return ok({ addPullRequestReview: { pullRequestReview: { id: 'PRR_new' } } });
      case 'submitReview':
        return ok({ submitPullRequestReview: { pullRequestReview: { id: 'PRR_new', url: 'https://github.com/acme/web/pull/7#pullrequestreview-1', state: 'COMMENTED' } } });
      default:
        return ok({ [name]: { clientMutationId: null } });
    }
  };
}

function setup(world: Partial<World> = {}) {
  const w: World = { calls: [], ...world };
  const drafts = new DraftStore(openDb(':memory:'));
  const writer = new ReviewWriter(drafts, fakeGh(w));
  return { w, drafts, writer, names: () => w.calls.map((c) => c.name) };
}

const comment = (line: number, startLine?: number, headSha = HEAD) => ({
  headSha,
  anchor: { path: 'src/a.ts', side: 'RIGHT' as const, line, ...(startLine && { startLine }) },
  body: `About line ${line}`,
  origin: 'me' as const,
});

// --- drafts -------------------------------------------------------------------------

test('drafts are kept per PR, case-insensitively, and can be edited and deleted', () => {
  const { drafts } = setup();
  const id = drafts.save(PR, comment(3));
  drafts.save(PR, { headSha: HEAD, replyTo: 'PRRT_thread1', body: 'Thanks', origin: 'me' });
  drafts.save({ ...PR, owner: 'acme', repo: 'web' }, { ...comment(5), id, body: 'Edited' });
  const list = drafts.list(PR);
  assert.equal(list.comments.length, 2);
  assert.equal(list.comments[0].body, 'Edited');
  assert.deepEqual(list.comments[0].anchor, { path: 'src/a.ts', side: 'RIGHT', line: 5 });
  assert.equal(list.comments[1].replyTo, 'PRRT_thread1');
  drafts.delete(PR, id);
  assert.equal(drafts.list(PR).comments.length, 1);
  assert.equal(drafts.list({ ...PR, number: 8 }).comments.length, 0, 'other PRs are separate');
});

test('a draft is a comment or a reply, never both or neither, and has a cap', () => {
  const { drafts } = setup();
  assert.throws(() => drafts.save(PR, { headSha: HEAD, body: 'x', origin: 'me' }), ReviewWriteError);
  assert.throws(() => drafts.save(PR, { ...comment(1), replyTo: 'PRRT_x' }), ReviewWriteError);
  assert.throws(() => drafts.save(PR, { ...comment(1), body: '   ' }), ReviewWriteError);
  for (let i = 0; i < MAX_DRAFTS_PER_PR; i++) drafts.save(PR, comment(i + 1));
  assert.throws(() => drafts.save(PR, comment(1)), /can hold/);
});

// --- submit -------------------------------------------------------------------------

test('submit builds one pending review, adds every comment and reply, then submits it', async () => {
  const { drafts, writer, w, names } = setup();
  drafts.save(PR, comment(3));
  drafts.save(PR, comment(9, 7));
  drafts.save(PR, { headSha: OLD, replyTo: 'PRRT_thread1', body: 'Fixed in the next commit?', origin: 'me' });
  drafts.saveSummary(PR, 'Looks good', 'COMMENT');
  const result = await writer.submit(PR, HEAD, 'APPROVE', 'Ship it');
  assert.deepEqual(names(), ['reviewContext', 'startReview', 'addThread', 'addThread', 'addReply', 'submitReview']);
  assert.deepEqual(w.calls[1].vars, { pr: 'PR_node', commit: HEAD });
  assert.deepEqual(w.calls[2].vars, { review: 'PRR_new', path: 'src/a.ts', body: 'About line 3', line: '3', side: 'RIGHT' });
  assert.equal(w.calls[3].vars.startLine, '7');
  assert.equal(w.calls[3].vars.startSide, 'RIGHT');
  assert.deepEqual(w.calls[4].vars, { review: 'PRR_new', thread: 'PRRT_thread1', body: 'Fixed in the next commit?' });
  assert.deepEqual(w.calls[5].vars, { review: 'PRR_new', event: 'APPROVE', body: 'Ship it' });
  assert.deepEqual(result, { url: 'https://github.com/acme/web/pull/7#pullrequestreview-1', comments: 2, replies: 1 });
  assert.deepEqual(drafts.list(PR), { comments: [], summary: '', event: null }, 'sent drafts are gone');
  assert.equal(drafts.submission(PR), null);
});

test('a failure mid-submit deletes the pending review and keeps the drafts', async () => {
  const { drafts, writer, names } = setup({ fail: { addThread: 'gh: Resource not accessible by personal access token (HTTP 403)' } });
  drafts.save(PR, comment(3));
  await assert.rejects(writer.submit(PR, HEAD, 'COMMENT', ''), (err: unknown) => {
    assert.ok(err instanceof GhError);
    assert.equal(err.code, 'gh_write_denied');
    assert.match(err.fixSteps[0].command ?? '', /gh auth refresh .*--scopes repo/);
    return true;
  });
  assert.deepEqual(names(), ['reviewContext', 'startReview', 'addThread', 'deleteReview']);
  assert.equal(drafts.list(PR).comments.length, 1, 'nothing lost');
  assert.equal(drafts.submission(PR), null, 'the cleanup worked, so nothing is left to clean');
});

test('a pending review started on github.com is left alone', async () => {
  const { drafts, writer, names } = setup({ pending: [{ id: 'PRR_web', author: VIEWER }] });
  drafts.save(PR, comment(3));
  await assert.rejects(writer.submit(PR, HEAD, 'COMMENT', ''), (err: unknown) => err instanceof ReviewWriteError && err.code === 'review_pending_on_github');
  assert.deepEqual(names(), ['reviewContext'], 'no write at all');
});

test('our own leftover pending review (a crash mid-submit) is cleaned up first', async () => {
  const { drafts, writer, w, names } = setup({ pending: [{ id: 'PRR_left', author: VIEWER }] });
  drafts.save(PR, comment(3));
  drafts.setSubmission(PR, 'PRR_left');
  await writer.submit(PR, HEAD, 'COMMENT', '');
  assert.deepEqual(names(), ['reviewContext', 'deleteReview', 'startReview', 'addThread', 'submitReview']);
  assert.deepEqual(w.calls[1].vars, { review: 'PRR_left' });
});

test('submit refuses what GitHub would reject, before any network call', async () => {
  const { drafts, writer, names } = setup();
  await assert.rejects(writer.submit(PR, HEAD, 'COMMENT', '  '), /nothing to send/);
  await assert.rejects(writer.submit(PR, HEAD, 'REQUEST_CHANGES', ''), /needs a summary/);
  drafts.save(PR, comment(3, undefined, OLD));
  await assert.rejects(writer.submit(PR, HEAD, 'COMMENT', 'x'), /older commit/);
  assert.deepEqual(names(), []);
});

// --- immediate writes ------------------------------------------------------------------

test('assign me adds assignee and reviewer, skipping what is already true', async () => {
  let s = setup();
  await s.writer.assignMe(PR);
  assert.deepEqual(s.names(), ['reviewContext', 'assign', 'requestReview']);
  assert.deepEqual(s.w.calls[1].vars, { pr: 'PR_node', users: ['U_viewer'] });

  s = setup({ assignees: [VIEWER], requested: [VIEWER] });
  await s.writer.assignMe(PR);
  assert.deepEqual(s.names(), ['reviewContext']);

  s = setup({ author: VIEWER });
  await s.writer.assignMe(PR);
  assert.deepEqual(s.names(), ['reviewContext', 'assign'], 'GitHub refuses a review request from the author');
});

test('resolve and viewed go straight to GitHub', async () => {
  const { writer, w, names } = setup();
  await writer.resolve(PR, 'PRRT_thread1', true);
  await writer.resolve(PR, 'PRRT_thread1', false);
  await writer.markViewed(PR, 'src/a.ts', true);
  await writer.markViewed(PR, 'src/a.ts', false);
  assert.deepEqual(names(), ['resolveThread', 'unresolveThread', 'reviewContext', 'markViewed', 'reviewContext', 'unmarkViewed']);
  assert.deepEqual(w.calls[3].vars, { pr: 'PR_node', path: 'src/a.ts' });
});

// --- reads ---------------------------------------------------------------------------

const thread = (id: string, resolved = false) => ({
  id,
  path: 'src/a.ts',
  line: 4,
  startLine: null,
  originalLine: 4,
  diffSide: 'RIGHT',
  isResolved: resolved,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: true,
  viewerCanReply: true,
  comments: { nodes: [{ id: `${id}_c1`, author: { login: 'pat-author' }, body: 'Why?', createdAt: '2026-11-18T10:00:00Z', url: 'https://github.com/acme/web/pull/7#r1' }] },
});

test('threads page through, and the last review is my newest submitted one', async () => {
  const { writer } = setup({
    threadPages: [[thread('PRRT_1')], [thread('PRRT_2', true)]],
    submitted: [
      { state: 'COMMENTED', submittedAt: '2026-11-15T10:00:00Z', author: VIEWER, commit: OLD },
      { state: 'APPROVED', submittedAt: '2026-11-16T10:00:00Z', author: 'someone-else', commit: HEAD },
      { state: 'CHANGES_REQUESTED', submittedAt: '2026-11-17T10:00:00Z', author: 'SAM-REVIEWER', commit: HEAD },
    ],
  });
  const view = await writer.threads(PR);
  assert.deepEqual(view.threads.map((t) => t.id), ['PRRT_1', 'PRRT_2']);
  assert.equal(view.threads[0].comments[0].author, 'pat-author');
  assert.deepEqual(view.viewed, { 'src/a.ts': 'VIEWED' });
  assert.deepEqual(view.lastReview, { commit: HEAD, submittedAt: '2026-11-17T10:00:00Z', state: 'CHANGES_REQUESTED' });
  assert.equal(view.headSha, HEAD);
  assert.equal(view.assignedToMe, false);
});

// --- validation ----------------------------------------------------------------------

const msg = (extra: Record<string, unknown>) => ({ requestId: 'r1', pr: { owner: 'acme', repo: 'web', number: 7 }, ...extra });

test('review messages are validated at the socket', () => {
  const draft = { headSha: HEAD, anchor: { path: 'src/a.ts', side: 'RIGHT', line: 3 }, body: 'Hi', origin: 'me' };
  assert.equal(validateAppMessage(msg({ type: 'save_draft', draft })).type, 'save_draft');
  const bad: Record<string, unknown>[] = [
    { type: 'save_draft', draft: { ...draft, anchor: { ...draft.anchor, path: '../etc/passwd' } } },
    { type: 'save_draft', draft: { ...draft, replyTo: 'PRRT_1' } },
    { type: 'save_draft', draft: { ...draft, headSha: 'abc' } },
    { type: 'save_draft', draft: { ...draft, anchor: { ...draft.anchor, startLine: 9 } } },
    { type: 'save_draft', draft: { ...draft, body: 'x'.repeat(70_000) } },
    { type: 'save_draft', draft: { ...draft, origin: 'robot' } },
    { type: 'delete_draft', id: '../x' },
    { type: 'resolve_thread', threadId: '-x', resolved: true },
    { type: 'resolve_thread', threadId: 'PRRT_1', resolved: 'yes' },
    { type: 'mark_viewed', path: '/abs', viewed: true },
    { type: 'submit_review', headSha: HEAD, event: 'MERGE', summary: '' },
    { type: 'submit_review', headSha: 'main', event: 'APPROVE', summary: '' },
  ];
  for (const b of bad) assert.throws(() => validateAppMessage(msg(b)), ValidationError, JSON.stringify(b).slice(0, 120));
});

// --- router --------------------------------------------------------------------------

test('the router posts a review and reports failures with their fix', async () => {
  const sent: ServerMessage[] = [];
  const conn = { id: 'c1', transport: 'socket' as const, send: (m: ServerMessage) => sent.push(m) };
  const ok = setup();
  const router = createRouter({ adapters: {} as never, reviewWrite: { drafts: ok.drafts, writer: ok.writer } });
  router.handle(validateAppMessage(msg({ type: 'save_draft', draft: { headSha: HEAD, anchor: { path: 'src/a.ts', side: 'RIGHT', line: 3 }, body: 'Hi', origin: 'me' } })), conn);
  assert.equal(sent.at(-1)?.type, 'review_drafts');
  router.handle(validateAppMessage(msg({ type: 'submit_review', headSha: HEAD, event: 'COMMENT', summary: '' })), conn);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent.at(-1), { type: 'review_submitted', requestId: 'r1', pr: { owner: 'acme', repo: 'web', number: 7 }, event: 'COMMENT', url: 'https://github.com/acme/web/pull/7#pullrequestreview-1', comments: 1, replies: 0 });

  const denied = setup({ fail: { startReview: 'gh: Resource not accessible by personal access token (HTTP 403)' } });
  const router2 = createRouter({ adapters: {} as never, reviewWrite: { drafts: denied.drafts, writer: denied.writer } });
  denied.drafts.save({ owner: 'acme', repo: 'web', number: 7 }, comment(3));
  router2.handle(validateAppMessage(msg({ type: 'submit_review', headSha: HEAD, event: 'COMMENT', summary: '' })), conn);
  await new Promise((r) => setTimeout(r, 10));
  const last = sent.at(-1);
  assert.ok(last?.type === 'event' && last.event.type === 'error');
  assert.equal(last.event.code, 'gh_write_denied');
  assert.ok(last.event.fixSteps?.length);
});

test('mutations are separate from queries and never reachable as a query', () => {
  for (const doc of Object.values(QUERIES)) assert.ok(!/^\s*mutation\b/.test(doc), 'queries stay read-only');
  for (const doc of Object.values(MUTATIONS)) assert.match(doc, /^mutation Quack/);
});
