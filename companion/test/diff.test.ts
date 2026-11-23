import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { PrKey } from '@quacksteps/shared';
import type { Config } from '../src/config.ts';
import { DiffError, type DiffOps, DiffService, MAX_FILE_PATCH, filesFromGit, filesFromRest, realDiffOps } from '../src/diff.ts';
import { REST, restGet } from '../src/gh.ts';
import { parseNumstat } from '../src/labels.ts';

// Synthetic data only: this repo is public.
const PR: PrKey = { owner: 'Acme', repo: 'Web', number: 7 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const config = { worktreeRoot: '/virtual', scanRoots: [], repoPaths: {}, retentionDays: 7, maxWorktrees: 20 } as unknown as Config;

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Quack Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Quack Test', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

test('real git output: added, modified, deleted, renamed and binary files', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-diff-'));
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'one\n');
    fs.writeFileSync(path.join(repo, 'gone.ts'), 'bye\n');
    fs.writeFileSync(path.join(repo, 'old name.ts'), 'a\nb\nc\nd\ne\nf\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'one\ntwo\n');
    fs.rmSync(path.join(repo, 'gone.ts'));
    fs.renameSync(path.join(repo, 'old name.ts'), path.join(repo, 'new name.ts'));
    fs.writeFileSync(path.join(repo, 'new.ts'), 'hi\n');
    fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0, 1, 2, 0, 255]));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'head']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    const numstat = await realDiffOps.gitDiff(repo, ['--numstat', '-z'], base, head);
    const diff = await realDiffOps.gitDiff(repo, [], base, head);
    const files = new Map(filesFromGit(parseNumstat(numstat), diff).map((f) => [f.path, f]));

    assert.deepEqual([...files.keys()].sort(), ['gone.ts', 'keep.ts', 'logo.png', 'new name.ts', 'new.ts']);
    assert.equal(files.get('keep.ts')!.status, 'modified');
    assert.match(files.get('keep.ts')!.patch!, /^@@ .* @@\n one\n\+two\n$/);
    assert.equal(files.get('gone.ts')!.status, 'deleted');
    assert.equal(files.get('new.ts')!.status, 'added');
    assert.deepEqual([files.get('new name.ts')!.status, files.get('new name.ts')!.oldPath], ['renamed', 'old name.ts']);
    assert.equal(files.get('logo.png')!.binary, true);
    assert.equal(files.get('logo.png')!.patch, undefined);
    assert.ok([...files.values()].every((f) => !f.truncated));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('oversized patches are dropped and flagged truncated', () => {
  const huge = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1 @@\n+${'x'.repeat(MAX_FILE_PATCH)}\n`;
  const [f] = filesFromGit([{ path: 'big.ts', added: 1, deleted: 0, binary: false }], huge);
  assert.equal(f.patch, undefined);
  assert.equal(f.truncated, true);
});

test('REST fallback lines map GitHub statuses, renames and missing patches', () => {
  const out = [
    { filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
    { filename: 'b.ts', previous_filename: 'old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null },
    { filename: 'c.ts', status: 'removed', additions: 0, deletions: 3, patch: '@@ -1,3 +0,0 @@' },
    { filename: 'img.png', status: 'added', additions: 0, deletions: 0, patch: null },
    { filename: 'huge.json', status: 'modified', additions: 90000, deletions: 0, patch: null },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n');
  const files = filesFromRest(out);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.binary, f.truncated, f.oldPath ?? null]),
    [
      ['a.ts', 'modified', false, false, null],
      ['b.ts', 'renamed', false, false, 'old.ts'],
      ['c.ts', 'deleted', false, false, null],
      ['img.png', 'added', true, false, null],
      ['huge.json', 'modified', false, true, null],
    ],
  );
});

test('restGet only reads the fixed PR paths, with GET pinned', async () => {
  const calls: string[][] = [];
  const runner = async (args: string[]) => (calls.push(args), { code: 0, stdout: '{}', stderr: '' });
  await restGet(REST.pullFiles('acme', 'web', 7), { paginate: true }, runner);
  assert.deepEqual(calls[0].slice(0, 6), ['api', '--hostname', 'github.com', '-X', 'GET', 'repos/acme/web/pulls/7/files?per_page=100']);
  await assert.rejects(restGet('repos/acme/web/issues/7/comments', {}, runner), /refusing/);
  await assert.rejects(restGet('graphql', {}, runner), /refusing/);
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  await restGet(REST.compare('acme', 'web', a, b), {}, runner);
  await assert.rejects(restGet(`repos/acme/web/compare/main...${b}`, {}, runner), /refusing/, 'compare takes full SHAs only');
  assert.equal(REST.pull('ac/me', 'w?b', 1), 'repos/ac%2Fme/w%3Fb/pulls/1');
});

function service(over: Partial<DiffOps> = {}) {
  const calls: string[] = [];
  const ops: DiffOps = {
    findClone: async () => ({ clone: '/clones/web', blockedRoots: [] }),
    context: async (_c, _pr, headSha) => (calls.push(`context ${headSha?.[0] ?? 'latest'}`), { baseSha: 'c'.repeat(40), headSha: headSha ?? B }),
    gitDiff: async (_c, args) => (args.includes('--numstat') ? '1\t0\ta.ts\0' : 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n'),
    rest: async (p) => (calls.push(`rest ${p}`), p.endsWith('per_page=100') ? JSON.stringify({ filename: 'a.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ +1 @@\n+x' }) : JSON.stringify({ head: B, base: A })),
    ...over,
  };
  return { svc: new DiffService({ config: () => config, ops }), calls };
}

test('with a clone, the diff comes from git at the commit asked for, and is cached by commit', async () => {
  const t = service();
  const d = await t.svc.get(PR, A);
  assert.deepEqual([d.source, d.headSha, d.files[0].patch], ['git', A, '@@ -0,0 +1 @@\n+x\n']);
  await t.svc.get({ ...PR, owner: 'acme' }, A);
  assert.deepEqual(t.calls, ['context a'], 'second request served from cache');
  assert.equal((await t.svc.get(PR)).headSha, B, 'no commit asked: the latest head');
});

test('without a clone, GitHub serves the latest head; an older commit needs a clone', async () => {
  const t = service({ findClone: async () => ({ clone: null, blockedRoots: [] }) });
  const d = await t.svc.get(PR);
  assert.deepEqual([d.source, d.baseSha, d.headSha, d.files.length], ['github', A, B, 1]);
  await assert.rejects(t.svc.get(PR, A), (err: unknown) => err instanceof DiffError && err.code === 'repo_not_found' && /needs a local clone/.test(err.message));
});

test('a failed fetch says how to check git access', async () => {
  const t = service({
    context: async () => {
      throw new Error('could not read from remote');
    },
  });
  await assert.rejects(t.svc.get(PR, A), (err: unknown) => err instanceof DiffError && err.code === 'fetch_failed' && /git -C/.test(err.fixSteps[0].command!));
});

test('since my last review: only what changed after that commit, from real git', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-since-'));
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'one\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'two\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'one\nreviewed\n');
    git(repo, ['commit', '-qam', 'reviewed']);
    const reviewed = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'b.ts'), 'two\nlater\n');
    git(repo, ['commit', '-qam', 'later 1']);
    fs.writeFileSync(path.join(repo, 'c.ts'), 'new\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'later 2']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    const svc = new DiffService({
      config: () => config,
      ops: { ...realDiffOps, findClone: async () => ({ clone: repo, blockedRoots: [] }), context: async () => ({ baseSha: base, headSha: head }) },
    });
    const since = await svc.get(PR, head, reviewed);
    assert.deepEqual(since.files.map((f) => f.path).sort(), ['b.ts', 'c.ts'], 'a.ts was already reviewed');
    assert.deepEqual(since.since, { sha: reviewed, commits: 2 });
    const all = await svc.get(PR, head);
    assert.deepEqual(all.files.map((f) => f.path).sort(), ['a.ts', 'b.ts', 'c.ts']);
    assert.equal(all.since, undefined);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('since my last review without the commit locally falls back to GitHub compare', async () => {
  const calls: string[] = [];
  const t = service({
    countCommits: async () => null,
    rest: async (p) => {
      calls.push(p);
      return `{"commits":3}\n${JSON.stringify({ filename: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n two\n+later' })}`;
    },
  });
  const d = await t.svc.get(PR, B, A);
  assert.deepEqual(calls, [REST.compare('Acme', 'Web', A, B)]);
  assert.deepEqual([d.files.map((f) => f.path), d.since], [['b.ts'], { sha: A, commits: 3 }]);
});
