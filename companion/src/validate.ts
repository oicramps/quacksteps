import type {
  AgentId,
  AppMessage,
  AskRequest,
  StartReviewRequest,
  CodeSelection,
  ExtensionMessage,
  HistoryTurn,
  PrKey,
  PrRef,
  SettingsPatch,
  WorkspacePrTarget,
} from '@quacksteps/shared';
import { LIMITS } from './config.ts';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{7,40}$/;

/** A git object id, or null when the value could be a flag or a refspec. */
export function asCommitSha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sha = value.trim().toLowerCase();
  return SHA.test(sha) ? sha : null;
}
const BRANCH = /^[A-Za-z0-9._\/-]{1,250}$/;
// Models and session IDs are passed as CLI arguments; disallow leading dashes to prevent flag injection.
const MODEL = /^(?:[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99})?$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const AGENTS: AgentId[] = ['cursor', 'claude-code'];

export class ValidationError extends Error {}

function fail(message: string): never {
  throw new ValidationError(message);
}

/** Validates that `p` is a relative repository path without `.` or `..` segments, backslashes, or null bytes. */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 1000 || p.startsWith('/') || p.includes('\0') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Validates a git branch name against ref traversal (`..`, `.lock`) and CLI flag injection (`-`). */
export function isSafeBranch(name: string): boolean {
  return BRANCH.test(name) && !name.includes('..') && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.lock');
}

function validateWorkspacePr(pr: unknown): WorkspacePrTarget {
  const p = pr as Partial<WorkspacePrTarget> | null;
  if (!p || typeof p !== 'object') fail('pr is required');
  if (typeof p.owner !== 'string' || !OWNER.test(p.owner)) fail('invalid owner');
  if (typeof p.repo !== 'string' || !REPO.test(p.repo) || p.repo === '.' || p.repo === '..') fail('invalid repo');
  return { owner: p.owner, repo: p.repo };
}

function validateConfigPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 500 || value.includes('\0') || !value.trim()) fail(`invalid ${label}`);
  return value;
}

function validateOwnerRepoKey(key: string): string {
  const slash = key.indexOf('/');
  if (slash <= 0) fail('invalid repo key');
  const owner = key.slice(0, slash);
  const repo = key.slice(slash + 1);
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') fail('invalid repo key');
  return `${owner}/${repo}`.toLowerCase();
}

function validatePr(pr: unknown): PrRef {
  const p = pr as Partial<PrRef> | null;
  if (!p || typeof p !== 'object') fail('pr is required');
  if (typeof p.owner !== 'string' || !OWNER.test(p.owner)) fail('invalid owner');
  if (typeof p.repo !== 'string' || !REPO.test(p.repo) || p.repo === '.' || p.repo === '..') fail('invalid repo');
  if (!Number.isInteger(p.number) || (p.number as number) < 1 || (p.number as number) > 10_000_000) fail('invalid PR number');
  if (p.headSha !== undefined && (typeof p.headSha !== 'string' || !SHA.test(p.headSha))) fail('invalid headSha');
  if (p.baseRef !== undefined && (typeof p.baseRef !== 'string' || !isSafeBranch(p.baseRef))) fail('invalid baseRef');
  if (p.title !== undefined && typeof p.title !== 'string') fail('invalid title');
  return {
    owner: p.owner,
    repo: p.repo,
    number: p.number as number,
    headSha: p.headSha,
    baseRef: p.baseRef,
    title: p.title?.slice(0, 500),
  };
}

function validateSelection(s: unknown): CodeSelection {
  const sel = s as Partial<CodeSelection> | null;
  if (!sel || typeof sel !== 'object') fail('invalid selection');
  const out: CodeSelection = {};
  if (sel.path !== undefined) {
    if (typeof sel.path !== 'string' || !isSafeRepoPath(sel.path)) fail('invalid selection path');
    out.path = sel.path;
  }
  if (sel.fileAnchor !== undefined) {
    if (typeof sel.fileAnchor !== 'string' || !/^[0-9a-f]{64}$/.test(sel.fileAnchor)) fail('invalid fileAnchor');
    out.fileAnchor = sel.fileAnchor;
  }
  if (sel.side !== undefined) {
    if (sel.side !== 'old' && sel.side !== 'new') fail('invalid side');
    out.side = sel.side;
  }
  for (const key of ['startLine', 'endLine'] as const) {
    const v = sel[key];
    if (v !== undefined) {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 10_000_000) fail(`invalid ${key}`);
      out[key] = v as number;
    }
  }
  if (sel.text !== undefined) {
    if (typeof sel.text !== 'string') fail('invalid selection text');
    out.text = sel.text.slice(0, 20_000);
  }
  return out;
}

const MAX_HISTORY = 10;

function validateHistory(h: unknown): HistoryTurn[] {
  if (!Array.isArray(h) || h.length > MAX_HISTORY) fail('invalid history');
  return h.map((t) => {
    const turn = t as Partial<HistoryTurn> | null;
    if (!turn || typeof turn !== 'object' || typeof turn.question !== 'string' || typeof turn.answer !== 'string') fail('invalid history turn');
    return { question: turn.question.slice(0, 4000), answer: turn.answer.slice(0, 8000) };
  });
}

function validatePrKey(pr: unknown): PrKey {
  const p = pr as Partial<PrKey> | null;
  if (!p || typeof p !== 'object') fail('pr is required');
  if (typeof p.owner !== 'string' || !OWNER.test(p.owner)) fail('invalid owner');
  if (typeof p.repo !== 'string' || !REPO.test(p.repo) || p.repo === '.' || p.repo === '..') fail('invalid repo');
  if (!Number.isInteger(p.number) || (p.number as number) < 1 || (p.number as number) > 10_000_000) fail('invalid PR number');
  return { owner: p.owner, repo: p.repo, number: p.number as number };
}

function optionalSha(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SHA.test(value)) fail('invalid headSha');
  return value;
}

function optionalBool(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(`invalid ${label}`);
  return value;
}

const CLIENT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const PATCH_KEYS = new Set(['retentionDays', 'maxWorktrees', 'chatAgent', 'chatModel', 'labelsAgent', 'labelsModel', 'extraPath', 'pollActiveSeconds', 'pollIdleSeconds']);

/** Settings patches write config.json, so every key is checked and unknown keys are refused. */
function validateSettingsPatch(value: unknown): SettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('patch must be an object');
  const p = value as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!PATCH_KEYS.has(k)) fail(`unknown setting ${JSON.stringify(k).slice(0, 64)}`);
  const out: SettingsPatch = {};
  const int = (k: 'retentionDays' | 'maxWorktrees' | 'pollActiveSeconds' | 'pollIdleSeconds', [min, max]: readonly [number, number]) => {
    if (p[k] === undefined) return;
    if (!Number.isInteger(p[k]) || (p[k] as number) < min || (p[k] as number) > max) fail(`${k} must be ${min}-${max}`);
    out[k] = p[k] as number;
  };
  int('retentionDays', LIMITS.retentionDays);
  int('maxWorktrees', LIMITS.maxWorktrees);
  int('pollActiveSeconds', LIMITS.pollActiveSeconds);
  int('pollIdleSeconds', LIMITS.pollIdleSeconds);
  for (const k of ['chatAgent', 'labelsAgent'] as const) {
    if (p[k] === undefined) continue;
    if (p[k] !== null && !AGENTS.includes(p[k] as AgentId)) fail(`invalid ${k}`);
    out[k] = p[k] as AgentId | null;
  }
  for (const k of ['chatModel', 'labelsModel'] as const) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'string' || !MODEL.test(p[k] as string)) fail(`invalid ${k}`);
    out[k] = p[k] as string;
  }
  if (p.extraPath !== undefined) {
    if (!Array.isArray(p.extraPath) || p.extraPath.length > 20) fail('extraPath must be a list of up to 20 folders');
    for (const d of p.extraPath) {
      if (typeof d !== 'string' || !/^(~|\/)/.test(d) || d.length > 1024 || /[\0\n\r:]/.test(d)) fail('extraPath entries must be absolute folders');
    }
    out.extraPath = p.extraPath as string[];
  }
  return out;
}

/**
 * Validates a message on the server socket: every extension message, plus the socket-only (v2) ones.
 * The stdio host keeps calling `validateMessage`, so the extension can never send socket-only messages.
 */
export function validateAppMessage(raw: unknown): AppMessage {
  const m = raw as { type?: unknown; requestId?: unknown } | null;
  if (!m || typeof m !== 'object') fail('message must be an object');
  if (typeof m.requestId !== 'string' || !REQUEST_ID.test(m.requestId)) fail('invalid requestId');
  const requestId = m.requestId;
  const r = raw as Record<string, unknown>;
  switch (m.type) {
    case 'hello': {
      if (r.client !== 'mac-app' && r.client !== 'cli') fail('invalid client');
      if (typeof r.clientVersion !== 'string' || !CLIENT_VERSION.test(r.clientVersion)) fail('invalid clientVersion');
      if (!Number.isInteger(r.protocol) || (r.protocol as number) < 1 || (r.protocol as number) > 1000) fail('invalid protocol');
      return { type: 'hello', requestId, client: r.client, clientVersion: r.clientVersion, protocol: r.protocol as number };
    }
    case 'shutdown':
    case 'unsubscribe':
      return { type: m.type, requestId };
    case 'subscribe': {
      const t = r.topic;
      if (t === 'inbox' || t === 'agents') return { type: 'subscribe', requestId, topic: t };
      if (t && typeof t === 'object' && !Array.isArray(t) && 'pr' in t) {
        return { type: 'subscribe', requestId, topic: { pr: validatePrKey((t as { pr: unknown }).pr) } };
      }
      fail('invalid topic');
    }
    case 'inbox':
      return { type: 'inbox', requestId, ...(r.refresh !== undefined && { refresh: optionalBool(r.refresh, 'refresh') }) };
    case 'start_review': {
      const out: StartReviewRequest = { type: 'start_review', requestId, pr: validatePrKey(r.pr) };
      if (r.agent !== undefined) {
        if (!AGENTS.includes(r.agent as AgentId)) fail('unknown agent');
        out.agent = r.agent as AgentId;
      }
      if (r.model !== undefined) {
        if (typeof r.model !== 'string' || !MODEL.test(r.model)) fail('invalid model');
        out.model = r.model;
      }
      return out;
    }
    case 'stop_review':
      return {
        type: 'stop_review',
        requestId,
        pr: validatePrKey(r.pr),
        ...(r.removeWorktree !== undefined && { removeWorktree: optionalBool(r.removeWorktree, 'removeWorktree') }),
      };
    case 'setup_checks':
    case 'settings':
    case 'prune_worktrees':
    case 'diagnostics':
      return { type: m.type, requestId };
    case 'save_settings':
      return { type: 'save_settings', requestId, patch: validateSettingsPatch(r.patch) };
    case 'update_review':
    case 'threads':
      return { type: m.type, requestId, pr: validatePrKey(r.pr) };
    case 'risk_labels':
      return {
        type: 'risk_labels',
        requestId,
        pr: validatePrKey(r.pr),
        ...(r.headSha !== undefined && { headSha: optionalSha(r.headSha) }),
        ...(r.rerun !== undefined && { rerun: optionalBool(r.rerun, 'rerun') }),
      };
    case 'pr_diff':
      return {
        type: 'pr_diff',
        requestId,
        pr: validatePrKey(r.pr),
        ...(r.headSha !== undefined && { headSha: optionalSha(r.headSha) }),
      };
    default:
      return validateMessage(raw);
  }
}

/** Validates and sanitizes an incoming JSON payload from the extension. Throws `ValidationError` on invalid input. */
export function validateMessage(raw: unknown): ExtensionMessage {
  const m = raw as { type?: unknown; requestId?: unknown } | null;
  if (!m || typeof m !== 'object') fail('message must be an object');
  if (typeof m.requestId !== 'string' || !REQUEST_ID.test(m.requestId)) fail('invalid requestId');
  switch (m.type) {
    case 'status':
    case 'cancel':
      return { type: m.type, requestId: m.requestId };
    case 'close_session': {
      const c = raw as { agent?: unknown; sessionId?: unknown };
      if (!AGENTS.includes(c.agent as AgentId)) fail('unknown agent');
      if (typeof c.sessionId !== 'string' || !SESSION.test(c.sessionId)) fail('invalid sessionId');
      return { type: 'close_session', requestId: m.requestId, agent: c.agent as AgentId, sessionId: c.sessionId };
    }
    case 'ask': {
      const a = raw as Partial<AskRequest>;
      if (!AGENTS.includes(a.agent as AgentId)) fail('unknown agent');
      if (typeof a.model !== 'string' || !MODEL.test(a.model)) fail('invalid model');
      if (typeof a.question !== 'string' || !a.question.trim() || a.question.length > 20_000) fail('invalid question');
      if (a.sessionId !== null && (typeof a.sessionId !== 'string' || !SESSION.test(a.sessionId))) fail('invalid sessionId');
      if (!Array.isArray(a.selections) || a.selections.length > 20) fail('invalid selections');
      if (a.task !== undefined && a.task !== 'explain_ci') fail('invalid task');
      return {
        type: 'ask',
        requestId: m.requestId,
        agent: a.agent as AgentId,
        model: a.model,
        pr: validatePr(a.pr),
        selections: a.selections.map(validateSelection),
        question: a.question,
        sessionId: a.sessionId ?? null,
        ...(a.history !== undefined && { history: validateHistory(a.history) }),
        ...(a.task !== undefined && { task: a.task }),
      };
    }
    case 'checks': {
      const c = raw as { pr?: unknown };
      return { type: 'checks', requestId: m.requestId, pr: validatePr(c.pr) };
    }
    case 'workspace_check': {
      const w = raw as { pr?: unknown };
      return {
        type: 'workspace_check',
        requestId: m.requestId,
        ...(w.pr !== undefined && { pr: validateWorkspacePr(w.pr) }),
      };
    }
    case 'workspace_save': {
      const w = raw as { scanRoots?: unknown; addPath?: unknown; repoPaths?: unknown; pr?: unknown };
      const out: Extract<ExtensionMessage, { type: 'workspace_save' }> = {
        type: 'workspace_save',
        requestId: m.requestId,
      };
      if (w.scanRoots !== undefined) {
        if (!Array.isArray(w.scanRoots) || w.scanRoots.length > 50) fail('invalid scanRoots');
        out.scanRoots = w.scanRoots.map((r) => validateConfigPath(r, 'scanRoot'));
      }
      if (w.addPath !== undefined) {
        if (typeof w.addPath !== 'string' || w.addPath.length > 500 || w.addPath.includes('\0')) fail('invalid addPath');
        out.addPath = w.addPath;
      }
      if (w.repoPaths !== undefined) {
        if (!w.repoPaths || typeof w.repoPaths !== 'object' || Array.isArray(w.repoPaths)) fail('invalid repoPaths');
        const entries = Object.entries(w.repoPaths as Record<string, unknown>);
        if (entries.length > 200) fail('too many repoPaths');
        out.repoPaths = Object.fromEntries(
          entries.map(([k, v]) => [validateOwnerRepoKey(k), v === null ? null : validateConfigPath(v, 'repoPath')]),
        );
      }
      if (w.pr !== undefined) out.pr = validateWorkspacePr(w.pr);
      return out;
    }
    default:
      fail('unknown message type');
  }
}
