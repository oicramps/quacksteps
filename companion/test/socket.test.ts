import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AgentId, AgentStatus } from '@quack/shared';
import { SOCKET_PROTOCOL_VERSION } from '@quack/shared';
import type { Adapter } from '../src/adapters/types.ts';
import { MessageDecoder, encodeMessage } from '../src/framing.ts';
import { createRouter } from '../src/router.ts';
import { acquireInstanceLock, releaseInstanceLock } from '../src/serve.ts';
import { startSocketServer } from '../src/socket.ts';
import { ValidationError, validateAppMessage, validateMessage } from '../src/validate.ts';

// Unix socket paths are limited to ~104 bytes on macOS, so keep the temp dir short.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const sockPath = () => path.join(root, `run${++n}`, 'q.sock');

const fakeAdapter = (id: AgentId, state: AgentStatus['state'] = 'ready'): Adapter => ({
  id,
  label: id,
  async isAvailable() {
    return { id, label: id, state, models: [''], fixSteps: [] };
  },
  async *ask() {},
});

const adapters = { cursor: fakeAdapter('cursor'), 'claude-code': fakeAdapter('claude-code', 'not_installed') } as Record<AgentId, Adapter>;

/** A minimal socket client that collects decoded messages and reports when the server closes. */
function connect(socketPath: string) {
  const socket = net.createConnection(socketPath);
  const decoder = new MessageDecoder();
  const messages: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let closed = false;
  socket.on('data', (chunk) => {
    messages.push(...(decoder.push(chunk) as Record<string, unknown>[]));
    waiters.splice(0).forEach((w) => w());
  });
  socket.on('close', () => {
    closed = true;
    waiters.splice(0).forEach((w) => w());
  });
  const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(messages)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return {
    send: (m: unknown) => socket.write(encodeMessage(m)),
    messages,
    isClosed: () => closed,
    until,
    end: () => socket.end(),
    ready: new Promise<void>((r) => socket.once('connect', () => r())),
  };
}

const hello = { type: 'hello', requestId: 'h1', client: 'cli', clientVersion: '0.0.1', protocol: SOCKET_PROTOCOL_VERSION };

test('the socket is 0600 inside a 0700 directory', async () => {
  const socketPath = sockPath();
  fs.mkdirSync(path.dirname(socketPath), { mode: 0o755 });
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters }) });
  try {
    assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700, 'existing loose dir is tightened');
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  } finally {
    await server.close();
  }
  assert.ok(!fs.existsSync(socketPath), 'socket file removed on close');
});

test('a stale socket file is replaced', async () => {
  const socketPath = sockPath();
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.writeFileSync(socketPath, 'stale');
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters }) });
  await server.close();
});

test('anything before hello gets bad_request and the connection is closed', async () => {
  const socketPath = sockPath();
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters }) });
  try {
    const c = connect(socketPath);
    await c.ready;
    c.send({ type: 'status', requestId: 's1' });
    await c.until(() => c.isClosed());
    assert.deepEqual(c.messages[0], {
      type: 'event',
      requestId: 's1',
      event: { type: 'error', code: 'bad_request', message: 'the first message must be hello' },
    });
  } finally {
    await server.close();
  }
});

test('hello answers with the socket protocol and the agents this server runs', async () => {
  const socketPath = sockPath();
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters, viewer: () => 'octocat' }) });
  try {
    const c = connect(socketPath);
    await c.ready;
    c.send(hello);
    await c.until(() => c.messages.length > 0);
    const reply = c.messages[0];
    assert.equal(reply.type, 'hello');
    assert.equal(reply.protocol, SOCKET_PROTOCOL_VERSION);
    assert.equal(reply.viewer, 'octocat');
    assert.deepEqual((reply.capabilities as { agents: string[] }).agents, ['cursor', 'claude-code']);
    c.end();
  } finally {
    await server.close();
  }
});

test('v1 messages keep working on the socket after hello', async () => {
  const socketPath = sockPath();
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters }) });
  try {
    const c = connect(socketPath);
    await c.ready;
    c.send(hello);
    c.send({ type: 'status', requestId: 's1' });
    await c.until(() => c.messages.some((m) => m.type === 'status' && (m.pending as string[]).length === 0));
    const last = c.messages.filter((m) => m.type === 'status').at(-1)!;
    assert.deepEqual(
      (last.agents as AgentStatus[]).map((a) => [a.id, a.state]),
      [
        ['cursor', 'ready'],
        ['claude-code', 'not_installed'],
      ],
    );
    c.end();
  } finally {
    await server.close();
  }
});

test('an agents subscription pushes readiness and stops after unsubscribe', async () => {
  const socketPath = sockPath();
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters }) });
  try {
    const c = connect(socketPath);
    await c.ready;
    c.send(hello);
    c.send({ type: 'subscribe', requestId: 'sub1', topic: 'agents' });
    await c.until(() => c.messages.some((m) => m.type === 'agents' && (m.pending as string[]).length === 0));
    c.send({ type: 'unsubscribe', requestId: 'sub1' });
    await c.until(() => c.messages.some((m) => m.type === 'ack' && m.requestId === 'sub1'));
    c.end();
  } finally {
    await server.close();
  }
});

test('features that are not built yet answer not_implemented instead of hanging', async () => {
  const socketPath = sockPath();
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters }) });
  try {
    const c = connect(socketPath);
    await c.ready;
    c.send(hello);
    c.send({ type: 'start_review', requestId: 'c1', pr: { owner: 'polarsteps', repo: 'web', number: 1 } });
    await c.until(() => c.messages.some((m) => m.requestId === 'c1'));
    const reply = c.messages.find((m) => m.requestId === 'c1') as { event: { code: string } };
    assert.equal(reply.event.code, 'not_implemented');
    c.end();
  } finally {
    await server.close();
  }
});

test('shutdown is acknowledged before the server drains', async () => {
  const socketPath = sockPath();
  let shutdowns = 0;
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters, onShutdown: () => shutdowns++ }) });
  try {
    const c = connect(socketPath);
    await c.ready;
    c.send(hello);
    c.send({ type: 'shutdown', requestId: 'x1' });
    await c.until(() => c.messages.some((m) => m.type === 'ack' && m.requestId === 'x1'));
    assert.equal(shutdowns, 1);
    c.end();
  } finally {
    await server.close();
  }
});

test('many clients can connect at once', async () => {
  const socketPath = sockPath();
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters }) });
  try {
    const clients = [connect(socketPath), connect(socketPath), connect(socketPath)];
    await Promise.all(clients.map((c) => c.ready));
    clients.forEach((c, i) => c.send({ ...hello, requestId: `h${i}` }));
    await Promise.all(clients.map((c, i) => c.until(() => c.messages.some((m) => m.requestId === `h${i}`))));
    assert.equal(server.connectionCount(), 3);
    clients.forEach((c) => c.end());
  } finally {
    await server.close();
  }
});

test('the extension can never send socket-only messages', () => {
  for (const m of [hello, { type: 'shutdown', requestId: 'a' }, { type: 'subscribe', requestId: 'a', topic: 'inbox' }]) {
    assert.throws(() => validateMessage(m), ValidationError);
    assert.doesNotThrow(() => validateAppMessage(m));
  }
});

test('socket validators reject malformed v2 messages', () => {
  const bad = [
    { ...hello, client: 'chrome' },
    { ...hello, protocol: 'two' },
    { ...hello, clientVersion: '--evil' },
    { type: 'subscribe', requestId: 'a', topic: 'everything' },
    { type: 'subscribe', requestId: 'a', topic: { pr: { owner: 'polarsteps', repo: '..', number: 1 } } },
    { type: 'start_review', requestId: 'a', pr: { owner: 'polarsteps', repo: 'web', number: 0 } },
    { type: 'start_review', requestId: 'a', pr: { owner: 'polarsteps', repo: 'web', number: 1 }, agent: 'codex' },
    { type: 'start_review', requestId: 'a', pr: { owner: 'polarsteps', repo: 'web', number: 1 }, model: '--yolo' },
    { type: 'risk_labels', requestId: 'a', pr: { owner: 'polarsteps', repo: 'web', number: 1 }, headSha: 'HEAD' },
    { type: 'stop_review', requestId: 'a', pr: { owner: 'polarsteps', repo: 'web', number: 1 }, removeWorktree: 'yes' },
  ];
  for (const m of bad) assert.throws(() => validateAppMessage(m), ValidationError, JSON.stringify(m));
});

test('the instance lock admits one live holder and takes over a stale one', () => {
  const lockPath = path.join(root, 'lockdir', 'server.lock');
  assert.ok(acquireInstanceLock(lockPath));
  assert.equal(fs.statSync(path.dirname(lockPath)).mode & 0o777, 0o700);

  // A live holder (pid 1, launchd) blocks us.
  fs.writeFileSync(lockPath, '1');
  assert.equal(acquireInstanceLock(lockPath), false);

  // A dead holder is taken over.
  fs.writeFileSync(lockPath, '999999');
  assert.ok(acquireInstanceLock(lockPath));
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid));

  releaseInstanceLock(lockPath);
  assert.ok(!fs.existsSync(lockPath));
});

test('start_review over the socket replies preparing, and a { pr } subscription follows it to ready', async () => {
  const { openDb } = await import('../src/db.ts');
  const { ReviewingService } = await import('../src/reviewing.ts');
  const reviewing = new ReviewingService({
    db: openDb(':memory:'),
    config: () => ({ worktreeRoot: '/virtual/wt', scanRoots: [] }) as never,
    ops: {
      findClone: async () => ({ clone: '/clones/web', blockedRoots: [] }),
      fetchHead: async () => 'c'.repeat(40),
      checkout: async () => {},
      remove: async () => true,
    },
  });
  const socketPath = sockPath();
  const server = await startSocketServer({ socketPath, router: createRouter({ adapters, reviewing }) });
  try {
    const c = connect(socketPath);
    await c.ready;
    const pr = { owner: 'acme', repo: 'web', number: 3 };
    c.send(hello);
    c.send({ type: 'subscribe', requestId: 'sub', topic: { pr } });
    c.send({ type: 'start_review', requestId: 'go', pr, agent: 'cursor' });
    await c.until(() => c.messages.some((m) => m.requestId === 'sub' && (m.review as { phase?: string } | null)?.phase === 'ready'));
    assert.equal((c.messages.find((m) => m.requestId === 'go')!.review as { phase: string }).phase, 'preparing');
    assert.equal(c.messages.find((m) => m.requestId === 'sub')!.review, null, 'subscription starts with "not reviewing"');
    assert.equal((c.messages.find((m) => m.type === 'hello')!.capabilities as { review: boolean }).review, true);

    c.send({ type: 'stop_review', requestId: 'stop', pr });
    await c.until(() => c.messages.some((m) => m.requestId === 'stop'));
    assert.equal(c.messages.find((m) => m.requestId === 'stop')!.review, null);
    c.end();
  } finally {
    await server.close();
  }
});
