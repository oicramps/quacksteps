import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { unlinkEscapingSymlinks } from '../src/worktree.ts';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Quack Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Quack Test', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });

test('a chain of in-tree-looking symlinks that really escapes is removed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-links-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside');
    fs.writeFileSync(path.join(repo, 'ok.txt'), 'inside');
    // r points at the repo root (inside); x reads "a/b/r/../secret.txt", which looks like a/b/secret.txt
    // on paper, but the kernel follows r to the root and then .. leaves the repo.
    fs.symlinkSync('../..', path.join(repo, 'a', 'b', 'r'));
    fs.symlinkSync('a/b/r/../secret.txt', path.join(repo, 'x'));
    fs.symlinkSync('ok.txt', path.join(repo, 'fine'));
    fs.symlinkSync('../secret.txt', path.join(repo, 'plain'));
    fs.symlinkSync('missing.txt', path.join(repo, 'dangling'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'links']);
    assert.equal(fs.readFileSync(path.join(repo, 'x'), 'utf8'), 'outside', 'precondition: x really escapes');

    const removed = await unlinkEscapingSymlinks(repo);
    assert.equal(removed, 3);
    assert.equal(fs.existsSync(path.join(repo, 'x')), false, 'the chained escape is gone');
    assert.equal(fs.lstatSync(path.join(repo, 'plain'), { throwIfNoEntry: false }), undefined, 'a plain escape is gone');
    assert.equal(fs.lstatSync(path.join(repo, 'dangling'), { throwIfNoEntry: false }), undefined, 'a link that resolves nowhere is gone');
    assert.equal(fs.readFileSync(path.join(repo, 'fine'), 'utf8'), 'inside', 'an honest in-tree link stays');
    assert.ok(fs.lstatSync(path.join(repo, 'a', 'b', 'r')).isSymbolicLink(), 'r itself resolves inside and stays');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
