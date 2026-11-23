// M0 runtime parity: the process and stream behaviour quackd relies on must match under Node and Bun.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { test } from 'node:test';
import { killTree, spawnStreaming } from '../src/exec.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

test('a detached child leads its own process group and session', async () => {
  const child = spawnStreaming('/bin/sh', ['-c', 'sleep 30'], process.cwd());
  try {
    assert.ok(child.pid);
    const [pgid, sid] = execFileSync('ps', ['-o', 'pgid=,sess=', '-p', String(child.pid)], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.equal(pgid, child.pid, 'child is its own process group leader');
    assert.notEqual(pgid, Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()));
    assert.ok(Number.isFinite(sid));
  } finally {
    killTree(child);
  }
});

test('killTree kills grandchildren through the process group', async () => {
  // The shell starts a background grandchild and prints its pid, then waits.
  const child = spawnStreaming('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], process.cwd());
  const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const grandchild = await new Promise<number>((resolve) => lines.once('line', (l) => resolve(Number(l))));
  assert.ok(alive(grandchild), 'grandchild started');
  killTree(child);
  assert.ok(await waitFor(() => !alive(grandchild)), 'grandchild was killed with the group');
  assert.ok(await waitFor(() => child.exitCode !== null || child.signalCode !== null), 'child exited');
});

test('readline yields every line of child stdout, including a final unterminated one', async () => {
  const child = spawnStreaming('/bin/sh', ['-c', 'printf "a\\nb\\r\\nc"'], process.cwd());
  const got: string[] = [];
  for await (const line of readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })) got.push(line);
  assert.deepEqual(got, ['a', 'b', 'c']);
});

test('AbortSignal.any aborts with the first source and keeps its reason', async () => {
  const outer = new AbortController();
  const timeout = AbortSignal.timeout(50);
  const combined = AbortSignal.any([outer.signal, timeout]);
  await new Promise((r) => combined.addEventListener('abort', r, { once: true }));
  assert.equal((combined.reason as Error).name, 'TimeoutError');

  const outer2 = new AbortController();
  const combined2 = AbortSignal.any([outer2.signal, AbortSignal.timeout(10_000)]);
  outer2.abort(new Error('user cancelled'));
  assert.ok(combined2.aborted);
  assert.equal((combined2.reason as Error).message, 'user cancelled');
});
