import { randomUUID } from 'node:crypto';
import type { AgentId, CommentAnchor, GapFinding, PrKey, ReviewState } from '@quacksteps/shared';
import { adapters as defaultAdapters } from './adapters/index.ts';
import type { Adapter } from './adapters/types.ts';
import { type Config, loadConfig } from './config.ts';
import { DIFF_BUDGET, type LabelOps, type NumstatEntry, realLabelOps, ruleReason, splitDiff } from './labels.ts';
import { log, logPilot } from './log.ts';
import type { DraftStore } from './reviewwrite.ts';

/**
 * Agent help for writing a review (v3), run in the review worktree under a read lock like labels:
 *
 * - "Turn into comment": rewrites a chat answer as one review comment in the reviewer's voice.
 * - Gap check: reads the diff and the pending comments, and drafts comments for what they miss.
 *
 * Both only produce text for the reviewer to edit. Nothing here writes to GitHub, and the agents
 * keep their read-only settings: the output is data the app shows, never acted on.
 */

export const DRAFT_TIMEOUT_MS = 2 * 60_000;
export const GAP_TIMEOUT_MS = 5 * 60_000;
export const MAX_FINDINGS = 5;
export const MAX_COMMENT = 4_000;

export class ReviewAgentError extends Error {
  readonly code: 'bad_request' | 'server_busy' | 'agent_failed' | 'timeout' | 'repo_not_found';
  constructor(code: ReviewAgentError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** Lines on the new side of a patch that GitHub accepts a comment on (added and context lines). */
export function rightLines(patch: string): Set<number> {
  const out = new Set<number>();
  let n = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop(); // the patch's final newline is not a line
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (!n) continue;
    if (line.startsWith('+') || line.startsWith(' ')) out.add(n++);
    else if (line === '') out.add(n++); // an empty context line can lose its leading space
  }
  return out;
}

/** The agent's comment text, without a wrapping fence, quotes or preamble line. */
export function cleanComment(text: string): string {
  let t = text.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  if (/^(here(’|')?s|sure|comment:)/i.test(t) && t.includes('\n')) t = t.slice(t.indexOf('\n') + 1).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) t = t.slice(1, -1).trim();
  return t.slice(0, MAX_COMMENT);
}

export class GapParseError extends Error {}

/** Strict reading of the gap check's JSON. Findings on files or lines outside the diff are dropped. */
export function parseFindings(text: string, lines: ReadonlyMap<string, Set<number>>): GapFinding[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new GapParseError('no JSON object in the reply');
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new GapParseError(`not JSON: ${(err as Error).message}`);
  }
  const list = (data as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) throw new GapParseError('"findings" is not a list');
  const out: GapFinding[] = [];
  const seen = new Set<string>();
  for (const f of list) {
    const { path, line, comment } = (f ?? {}) as { path?: unknown; line?: unknown; comment?: unknown };
    if (typeof path !== 'string' || typeof comment !== 'string' || !Number.isInteger(line)) continue;
    const allowed = lines.get(path);
    if (!allowed?.has(line as number)) continue;
    const body = cleanComment(comment);
    const key = `${path}:${line}`;
    if (!body || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: randomUUID(), path, line: line as number, body });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

const REPAIR = 'Your reply could not be read as the JSON asked for. Reply again with only the JSON object, nothing else.';

export function buildDraftPrompt(p: { path: string; range: string; side: string; lines?: string; question: string; answer: string }): string {
  return [
    'You are helping a code reviewer write one review comment on a pull request.',
    'The reviewer asked about the lines below and got the answer below. Rewrite what is useful in the answer as one review comment the reviewer will post on GitHub under their own name.',
    '',
    'Rules:',
    '- First person, as the reviewer, talking to the PR author. Friendly and direct: a question or a concrete suggestion.',
    '- Only what matters for these lines; leave out background the author already knows.',
    '- At most 80 words. Markdown is fine; put identifiers in `code`.',
    '- Never mention an AI, an assistant, an agent, Quack, or "the answer".',
    '- Do not use tools. Reply with the comment text only: no preamble, no quotes, no code fence around it.',
    '',
    `File: ${p.path}, ${p.range} (${p.side === 'LEFT' ? 'old' : 'new'} side)`,
    ...(p.lines ? ['<lines>', p.lines.slice(0, 20_000), '</lines>'] : []),
    '<question>',
    p.question.slice(0, 10_000),
    '</question>',
    '<answer>',
    p.answer.slice(0, 40_000),
    '</answer>',
  ].join('\n');
}

export function buildGapPrompt(p: {
  pr: PrKey;
  title: string;
  body: string;
  comments: { where: string; body: string }[];
  chunks: { path: string; patch: string }[];
  leftOut: string[];
}): string {
  return [
    'You are checking a pull request review for gaps before the reviewer sends it.',
    "Read the diff and the reviewer's pending comments. Find up to 5 real problems the comments do not already cover: bugs, missing tests, unhandled edge cases, broken callers. You may read files in the repository to confirm. Skip style nits and anything already raised. If nothing stands out, return an empty list.",
    '',
    'For each finding, write the review comment the reviewer would post: first person, to the PR author, at most 60 words, a question or a concrete suggestion. Markdown is fine. Never mention an AI, an assistant or an agent.',
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"findings":[{"path":"<a file from the diff>","line":<a line number on the new side of that file in the diff>,"comment":"..."}]}',
    '',
    `PR ${p.pr.owner}/${p.pr.repo}#${p.pr.number}: ${p.title}`,
    p.body.slice(0, 2_000),
    '',
    'Pending comments:',
    ...(p.comments.length ? p.comments.map((c) => `- ${c.where}: ${c.body.replace(/\s+/g, ' ').slice(0, 400)}`) : ['(none yet)']),
    '',
    '<diff>',
    ...p.chunks.map((c) => c.patch),
    '</diff>',
    ...(p.leftOut.length ? ['', `Left out of the diff above for size (read them if needed): ${p.leftOut.join(', ')}`] : []),
  ].join('\n');
}

export interface ReviewAgentOptions {
  drafts: DraftStore;
  /** The review (worktree and commit) for a PR. */
  review: (pr: PrKey) => ReviewState | undefined;
  adapters?: Record<AgentId, Adapter>;
  ops?: LabelOps;
  config?: () => Config;
  now?: () => Date;
}

export class ReviewAgent {
  private readonly opts: ReviewAgentOptions;
  private readonly adapters: Record<AgentId, Adapter>;
  private readonly ops: LabelOps;
  private readonly config: () => Config;
  private readonly now: () => Date;
  /** One gap check per PR at a time. */
  private readonly checking = new Set<string>();

  constructor(opts: ReviewAgentOptions) {
    this.opts = opts;
    this.adapters = opts.adapters ?? defaultAdapters;
    this.ops = opts.ops ?? realLabelOps;
    this.config = opts.config ?? (() => loadConfig());
    this.now = opts.now ?? (() => new Date());
  }

  /** Runs `work` in the review worktree at `headSha`, holding a read lock. */
  private async inWorktree<T>(pr: PrKey, headSha: string, signal: AbortSignal, work: (dir: string, clone: string) => Promise<T>): Promise<T> {
    const review = this.opts.review(pr);
    if (!review?.worktreePath || (review.phase !== 'ready' && review.phase !== 'stale')) {
      throw new ReviewAgentError('bad_request', 'Start reviewing this PR first: the agent reads its worktree.');
    }
    if (review.headSha !== headSha) throw new ReviewAgentError('bad_request', 'The review moved to another commit. Update, then try again.');
    const { clone } = await this.ops.findClone(this.config(), pr.owner, pr.repo);
    if (!clone) throw new ReviewAgentError('repo_not_found', `No local clone of ${pr.owner}/${pr.repo} found.`);
    const release = await this.ops.read(clone, review.worktreePath, headSha, signal);
    try {
      return await work(review.worktreePath, clone);
    } finally {
      await release().catch((err: unknown) => log('review agent: release failed', String(err)));
    }
  }

  /** One agent turn (and an optional repair turn in the same session). */
  private async converse(agent: AgentId, model: string, cwd: string, signal: AbortSignal, onTool?: (summary: string) => void) {
    const adapter = this.adapters[agent];
    if (!adapter) throw new ReviewAgentError('bad_request', `Unknown agent ${agent}.`);
    let sessionId: string | null = null;
    const turn = async (text: string) => {
      let reply = '';
      for await (const ev of adapter.ask({ cwd, prompt: text, model, sessionId, signal })) {
        if (ev.type === 'text') reply += ev.delta;
        else if (ev.type === 'tool') onTool?.(ev.summary);
        else if (ev.type === 'session' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(ev.sessionId)) sessionId = ev.sessionId;
        else if (ev.type === 'error') throw new ReviewAgentError('agent_failed', `${adapter.label} failed: ${ev.message}`);
      }
      if (signal.aborted) throw signal.reason;
      return reply;
    };
    return {
      turn,
      close: () => {
        if (sessionId) adapter.closeSession?.(sessionId);
      },
    };
  }

  private signal(outer: AbortSignal | undefined, ms: number) {
    const timeout = AbortSignal.timeout(ms);
    return { timeout, signal: outer ? AbortSignal.any([outer, timeout]) : timeout };
  }

  /** "Turn into comment": the answer, rewritten as one review comment for these lines. */
  async draftComment(
    pr: PrKey,
    p: { agent: AgentId; model: string; headSha: string; anchor: CommentAnchor; lines?: string; question: string; answer: string },
    outer?: AbortSignal,
  ): Promise<string> {
    const { timeout, signal } = this.signal(outer, DRAFT_TIMEOUT_MS);
    const started = this.now().getTime();
    try {
      const body = await this.inWorktree(pr, p.headSha, signal, async (dir) => {
        const range = p.anchor.startLine && p.anchor.startLine < p.anchor.line ? `lines ${p.anchor.startLine}–${p.anchor.line}` : `line ${p.anchor.line}`;
        const chat = await this.converse(p.agent, p.model, dir, signal);
        try {
          return cleanComment(await chat.turn(buildDraftPrompt({ path: p.anchor.path, range, side: p.anchor.side, lines: p.lines, question: p.question, answer: p.answer })));
        } finally {
          chat.close();
        }
      });
      if (!body) throw new ReviewAgentError('agent_failed', 'The agent sent back an empty comment. Try again.');
      logPilot('draft_comment', { pr: `${pr.owner}/${pr.repo}#${pr.number}`, ms: this.now().getTime() - started, agent: p.agent, model: p.model });
      return body;
    } catch (err) {
      if (timeout.aborted) throw new ReviewAgentError('timeout', 'Drafting the comment took too long. Try again.');
      throw err;
    }
  }

  /** Reads the diff and the pending comments; drafts comments for what they miss. */
  async gapCheck(
    pr: PrKey,
    p: { agent: AgentId; model: string; headSha: string },
    onTool?: (summary: string) => void,
    outer?: AbortSignal,
  ): Promise<{ findings: GapFinding[]; checkedFiles: number; skipped: { path: string; reason: string }[]; ms: number }> {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
    if (this.checking.has(key)) throw new ReviewAgentError('server_busy', 'A gap check is already running for this PR.');
    this.checking.add(key);
    const { timeout, signal } = this.signal(outer, GAP_TIMEOUT_MS);
    const started = this.now().getTime();
    try {
      const result = await this.inWorktree(pr, p.headSha, signal, async (dir, clone) => {
        const ctx = await this.ops.context(clone, pr, p.headSha);
        const all = await this.ops.numstat(clone, ctx.baseSha, p.headSha);
        const skipped: { path: string; reason: string }[] = [];
        const checked: NumstatEntry[] = [];
        for (const e of all) {
          const reason = ruleReason(e, e.added > 0 ? await this.ops.readStart(dir, e.path) : null);
          if (reason) skipped.push({ path: e.path, reason });
          else checked.push(e);
        }
        if (!checked.length) return { findings: [], checkedFiles: 0, skipped };
        const chunks = splitDiff(await this.ops.diff(clone, ctx.baseSha, p.headSha), checked);
        const lines = new Map(checked.map((e) => [e.path, rightLines(chunks.get(e.path) ?? '')]));
        // Largest files first, until the budget runs out.
        let left = DIFF_BUDGET;
        const inPrompt: { path: string; patch: string }[] = [];
        const leftOut: string[] = [];
        for (const e of [...checked].sort((a, b) => b.added + b.deleted - (a.added + a.deleted))) {
          const patch = chunks.get(e.path) ?? '';
          if (patch.length <= left) {
            inPrompt.push({ path: e.path, patch });
            left -= patch.length;
          } else leftOut.push(e.path);
        }
        const comments = this.opts.drafts
          .list(pr)
          .comments.filter((d) => d.anchor)
          .map((d) => ({ where: `${d.anchor!.path}:${d.anchor!.startLine ? `${d.anchor!.startLine}-` : ''}${d.anchor!.line}`, body: d.body }));
        const prompt = buildGapPrompt({ pr, title: ctx.title, body: ctx.body, comments, chunks: inPrompt, leftOut });
        const chat = await this.converse(p.agent, p.model, dir, signal, onTool);
        try {
          const first = await chat.turn(prompt);
          let findings: GapFinding[];
          try {
            findings = parseFindings(first, lines);
          } catch (err) {
            if (!(err instanceof GapParseError)) throw err;
            log('gap check: reply did not parse, repairing:', err.message);
            try {
              findings = parseFindings(await chat.turn(REPAIR), lines);
            } catch (again) {
              if (again instanceof GapParseError) throw new ReviewAgentError('agent_failed', `The agent's findings could not be read: ${again.message}`);
              throw again;
            }
          }
          return { findings, checkedFiles: checked.length, skipped };
        } finally {
          chat.close();
        }
      });
      const ms = this.now().getTime() - started;
      logPilot('gap_check', { pr: key, ms, agent: p.agent, model: p.model, findings: result.findings.length, files: result.checkedFiles });
      return { ...result, ms };
    } catch (err) {
      if (timeout.aborted) throw new ReviewAgentError('timeout', `The gap check took longer than ${GAP_TIMEOUT_MS / 60_000} minutes.`);
      throw err;
    } finally {
      this.checking.delete(key);
    }
  }
}
