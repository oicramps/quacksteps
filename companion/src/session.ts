import type { AgentEvent, AskRequest, AgentStatus, CompanionMessage, ErrorCode, FixStep, PrKey, ProgressStep, ReviewState } from '@quack/shared';
import { AGENT_TIMEOUT_MS } from '@quack/shared';
import { adapters } from './adapters/index.ts';
import { collectCi } from './checks.ts';
import { loadConfig } from './config.ts';
import { log, logPilot } from './log.ts';
import { buildCiPrompt, buildFollowUp, buildPrompt } from './prompt.ts';
import { type PrContext, prDiff, resolvePr } from './pr.ts';
import { cloneNotFound, findCloneWithDiagnostics } from './repo.ts';
import { resolveSelections } from './selection.ts';
import type { Release } from './rwlock.ts';
import { changedFiles, endRead, readWorktreeAt, worktreePath } from './worktree.ts';

export type Send = (message: CompanionMessage) => void;
export type GetStatus = (agent: AskRequest['agent']) => Promise<AgentStatus>;

/** Cached PR commit and metadata keyed by `<clonePath>#<prNumber>` for session follow-ups. */
const prContexts = new Map<string, PrContext>();

class AskError extends Error {
  code: ErrorCode;
  fixSteps?: FixStep[];
  constructor(code: ErrorCode, message: string, fixSteps?: FixStep[]) {
    super(message);
    this.code = code;
    this.fixSteps = fixSteps;
  }
}

/**
 * Executes an `ask` request: locates the local clone, fetches the PR head,
 * prepares an isolated detached worktree, constructs the prompt, and streams
 * agent events back to the extension.
 */
export async function handleAsk(
  req: AskRequest,
  send: Send,
  signal: AbortSignal,
  getStatus: GetStatus,
  /** The server's review lookup. A PR being reviewed is read at the review's commit and never moved. */
  reviewOf?: (pr: PrKey) => ReviewState | undefined,
): Promise<void> {
  const { requestId } = req;
  const review = reviewOf?.(req.pr);
  const reviewing = review && (review.phase === 'ready' || review.phase === 'stale') ? review : undefined;
  // Answers on a reviewed PR are about the commit the reviewer is looking at, whatever the app sent.
  const pr = reviewing ? { ...req.pr, headSha: reviewing.headSha } : req.pr;
  const started = Date.now();
  let firstEventMs: number | undefined;
  const pilotKey = `${req.pr.owner}/${req.pr.repo}#${req.pr.number}`.toLowerCase();
  const emit = (event: AgentEvent) => send({ type: 'event', requestId, event });
  const progress = (step: ProgressStep, detail?: string) => {
    log(requestId, step, `+${Date.now() - started}ms`);
    send({ type: 'progress', requestId, step, detail });
  };

  let release: Release | null = null;
  let worktree: string | null = null;
  let baseline: ReadonlySet<string> = new Set();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), AGENT_TIMEOUT_MS);
  const agentSignal = AbortSignal.any([signal, timeout.signal]);

  try {
    const adapter = adapters[req.agent];
    const config = loadConfig();

    progress('finding_repo');
    const statusPromise = getStatus(req.agent);
    const { clone, blockedRoots, overrideIssue } = await findCloneWithDiagnostics(config, pr.owner, pr.repo);
    if (!clone) {
      const { message, fixSteps } = cloneNotFound(config, pr, blockedRoots, overrideIssue, 'browser');
      throw new AskError('repo_not_found', message, fixSteps);
    }

    const status = await statusPromise;
    if (status.state === 'not_installed') throw new AskError('agent_not_installed', `${adapter.label} is not installed.`, status.fixSteps);
    if (status.state === 'not_logged_in') throw new AskError('agent_not_logged_in', `${adapter.label} is not logged in.`, status.fixSteps);
    if (signal.aborted) throw new AskError('cancelled', 'Stopped.');

    progress('fetching_pr');
    // Reuse cached PR context when resuming an existing session so follow-ups
    // inspect the same commit without re-fetching from origin.
    const cacheKey = `${clone}#${pr.number}`;
    let ctx = req.sessionId ? prContexts.get(cacheKey) : undefined;
    // After an Update the review moved to a new head; a cached context for the old one is stale.
    if (ctx && reviewing && ctx.headSha !== reviewing.headSha) ctx = undefined;
    if (!ctx) {
      try {
        ctx = await resolvePr(clone, pr);
      } catch (err) {
        throw new AskError('fetch_failed', `Could not fetch PR #${pr.number}: ${(err as Error).message}`, [
          { text: 'Check that git can reach GitHub from your clone', command: `git -C "${clone}" fetch origin` },
        ]);
      }
      prContexts.set(cacheKey, ctx);
    }
    if (signal.aborted) throw new AskError('cancelled', 'Stopped.');

    progress('preparing_worktree', ctx.headSha);
    const dir = reviewing?.worktreePath ?? worktreePath(config, pr.owner, pr.repo, pr.number);
    try {
      // A reader: several turns (and label runs) share the tree. Unreviewed PRs are checked out lazily first.
      release = await readWorktreeAt(clone, dir, ctx.headSha, signal, { prepare: !reviewing });
    } catch (err) {
      if (signal.aborted) throw new AskError('cancelled', 'Stopped.');
      throw err;
    }
    worktree = dir;
    baseline = new Set(await changedFiles(dir, { ignored: true }));
    log(requestId, reviewing ? 'reading review worktree' : 'worktree ready', `+${Date.now() - started}ms`);

    const selections = await resolveSelections(clone, ctx.baseSha, ctx.headSha, req.selections);

    let prompt: string;
    if (req.sessionId) log(requestId, 'resuming session', req.sessionId);
    if (req.task === 'explain_ci') {
      progress('fetching_ci');
      const ci = await collectCi(pr, signal);
      if (signal.aborted) throw new AskError('cancelled', 'Stopped.');
      const { diff, truncated } = await prDiff(clone, ctx.baseSha, ctx.headSha);
      prompt = buildCiPrompt({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        title: ctx.title,
        body: ctx.body,
        baseSha: ctx.baseSha,
        headSha: ctx.headSha,
        diff,
        diffTruncated: truncated,
        selections,
        question: req.question,
        logsUnavailable: !ci.available,
        checks: ci.checks.map(({ check, log, recent }) => ({
          name: check.name,
          workflow: check.workflow,
          link: check.link,
          log,
          recent,
        })),
      });
    } else if (req.sessionId) {
      prompt = buildFollowUp(selections, req.question);
    } else {
      const { diff, truncated } = await prDiff(clone, ctx.baseSha, ctx.headSha);
      prompt = buildPrompt({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        title: ctx.title,
        body: ctx.body,
        baseSha: ctx.baseSha,
        headSha: ctx.headSha,
        diff,
        diffTruncated: truncated,
        selections,
        question: req.question,
        history: req.history,
      });
    }

    progress('starting_agent', adapter.label);
    let sessionId = req.sessionId;
    let model = req.model;
    let firstEvent = true;
    for await (const ev of adapter.ask({ cwd: dir, prompt, model: req.model, sessionId: req.sessionId, signal: agentSignal })) {
      if (firstEvent) {
        firstEvent = false;
        firstEventMs = Date.now() - started;
        log(requestId, 'first agent event', `+${firstEventMs}ms`);
        progress('thinking');
      }
      switch (ev.type) {
        case 'session':
          sessionId = ev.sessionId;
          break;
        case 'model':
          model = ev.model;
          break;
        case 'text':
          emit({ type: 'text', delta: ev.delta });
          break;
        case 'tool':
          emit({ type: 'tool', summary: ev.summary });
          break;
        case 'error':
          throw new AskError('agent_failed', ev.message);
      }
    }

    if (timeout.signal.aborted) throw new AskError('timeout', `${adapter.label} timed out after ${AGENT_TIMEOUT_MS / 60_000} minutes.`);
    if (signal.aborted) throw new AskError('cancelled', 'Stopped.');

    // Ending the read flags a dirty tree and queues its cleanup behind any other reader.
    const changed = await endRead(dir, release, baseline);
    release = null;
    if (changed.length) {
      log(requestId, `agent left ${changed.length} changed files in the worktree`);
      emit({ type: 'tool', summary: `Warning: the agent changed ${changed.length} file(s) in the worktree; they will be discarded.` });
    }
    log(requestId, 'done', `+${Date.now() - started}ms`);
    logPilot('ask', { pr: pilotKey, outcome: 'done', ms: Date.now() - started, first_event_ms: firstEventMs, agent: req.agent, model, reviewing: !!reviewing, follow_up: !!req.sessionId });
    emit({ type: 'done', sessionId, headSha: ctx.headSha, model });
  } catch (err) {
    const e =
      err instanceof AskError
        ? err
        : timeout.signal.aborted
          ? new AskError('timeout', `Timed out after ${AGENT_TIMEOUT_MS / 60_000} minutes.`)
          : signal.aborted
            ? new AskError('cancelled', 'Stopped.')
            : new AskError('agent_failed', (err as Error).message);
    log(requestId, 'error', e.code, e.message);
    logPilot('ask', { pr: pilotKey, outcome: e.code, ms: Date.now() - started, first_event_ms: firstEventMs, agent: req.agent, reviewing: !!reviewing });
    emit({ type: 'error', code: e.code, message: e.message, fixSteps: e.fixSteps });
  } finally {
    clearTimeout(timer);
    // On an error or cancel the read is still held: end it the same way.
    if (worktree && release) await endRead(worktree, release, baseline).catch((err) => log(requestId, 'worktree cleanup failed', String(err)));
  }
}
