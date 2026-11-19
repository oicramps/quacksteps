import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireRead, acquireWrite, lockState } from '../src/rwlock.ts';
import { endRead, readWorktreeAt, worktreeHead } from '../src/worktree.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));
let n = 0;
const dir = () => `/virtual/wt-${++n}`;

test('several readers hold the tree at once', async () => {
  const d = dir();
  const [a, b, c] = await Promise.all([acquireRead(d), acquireRead(d), acquireRead(d)]);
  assert.equal(lockState(d).readers, 3);
  a();
  b();
  c();
  assert.equal(lockState(d).readers, 0);
});

test('a writer waits for every reader to finish', async () => {
  const d = dir();
  const r1 = await acquireRead(d);
  const r2 = await acquireRead(d);
  let wrote = false;
  const w = acquireWrite(d).then((release) => {
    wrote = true;
    return release;
  });
  await tick();
  assert.equal(wrote, false);
  r1();
  await tick();
  assert.equal(wrote, false, 'one reader still active');
  r2();
  (await w)();
  assert.equal(wrote, true);
});

test('new readers queue behind a waiting writer, so a writer is never starved', async () => {
  const d = dir();
  const order: string[] = [];
  const r1 = await acquireRead(d);
  const w = acquireWrite(d).then((release) => (order.push('write'), release));
  const r2 = acquireRead(d).then((release) => (order.push('read2'), release));
  await tick();
  assert.deepEqual(lockState(d).waiting, ['write', 'read']);
  r1();
  (await w)();
  (await r2)();
  assert.deepEqual(order, ['write', 'read2']);
});

test('readers queued together behind a writer are let in together', async () => {
  const d = dir();
  const w = await acquireWrite(d);
  const readers = [acquireRead(d), acquireRead(d)];
  await tick();
  w();
  const released = await Promise.all(readers);
  assert.equal(lockState(d).readers, 2);
  released.forEach((r) => r());
});

test('cancelling a queued writer lets the readers behind it in', async () => {
  const d = dir();
  const r1 = await acquireRead(d);
  const ac = new AbortController();
  const w = acquireWrite(d, ac.signal);
  const r2 = acquireRead(d);
  await tick();
  ac.abort();
  await assert.rejects(w, /cancelled/);
  (await r2)();
  r1();
});

test('an already cancelled request is refused without queueing', async () => {
  const d = dir();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(acquireRead(d, ac.signal), /cancelled/);
  assert.deepEqual(lockState(d).waiting, []);
});

// --- against a real git repo -----------------------------------------------------

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Quack Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Quack Test', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repoWithTwoCommits() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-rw-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'file'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'one']);
  const a = git(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'file'), 'two\n');
  git(repo, ['commit', '-qam', 'two']);
  const b = git(repo, ['rev-parse', 'HEAD']);
  return { root, repo, wt: path.join(root, 'wt'), a, b };
}

test('readWorktreeAt checks out lazily, then shares the tree between readers', async () => {
  const { root, repo, wt, a } = repoWithTwoCommits();
  try {
    const signal = new AbortController().signal;
    const [r1, r2] = await Promise.all([readWorktreeAt(repo, wt, a, signal, { prepare: true }), readWorktreeAt(repo, wt, a, signal, { prepare: true })]);
    assert.equal(await worktreeHead(wt), a);
    assert.equal(lockState(wt).readers, 2);
    r1();
    r2();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a review worktree is never moved by a reader', async () => {
  const { root, repo, wt, a, b } = repoWithTwoCommits();
  try {
    const signal = new AbortController().signal;
    (await readWorktreeAt(repo, wt, a, signal, { prepare: true }))();
    await assert.rejects(readWorktreeAt(repo, wt, b, signal, { prepare: false }), /not at/);
    assert.equal(await worktreeHead(wt), a);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changes a reader leaves (ignored files included) are discarded only after the other readers finish', async () => {
  const { root, repo, wt, a } = repoWithTwoCommits();
  try {
    const signal = new AbortController().signal;
    const r1 = await readWorktreeAt(repo, wt, a, signal, { prepare: true });
    const r2 = await readWorktreeAt(repo, wt, a, signal, { prepare: true });
    const baseline = new Set<string>();

    // Reader 1 "writes" a tracked change and an ignored directory, then ends.
    fs.writeFileSync(path.join(wt, 'file'), 'tampered\n');
    fs.mkdirSync(path.join(wt, 'node_modules'));
    fs.writeFileSync(path.join(wt, 'node_modules', 'x.js'), '');
    const changed = await endRead(wt, r1, baseline);
    assert.equal(changed.length, 2);
    assert.equal(lockState(wt).dirty, true);

    await tick();
    assert.equal(fs.readFileSync(path.join(wt, 'file'), 'utf8'), 'tampered\n', 'not reset while reader 2 is active');

    r2();
    for (let i = 0; i < 100 && lockState(wt).dirty; i++) await tick();
    for (let i = 0; i < 100 && fs.existsSync(path.join(wt, 'node_modules')); i++) await tick();
    assert.equal(fs.readFileSync(path.join(wt, 'file'), 'utf8'), 'one\n');
    assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
