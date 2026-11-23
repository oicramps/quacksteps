import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentId, PrKey, ReviewState, ServerMessage } from '@quack/shared';
import type { Adapter, AdapterEvent, AskOpts } from '../src/adapters/types.ts';
import type { Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import type { LabelOps } from '../src/labels.ts';
import { ReviewAgent, ReviewAgentError, cleanComment, parseFindings, rightLines } from '../src/reviewagent.ts';
import { createRouter } from '../src/router.ts';
import { DraftStore } from '../src/reviewwrite.ts';
import { ValidationError, validateAppMessage } from '../src/validate.ts';

// Synthetic data only: this repo is public.
const PR: PrKey = { owner: 'acme', repo: 'web', number: 7 };
const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);
const config = { worktreeRoot: '/virtual', scanRoots: [], repoPaths: {}, retentionDays: 7, maxWorktrees: 20 } as unknown as Config;

const PATCH_A = '@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n const d = 5;\n';
const DIFF = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${PATCH_A}diff --git a/yarn.lock b/yarn.lock\n--- a/yarn.lock\n+++ b/yarn.lock\n@@ -1 +1 @@\n-x\n+y\n`;

const review = (over: Partial<ReviewState> = {}): ReviewState =>
  ({ startedAt: '2026-11-20T10:00:00Z', headSha: HEAD, latestHeadSha: HEAD, worktreePath: '/wt/web-7', phase: 'ready', labels: 'ready', ...over }) as ReviewState;

function fakeOps(locks: string[]): LabelOps {
  return {
    findClone: async () => ({ clone: '/clones/web', blockedRoots: [] }),
    context: async () => ({ baseSha: BASE, title: 'Cluster pins', body: 'Groups pins at low zoom.' }),
    numstat: async () => [
      { path: 'src/a.ts', added: 2, deleted: 1, binary: false },
      { path: 'yarn.lock', added: 1, deleted: 1, binary: false },
    ],
    diff: async () => DIFF,
    readStart: async () => 'const a = 1;',
    read: async (_c, dir, sha) => {
      locks.push(`lock ${dir}@${sha[0]}`);
      return async () => void locks.push('release');
    },
  };
}

/** An agent that answers each turn from `replies`, and records the prompts. */
function fakeAgent(replies: string[], prompts: string[], tools: string[] = []): Record<AgentId, Adapter> {
  const adapter: Adapter = {
    id: 'cursor',
    label: 'Cursor',
    isAvailable: async () => ({ id: 'cursor', label: 'Cursor', state: 'ready', models: [], fixSteps: [] }),
    async *ask(opts: AskOpts): AsyncIterable<AdapterEvent> {
      prompts.push(opts.prompt);
      yield { type: 'session', sessionId: 's-1' };
      for (const t of tools) yield { type: 'tool', summary: t };
      yield { type: 'text', delta: replies.shift() ?? '' };
    },
  };
  return { cursor: adapter, 'claude-code': adapter };
}

function setup(replies: string[], opts: { review?: ReviewState | undefined; tools?: string[] } = {}) {
  const locks: string[] = [];
  const prompts: string[] = [];
  const drafts = new DraftStore(openDb(':memory:'));
  const agent = new ReviewAgent({
    drafts,
    review: () => ('review' in opts ? opts.review : review()),
    adapters: fakeAgent(replies, prompts, opts.tools),
    ops: fakeOps(locks),
    config: () => config,
  });
  return { agent, drafts, locks, prompts };
}

const anchor = { path: 'src/a.ts', side: 'RIGHT' as const, line: 3, startLine: 2 };

// --- helpers --------------------------------------------------------------------------

test('right-side lines of a patch: added and context, not removed', () => {
  assert.deepEqual([...rightLines(PATCH_A)], [1, 2, 3, 4]);
  assert.deepEqual([...rightLines('@@ -10,2 +20,2 @@\n-old\n+new\n same\n')], [20, 21]);
});

test('comment text loses fences, quotes and a preamble line', () => {
  assert.equal(cleanComment('```markdown\nCould `b` be a constant?\n```'), 'Could `b` be a constant?');
  assert.equal(cleanComment('"Why 3?"'), 'Why 3?');
  assert.equal(cleanComment("Here's the comment:\nWhy 3?"), 'Why 3?');
});

test('findings outside the diff are dropped, duplicates too, and at most five kept', () => {
  const lines = new Map([['src/a.ts', new Set([1, 2, 3, 4])]]);
  const reply = JSON.stringify({
    findings: [
      { path: 'src/a.ts', line: 3, comment: 'Is `c` tested?' },
      { path: 'src/a.ts', line: 3, comment: 'Same line again' },
      { path: 'src/a.ts', line: 99, comment: 'Not in the diff' },
      { path: 'yarn.lock', line: 1, comment: 'Not a checked file' },
      { path: 'src/a.ts', line: '2', comment: 'Line as a string' },
      ...[1, 2, 4].map((line) => ({ path: 'src/a.ts', line, comment: `About ${line}` })),
    ],
  });
  const found = parseFindings(`Sure:\n${reply}`, lines);
  assert.deepEqual(found.map((f) => [f.path, f.line, f.body]), [
    ['src/a.ts', 3, 'Is `c` tested?'],
    ['src/a.ts', 1, 'About 1'],
    ['src/a.ts', 2, 'About 2'],
    ['src/a.ts', 4, 'About 4'],
  ]);
  assert.throws(() => parseFindings('no json here', lines), /no JSON/);
});

// --- turn into comment ----------------------------------------------------------------

test('turn into comment rewrites the answer in the worktree, under a read lock', async () => {
  const t = setup(['```\nCould `b` stay 2? Callers still expect it.\n```']);
  const body = await t.agent.draftComment(PR, { agent: 'cursor', model: '', headSha: HEAD, anchor, lines: '+const b = 3;', question: 'Why 3?', answer: 'Because the new grid…' });
  assert.equal(body, 'Could `b` stay 2? Callers still expect it.');
  assert.deepEqual(t.locks, ['lock /wt/web-7@a', 'release']);
  assert.match(t.prompts[0], /File: src\/a\.ts, lines 2–3 \(new side\)/);
  assert.match(t.prompts[0], /<question>\nWhy 3\?\n<\/question>/);
  assert.match(t.prompts[0], /Never mention an AI/);
});

test('turn into comment needs a ready review at that commit', async () => {
  await assert.rejects(setup([], { review: undefined }).agent.draftComment(PR, { agent: 'cursor', model: '', headSha: HEAD, anchor, question: 'q', answer: 'a' }), /Start reviewing/);
  await assert.rejects(setup([], { review: review({ headSha: BASE }) }).agent.draftComment(PR, { agent: 'cursor', model: '', headSha: HEAD, anchor, question: 'q', answer: 'a' }), /another commit/);
  await assert.rejects(setup(['   ']).agent.draftComment(PR, { agent: 'cursor', model: '', headSha: HEAD, anchor, question: 'q', answer: 'a' }), /empty comment/);
});

// --- gap check ------------------------------------------------------------------------

test('gap check leaves lock files out, sends the pending comments, and repairs a bad reply once', async () => {
  const good = JSON.stringify({ findings: [{ path: 'src/a.ts', line: 4, comment: 'Is there a test for `c`?' }] });
  const t = setup(['I think there are issues.', good], { tools: ['Read File src/a.ts'] });
  t.drafts.save(PR, { headSha: HEAD, anchor: { path: 'src/a.ts', side: 'RIGHT', line: 3 }, body: 'Why 3?', origin: 'me' });
  const tools: string[] = [];
  const r = await t.agent.gapCheck(PR, { agent: 'cursor', model: '', headSha: HEAD }, (s) => tools.push(s));
  assert.deepEqual(r.findings.map((f) => [f.path, f.line, f.body]), [['src/a.ts', 4, 'Is there a test for `c`?']]);
  assert.equal(r.checkedFiles, 1);
  assert.deepEqual(r.skipped.map((s) => s.path), ['yarn.lock']);
  assert.equal(t.prompts.length, 2, 'one repair turn');
  assert.match(t.prompts[0], /- src\/a\.ts:3: Why 3\?/);
  assert.ok(!t.prompts[0].includes('yarn.lock'), 'skipped files stay out of the prompt');
  assert.deepEqual(tools, ['Read File src/a.ts', 'Read File src/a.ts']);
  assert.deepEqual(t.locks, ['lock /wt/web-7@a', 'release']);
});

test('gap check fails cleanly when even the repair does not parse, and runs once per PR at a time', async () => {
  const t = setup(['nope', 'still nope']);
  await assert.rejects(t.agent.gapCheck(PR, { agent: 'cursor', model: '', headSha: HEAD }), (err: unknown) => err instanceof ReviewAgentError && err.code === 'agent_failed');
  assert.deepEqual(t.locks, ['lock /wt/web-7@a', 'release'], 'the lock is released on failure');

  const slow = setup([JSON.stringify({ findings: [] })]);
  const first = slow.agent.gapCheck(PR, { agent: 'cursor', model: '', headSha: HEAD });
  await assert.rejects(slow.agent.gapCheck(PR, { agent: 'cursor', model: '', headSha: HEAD }), /already running/);
  assert.deepEqual((await first).findings, []);
});

// --- socket ---------------------------------------------------------------------------

const msg = (extra: Record<string, unknown>) => ({ requestId: 'g1', pr: PR, agent: 'cursor', model: '', headSha: HEAD, ...extra });

test('agent help requests are validated', () => {
  assert.equal(validateAppMessage(msg({ type: 'gap_check' })).type, 'gap_check');
  assert.equal(validateAppMessage(msg({ type: 'draft_comment', anchor, question: 'q', answer: 'a' })).type, 'draft_comment');
  for (const bad of [
    { type: 'gap_check', agent: 'robot' },
    { type: 'gap_check', headSha: 'main' },
    { type: 'gap_check', model: '--yolo' },
    { type: 'draft_comment', anchor: { ...anchor, path: '../x' }, question: 'q', answer: 'a' },
    { type: 'draft_comment', anchor, question: 'q', answer: 'x'.repeat(100_001) },
  ]) {
    assert.throws(() => validateAppMessage(msg(bad)), ValidationError, JSON.stringify(bad).slice(0, 80));
  }
});

test('the router streams gap check activity, then the findings', async () => {
  const t = setup([JSON.stringify({ findings: [{ path: 'src/a.ts', line: 2, comment: 'Why change `b`?' }] })], { tools: ['Read File src/a.ts'] });
  const sent: ServerMessage[] = [];
  const router = createRouter({ adapters: {} as never, reviewAgent: t.agent });
  router.handle(validateAppMessage(msg({ type: 'gap_check' })), { id: 'c1', transport: 'socket', send: (m) => sent.push(m) });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.map((m) => (m.type === 'event' ? `event:${m.event.type}` : m.type)), ['event:tool', 'gap_check']);
  const last = sent.at(-1);
  assert.ok(last?.type === 'gap_check');
  assert.equal(last.findings[0].body, 'Why change `b`?');
  assert.equal(last.checkedFiles, 1);
});
