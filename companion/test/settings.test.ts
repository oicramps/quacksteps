import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentStatus, SettingsPatch } from '@quack/shared';
import type { Adapter } from '../src/adapters/types.ts';
import { DEFAULTS, loadConfig, saveSettings } from '../src/config.ts';
import { SettingsService, worktreeStats } from '../src/settings.ts';
import { ValidationError, validateAppMessage } from '../src/validate.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quack-settings-'));

test('settings round-trip through config.json and keep unrelated keys', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ scanRoots: ['~/code'], custom: 'kept' }));
    saveSettings({ retentionDays: 14, chatAgent: 'cursor', chatModel: 'auto', labelsModel: 'fast', extraPath: ['~/bin'], pollActiveSeconds: 120 }, file);
    const c = loadConfig(file);
    assert.equal(c.retentionDays, 14);
    assert.deepEqual(c.agents, { default: 'cursor', model: 'auto' });
    assert.deepEqual(c.labels, { model: 'fast' });
    assert.deepEqual(c.extraPath, [path.join(os.homedir(), 'bin')]);
    assert.deepEqual(c.poll, { activeSeconds: 120, idleSeconds: 300 });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).custom, 'kept');

    saveSettings({ chatAgent: null, labelsAgent: 'claude-code' }, file);
    const after = loadConfig(file);
    assert.equal(after.agents.default, undefined);
    assert.equal(after.labels.agent, 'claude-code');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-edited config with bad values falls back to defaults', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ retentionDays: -3, maxWorktrees: 'lots', agents: { default: 'codex', model: '--evil' }, poll: { activeSeconds: 1 } }));
    const c = loadConfig(file);
    assert.equal(c.retentionDays, DEFAULTS.retentionDays);
    assert.equal(c.maxWorktrees, DEFAULTS.maxWorktrees);
    assert.deepEqual(c.agents, { model: '' }, 'unknown agent and a flag-like model are dropped');
    assert.equal(c.poll.activeSeconds, 60);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save_settings patches are validated strictly', () => {
  const ok = (patch: unknown) => validateAppMessage({ type: 'save_settings', requestId: 'r', patch });
  assert.deepEqual(ok({ retentionDays: 3, chatAgent: null, extraPath: ['/opt/x', '~/y'] }), { type: 'save_settings', requestId: 'r', patch: { retentionDays: 3, chatAgent: null, extraPath: ['/opt/x', '~/y'] } });
  const bad: unknown[] = [
    { worktreeRoot: '/tmp' },
    { retentionDays: 0 },
    { retentionDays: 1.5 },
    { pollActiveSeconds: 5 },
    { chatAgent: 'codex' },
    { chatModel: '--dangerous' },
    { extraPath: ['relative/dir'] },
    { extraPath: ['/a:/b'] },
    { extraPath: '/opt' },
    null,
  ];
  for (const patch of bad) assert.throws(() => ok(patch), ValidationError, JSON.stringify(patch));
});

const agent = (id: AgentStatus['id'], label: string, state: AgentStatus['state'], version?: string): Adapter => ({
  id,
  label,
  isAvailable: async () => ({ id, label, state, ...(version && { version }), models: [], fixSteps: state === 'ready' ? [] : [{ text: `Fix ${label}`, command: `${id} login` }] }),
  async *ask() {},
});

function service(over: Partial<ConstructorParameters<typeof SettingsService>[0]> = {}) {
  const saved: SettingsPatch[] = [];
  const svc = new SettingsService({
    adapters: { cursor: agent('cursor', 'Cursor', 'ready', '2026.11.01'), 'claude-code': agent('claude-code', 'Claude Code', 'not_installed') },
    github: () => ({ viewer: 'dev', rateLimit: { limit: 5000, remaining: 4812, resetAt: '2026-11-18T12:00:00Z' } }),
    repos: () => [],
    reviewed: () => new Set(),
    config: () => ({ ...DEFAULTS, worktreeRoot: '/nonexistent/quack-worktrees' }),
    saveConfig: (p) => saved.push(p),
    checkGh: async () => ({ id: 'gh', ok: true, title: 'GitHub CLI can see acme', detail: 'Logged in as dev.', fixSteps: [] }),
    checkClone: async () => ({ id: 'clone', ok: true, title: 'Found a clone', detail: '3 clones in ~/code', fixSteps: [] }),
    ...over,
  });
  return { svc, saved };
}

test('setup checks come in order, and one ready agent is enough', async () => {
  const checks = await service().svc.setupChecks();
  assert.deepEqual(checks.map((c) => c.id), ['server', 'gh', 'git', 'agent', 'clone']);
  const a = checks.find((c) => c.id === 'agent')!;
  assert.equal(a.ok, true);
  assert.equal(a.detail, "Cursor 2026.11.01 is ready. Claude Code isn't installed; that's fine.");
});

test('with no ready agent, the check fails with the closest agent’s fix steps', async () => {
  const { svc } = service({ adapters: { cursor: agent('cursor', 'Cursor', 'not_logged_in'), 'claude-code': agent('claude-code', 'Claude Code', 'not_installed') } });
  const a = (await svc.setupChecks()).find((c) => c.id === 'agent')!;
  assert.equal(a.ok, false);
  assert.deepEqual(a.fixSteps, [{ text: 'Fix Cursor', command: 'cursor login' }]);
});

test('saving applies the patch, then answers with a fresh snapshot', async () => {
  const applied: unknown[] = [];
  const { svc, saved } = service({ onSaved: (c) => applied.push(c) });
  const snap = await svc.save({ retentionDays: 9 });
  assert.deepEqual(saved, [{ retentionDays: 9 }]);
  assert.equal(applied.length, 1);
  assert.equal(snap.github.rateLimit?.remaining, 4812);
  assert.deepEqual(snap.worktrees, { root: '/nonexistent/quack-worktrees', count: 0, bytes: 0 });
});

test('a failed save is reported in the snapshot, not thrown', async () => {
  const { svc } = service({
    saveConfig: () => {
      throw new Error('disk full');
    },
  });
  assert.match((await svc.save({ retentionDays: 2 })).error!, /disk full/);
});

test('worktree stats count pr-* folders and measure them', async () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'acme', 'web', 'pr-1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'acme', 'web', 'pr-2'), { recursive: true });
    fs.mkdirSync(path.join(root, 'acme', 'web', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'acme', 'web', 'pr-1', 'f'), Buffer.alloc(64 * 1024));
    const stats = await worktreeStats(root);
    assert.equal(stats.count, 2);
    assert.ok(stats.bytes >= 64 * 1024);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostics never contain tokens', async () => {
  const text = await service().svc.diagnostics();
  assert.match(text, /== doctor ==/);
  assert.doesNotMatch(text, /gh[opsu]_[A-Za-z0-9]{20,}/);
});

test('extra PATH folders inside the worktrees are refused, and saves are atomic', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  try {
    const worktreeRoot = path.join(dir, 'worktrees');
    fs.writeFileSync(file, JSON.stringify({ worktreeRoot }));
    assert.throws(() => saveSettings({ extraPath: [path.join(worktreeRoot, 'acme', 'web', 'pr-1', 'tools')] }, file), /worktrees/);
    assert.throws(() => saveSettings({ extraPath: [worktreeRoot] }, file), /worktrees/);
    saveSettings({ extraPath: [path.join(dir, 'bin')] }, file);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
