import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskRequest, CompanionMessage, PrKey, StoredTurn } from '@quacksteps/shared';
import type { Adapter, AdapterEvent } from '../src/adapters/types.ts';
import { Slots, limitAgents } from '../src/adapters/limit.ts';
import { openDb } from '../src/db.ts';
import { parseGhAuthStatus, probeServer } from '../src/doctor.ts';
import { recordTurns } from '../src/router.ts';
import { MAX_TURNS_PER_PR, ThreadStore } from '../src/threads.ts';

// Synthetic data only: this repo is public.
const PR: PrKey = { owner: 'Acme', repo: 'Web', number: 7 };
const A = 'a'.repeat(40);

const turn = (question: string, askedAt = '2026-11-18T10:00:00.000Z'): StoredTurn => ({
  question,
  answer: `about ${question}`,
  agent: 'cursor',
  model: '',
  sessionId: null,
  headSha: A,
  selections: [],
  askedAt,
});

const ask: AskRequest = {
  type: 'ask',
  requestId: 'r1',
  agent: 'cursor',
  model: 'fast',
  pr: { owner: 'Acme', repo: 'Web', number: 7, headSha: A },
  selections: [{ path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4 }],
  question: 'Why this change?',
  sessionId: null,
};

// --- threads ---------------------------------------------------------------------

test('threads are stored per PR, oldest first, case-insensitively', () => {
  const store = new ThreadStore(openDb(':memory:'));
  store.add(PR, turn('one'));
  store.add({ ...PR, owner: 'acme', repo: 'web' }, turn('two'));
  store.add({ ...PR, number: 8 }, turn('other PR'));
  assert.deepEqual(store.list(PR).map((t) => t.question), ['one', 'two']);
  assert.deepEqual(store.list({ ...PR, number: 9 }), []);
});

test('a thread keeps its newest turns only', () => {
  const store = new ThreadStore(openDb(':memory:'));
  for (let i = 0; i < MAX_TURNS_PER_PR + 5; i++) store.add(PR, turn(`q${i}`));
  const turns = store.list(PR);
  assert.equal(turns.length, MAX_TURNS_PER_PR);
  assert.equal(turns[0].question, 'q5');
});

test('threads quiet for 30 days are dropped whole; active ones are kept whole', () => {
  const store = new ThreadStore(openDb(':memory:'), () => new Date('2026-11-18T00:00:00Z'));
  store.add(PR, turn('old', '2026-09-01T00:00:00.000Z'));
  store.add({ ...PR, number: 8 }, turn('old but continued', '2026-09-01T00:00:00.000Z'));
  store.add({ ...PR, number: 8 }, turn('recent', '2026-11-10T00:00:00.000Z'));
  assert.equal(store.prune(), 1);
  assert.deepEqual(store.list(PR), []);
  assert.equal(store.list({ ...PR, number: 8 }).length, 2);
});

test('a finished ask is recorded with its streamed answer, commit, model and session', () => {
  const store = new ThreadStore(openDb(':memory:'));
  const sent: CompanionMessage[] = [];
  const send = recordTurns(ask, (m) => sent.push(m), store, () => new Date('2026-11-18T09:00:00Z'));
  send({ type: 'progress', requestId: 'r1', step: 'thinking' });
  send({ type: 'event', requestId: 'r1', event: { type: 'text', delta: 'Because ' } });
  send({ type: 'event', requestId: 'r1', event: { type: 'text', delta: 'reasons.' } });
  assert.deepEqual(store.list(PR), [], 'nothing stored before done');
  send({ type: 'event', requestId: 'r1', event: { type: 'done', sessionId: 's1', headSha: A, model: 'fast-1' } });
  assert.equal(sent.length, 4, 'every message still reaches the client');
  assert.deepEqual(store.list(PR), [
    { question: 'Why this change?', answer: 'Because reasons.', agent: 'cursor', model: 'fast-1', sessionId: 's1', headSha: A, selections: ask.selections, askedAt: '2026-11-18T09:00:00.000Z' },
  ]);
});

test('failed and stopped asks are not recorded', () => {
  const store = new ThreadStore(openDb(':memory:'));
  const send = recordTurns(ask, () => {}, store);
  send({ type: 'event', requestId: 'r1', event: { type: 'text', delta: 'partial' } });
  send({ type: 'event', requestId: 'r1', event: { type: 'error', code: 'cancelled', message: 'Stopped.' } });
  assert.deepEqual(store.list(PR), []);
});

// --- the agent limit -------------------------------------------------------------

test('slots are handed out in order and a cancelled waiter gives up its place', async () => {
  const slots = new Slots(1);
  const first = await slots.acquire();
  const order: string[] = [];
  const ac = new AbortController();
  const cancelled = slots.acquire(ac.signal).then(() => order.push('cancelled one'), () => order.push('gave up'));
  const second = slots.acquire().then((release) => (order.push('second'), release));
  ac.abort();
  await cancelled;
  first();
  (await second)();
  assert.deepEqual(order, ['gave up', 'second']);
  assert.equal(slots.available, 1);
});

test('at most N agent turns run at once across adapters; the rest wait and say so', async () => {
  let running = 0;
  let peak = 0;
  const gates: (() => void)[] = [];
  const slow = (id: 'cursor' | 'claude-code'): Adapter => ({
    id,
    label: id,
    isAvailable: async () => ({ id, label: id, state: 'ready', models: [], fixSteps: [] }),
    async *ask(): AsyncIterable<AdapterEvent> {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => gates.push(r));
      running--;
      yield { type: 'text', delta: 'ok' };
    },
  });
  const limited = limitAgents({ cursor: slow('cursor'), 'claude-code': slow('claude-code') }, new Slots(2));
  const collect = async (a: Adapter) => {
    const events: AdapterEvent[] = [];
    for await (const e of a.ask({ cwd: '/', prompt: '', model: '', sessionId: null, signal: new AbortController().signal })) events.push(e);
    return events;
  };
  const turns = [collect(limited.cursor), collect(limited['claude-code']), collect(limited.cursor)];
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(running, 2);
  while (gates.length || running) {
    gates.shift()?.();
    await new Promise((r) => setTimeout(r, 5));
  }
  const results = await Promise.all(turns);
  assert.equal(peak, 2);
  assert.deepEqual(results[2][0], { type: 'tool', summary: 'Waiting: other agent turns are running' });
  assert.ok(results.every((r) => r.some((e) => e.type === 'text')));
});

test('a turn cancelled while waiting for a slot ends quietly without starting the agent', async () => {
  let started = 0;
  const adapter: Adapter = {
    id: 'cursor',
    label: 'c',
    isAvailable: async () => ({ id: 'cursor', label: 'c', state: 'ready', models: [], fixSteps: [] }),
    async *ask() {
      started++;
    },
  };
  const slots = new Slots(1);
  const hold = await slots.acquire();
  const { cursor } = limitAgents({ cursor: adapter }, slots);
  const ac = new AbortController();
  const events: AdapterEvent[] = [];
  const done = (async () => {
    for await (const e of cursor.ask({ cwd: '/', prompt: '', model: '', sessionId: null, signal: ac.signal })) events.push(e);
  })();
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await done;
  hold();
  assert.equal(started, 0);
  assert.equal(events.length, 1, 'only the waiting notice');
});

// --- doctor ----------------------------------------------------------------------

test('gh auth status is read for the account, never the token', () => {
  const out = 'github.com\n  ✓ Logged in to github.com account octo-cat (keyring)\n  - Active account: true\n  - Token: gho_************************************\n';
  assert.deepEqual(parseGhAuthStatus(out, 0), { loggedIn: true, account: 'octo-cat' });
  assert.deepEqual(parseGhAuthStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login', 1), { loggedIn: false, account: null });
});

test('doctor reports a missing server without hanging', async () => {
  const probe = await probeServer('/nonexistent/quack.sock', 500);
  assert.deepEqual(probe, { running: false, reason: 'no socket (the server is not running)' });
});
