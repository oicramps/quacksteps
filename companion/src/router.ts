import type { AgentId, AgentStatus, AppMessage, AskRequest, CompanionMessage, InboxEvent, InboxMessage, PrKey, ServerMessage } from '@quack/shared';
import type { InboxService, InboxSnapshot } from './inbox.ts';
import { DiffError, DiffService } from './diff.ts';
import type { LabelRunner, LabelsView } from './labels.ts';
import type { SettingsService } from './settings.ts';
import type { ThreadStore } from './threads.ts';
import type { ReviewingService } from './reviewing.ts';
import { PROTOCOL_VERSION, QUACK_VERSION, SOCKET_PROTOCOL_VERSION } from '@quack/shared';
import { adapters as defaultAdapters } from './adapters/index.ts';
import type { Adapter } from './adapters/types.ts';
import { listFailingChecks } from './checks.ts';
import { encodeMessage } from './framing.ts';
import { log } from './log.ts';
import { inspectWorkspace, saveWorkspace } from './repo.ts';
import { handleAsk } from './session.ts';

const STATUS_TTL_MS = 60_000;
/** Subscriptions one connection may hold (the app uses a handful). */
const MAX_SUBSCRIPTIONS = 64;
// Chrome limits host-to-extension native messages to 1 MB; chunk large text deltas to 64 KB.
// The socket keeps the same split so the router behaves the same on both transports.
export const MAX_TEXT_DELTA = 64 * 1024;

/**
 * One client of the router: the extension's stdio pipe, or one socket connection.
 * The router never writes bytes itself; each transport supplies `send`.
 */
export interface Connection {
  readonly id: string;
  readonly transport: 'stdio' | 'socket';
  send(message: ServerMessage): void;
}

/** Turns a message into frames, splitting oversized text deltas so no frame exceeds Chrome's limit. */
export function encodeFrames(message: ServerMessage): Buffer[] {
  if (message.type === 'event' && message.event.type === 'text' && message.event.delta.length > MAX_TEXT_DELTA) {
    const { delta } = message.event;
    const frames: Buffer[] = [];
    for (let i = 0; i < delta.length; i += MAX_TEXT_DELTA) {
      frames.push(encodeMessage({ ...message, event: { type: 'text', delta: delta.slice(i, i + MAX_TEXT_DELTA) } }));
    }
    return frames;
  }
  return [encodeMessage(message)];
}

export interface RouterOptions {
  adapters?: Record<AgentId, Adapter>;
  /** Called after a `shutdown` request is acknowledged. The transport decides how to drain and exit. */
  onShutdown?: () => void;
  /** GitHub login for `hello`. Defaults to the inbox's last known viewer. */
  viewer?: () => string | null;
  /** The server's inbox poller. Absent on the stdio host. */
  inbox?: InboxService;
  /** The server's reviews ("Start reviewing"). Absent on the stdio host. */
  reviewing?: ReviewingService;
  /** The server's risk label runner. Absent on the stdio host. */
  labels?: LabelRunner;
  /** Stored chat turns. Absent on the stdio host (the extension keeps its own threads). */
  threads?: ThreadStore;
  /** First run and Settings. Absent on the stdio host. */
  settings?: SettingsService;
  /** PR diffs. Defaults to a fresh service. */
  diffs?: DiffService;
}

const samePr = (a: PrKey, b: PrKey) =>
  a.number === b.number && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

interface Subscription {
  topic: 'agents' | 'inbox' | 'pr';
  /** Detaches from the server-owned service feeding it. */
  stop?: () => void;
}

interface ConnectionState {
  conn: Connection;
  running: Map<string, AbortController>;
  /** Subscription requestId -> subscription. */
  subscriptions: Map<string, Subscription>;
}

function inboxMessage(requestId: string, snap: InboxSnapshot, events: InboxEvent[]): InboxMessage {
  return {
    type: 'inbox',
    requestId,
    fetchedAt: snap.fetchedAt ?? '',
    items: snap.items,
    events,
    ...(snap.more && { more: snap.more }),
    ...(snap.error && { error: snap.error }),
  };
}

/**
 * Wraps an ask's `send` so a finished turn joins the PR's stored thread: the question, the streamed
 * answer, and the commit, model and session from `done`. Failed and stopped turns are not kept.
 */
export function recordTurns(ask: AskRequest, send: (m: CompanionMessage) => void, threads: ThreadStore, now = () => new Date()) {
  const askedAt = now().toISOString();
  let answer = '';
  return (m: CompanionMessage) => {
    if (m.type === 'event' && m.event.type === 'text') answer += m.event.delta;
    if (m.type === 'event' && m.event.type === 'done') {
      const { owner, repo, number } = ask.pr;
      try {
        threads.add(
          { owner, repo, number },
          {
            question: ask.question,
            answer,
            agent: ask.agent,
            model: m.event.model || ask.model,
            sessionId: m.event.sessionId,
            headSha: m.event.headSha,
            selections: ask.selections,
            askedAt,
          },
        );
      } catch (err) {
        log('storing the turn failed', String(err));
      }
    }
    send(m);
  };
}

const labelsMessage = (requestId: string, view: LabelsView): ServerMessage => ({ type: 'risk_labels', requestId, ...view });

/**
 * Transport-independent request handling: the agent status cache, in-flight asks and
 * subscriptions. `stdio.ts` and `socket.ts` feed it validated messages.
 */
export function createRouter(opts: RouterOptions = {}) {
  const adapters = opts.adapters ?? defaultAdapters;
  const agentIds = Object.keys(adapters) as AgentId[];
  const connections = new Map<string, ConnectionState>();
  const diffs = opts.diffs ?? new DiffService();

  const statusCache = new Map<AgentId, { at: number; status: AgentStatus }>();
  const refreshStatus = async (id: AgentId): Promise<AgentStatus> => {
    const status = await adapters[id].isAvailable();
    statusCache.set(id, { at: Date.now(), status });
    return status;
  };
  // Stale-while-revalidate: return cached 'ready' status immediately and refresh
  // in the background after STATUS_TTL_MS. Non-ready states always re-check.
  const cachedStatus = async (id: AgentId): Promise<AgentStatus> => {
    const hit = statusCache.get(id);
    if (hit?.status.state !== 'ready') return refreshStatus(id);
    if (Date.now() - hit.at >= STATUS_TTL_MS) {
      hit.at = Date.now();
      refreshStatus(id).catch(() => {});
    }
    return hit.status;
  };

  /** Probes every agent, reporting once immediately and again as each probe finishes. */
  const probeAgents = (report: (agents: AgentStatus[], pending: AgentId[]) => void) => {
    const done = new Map<AgentId, AgentStatus>();
    const emit = () => report(agentIds.flatMap((id) => done.get(id) ?? []), agentIds.filter((id) => !done.has(id)));
    emit();
    for (const id of agentIds) {
      refreshStatus(id)
        .catch((err: unknown): AgentStatus => {
          log('status probe failed', id, String(err));
          return { id, label: adapters[id].label, state: 'not_installed', models: [], fixSteps: [] };
        })
        .then((status) => {
          done.set(id, status);
          emit();
        });
    }
  };

  const state = (conn: Connection): ConnectionState => {
    let s = connections.get(conn.id);
    if (!s) {
      s = { conn, running: new Map(), subscriptions: new Map() };
      connections.set(conn.id, s);
    }
    return s;
  };

  const notImplemented = (conn: Connection, requestId: string, what: string) =>
    conn.send({ type: 'event', requestId, event: { type: 'error', code: 'not_implemented', message: `${what} is not available in this server yet.` } });

  /** Handles one validated message from `conn`. */
  function handle(message: AppMessage, conn: Connection): void {
    const s = state(conn);
    const send = (m: CompanionMessage) => conn.send(m);
    switch (message.type) {
      // --- v1 (extension) messages, unchanged behaviour ---
      case 'status':
        probeAgents((agents, pending) =>
          send({
            type: 'status',
            requestId: message.requestId,
            version: QUACK_VERSION,
            protocol: PROTOCOL_VERSION,
            capabilities: { workspace: true },
            agents,
            pending,
          }),
        );
        break;
      case 'cancel':
        s.running.get(message.requestId)?.abort();
        break;
      case 'close_session':
        adapters[message.agent].closeSession?.(message.sessionId);
        break;
      case 'checks':
        listFailingChecks(message.pr)
          .then((result) => send({ type: 'checks', requestId: message.requestId, ...result }))
          .catch((err) => {
            log('checks failed', String(err));
            send({ type: 'checks', requestId: message.requestId, failing: [], available: false });
          });
        break;
      case 'workspace_check':
        inspectWorkspace({ pr: message.pr })
          .then((workspace) => send({ type: 'workspace', requestId: message.requestId, workspace }))
          .catch((err) => {
            log('workspace check failed', String(err));
            send({
              type: 'workspace',
              requestId: message.requestId,
              workspace: { configured: false, gitAvailable: false, roots: [], overrides: [], totalRepos: 0 },
              error: (err as Error).message,
            });
          });
        break;
      case 'workspace_save':
        saveWorkspace(message)
          .then((result) => send({ type: 'workspace', requestId: message.requestId, ...result }))
          .catch((err) => {
            log('workspace save failed', String(err));
            send({
              type: 'workspace',
              requestId: message.requestId,
              workspace: { configured: false, gitAvailable: false, roots: [], overrides: [], totalRepos: 0 },
              error: (err as Error).message,
            });
          });
        break;
      case 'ask': {
        const controller = new AbortController();
        s.running.set(message.requestId, controller);
        // The ask is over for the client once its final event is sent; worktree cleanup that follows
        // must not count as in flight (a client closing right after `done` is not an abort).
        const recorded = opts.threads ? recordTurns(message, send, opts.threads) : send;
        const sendAsk = (m: CompanionMessage) => {
          if (m.type === 'event' && (m.event.type === 'done' || m.event.type === 'error')) s.running.delete(message.requestId);
          recorded(m);
        };
        const reviewOf = opts.reviewing ? (pr: PrKey) => opts.reviewing!.get(pr) : undefined;
        handleAsk(message, sendAsk, controller.signal, cachedStatus, reviewOf).finally(() => s.running.delete(message.requestId));
        break;
      }

      // --- v2 (socket) messages ---
      case 'hello':
        conn.send({
          type: 'hello',
          requestId: message.requestId,
          version: QUACK_VERSION,
          protocol: SOCKET_PROTOCOL_VERSION,
          viewer: opts.viewer?.() ?? opts.inbox?.viewer ?? null,
          capabilities: { workspace: true, inbox: !!opts.inbox, labels: !!opts.labels, review: !!opts.reviewing, agents: agentIds },
        });
        break;
      case 'shutdown':
        conn.send({ type: 'ack', requestId: message.requestId });
        opts.onShutdown?.();
        break;
      case 'subscribe': {
        const { topic } = message;
        // Reusing a requestId replaces that subscription (its listener stops); a connection has a cap.
        s.subscriptions.get(message.requestId)?.stop?.();
        s.subscriptions.delete(message.requestId);
        if (s.subscriptions.size >= MAX_SUBSCRIPTIONS) {
          conn.send({ type: 'event', requestId: message.requestId, event: { type: 'error', code: 'bad_request', message: 'Too many subscriptions on one connection.' } });
          break;
        }
        if (topic === 'agents') {
          s.subscriptions.set(message.requestId, { topic: 'agents' });
          probeAgents((agents, pending) => {
            // Stop pushing once the client unsubscribed or went away.
            if (s.subscriptions.has(message.requestId) && connections.has(conn.id)) {
              conn.send({ type: 'agents', requestId: message.requestId, agents, pending });
            }
          });
        } else if (topic === 'inbox') {
          const inbox = opts.inbox;
          if (!inbox) {
            notImplemented(conn, message.requestId, 'The inbox');
            break;
          }
          // The stored snapshot first, so the app shows something instantly; then every poll.
          const snap = inbox.snapshot();
          if (snap.fetchedAt || snap.error) conn.send(inboxMessage(message.requestId, snap, []));
          const stop = inbox.subscribe((next, events) => conn.send(inboxMessage(message.requestId, next, events)));
          s.subscriptions.set(message.requestId, { topic: 'inbox', stop });
        } else {
          const reviewing = opts.reviewing;
          if (!reviewing) {
            notImplemented(conn, message.requestId, 'PR subscriptions');
            break;
          }
          // Current review state first (null: not started), then every change. Labels and progress join later.
          const pr = topic.pr;
          conn.send({ type: 'review', requestId: message.requestId, pr, review: reviewing.get(pr) ?? null });
          const stopReview = reviewing.subscribe((changed, review) => {
            if (samePr(changed, pr)) conn.send({ type: 'review', requestId: message.requestId, pr, review });
          });
          // Then the labels: the newest known, and every change.
          const labels = opts.labels;
          const current = labels?.get(pr);
          if (current) conn.send(labelsMessage(message.requestId, current));
          const stopLabels = labels?.subscribe((changed, view) => {
            if (samePr(changed, pr)) conn.send(labelsMessage(message.requestId, view));
          });
          s.subscriptions.set(message.requestId, {
            topic: 'pr',
            stop: () => {
              stopReview();
              stopLabels?.();
            },
          });
        }
        break;
      }
      case 'unsubscribe':
        s.subscriptions.get(message.requestId)?.stop?.();
        s.subscriptions.delete(message.requestId);
        conn.send({ type: 'ack', requestId: message.requestId });
        break;
      case 'inbox': {
        const inbox = opts.inbox;
        if (!inbox) {
          notImplemented(conn, message.requestId, 'The inbox');
          break;
        }
        const reply = () => conn.send(inboxMessage(message.requestId, inbox.snapshot(), []));
        if (message.refresh) inbox.refresh().then(reply, reply);
        else reply();
        break;
      }
      case 'start_review':
      case 'stop_review':
      case 'update_review': {
        const reviewing = opts.reviewing;
        if (!reviewing) {
          notImplemented(conn, message.requestId, 'Reviewing');
          break;
        }
        const reply = (review: ReturnType<ReviewingService['get']> | null) =>
          conn.send({ type: 'review', requestId: message.requestId, pr: message.pr, review: review ?? null });
        if (message.type === 'start_review') {
          reply(reviewing.start(message.pr, { agent: message.agent, model: message.model }));
        } else if (message.type === 'update_review') {
          reply(reviewing.update(message.pr));
        } else {
          reviewing.stop(message.pr, message.removeWorktree).then(
            () => reply(null),
            (err: unknown) => {
              log('stop review failed', String(err));
              reply(null);
            },
          );
        }
        break;
      }
      case 'risk_labels': {
        const { labels, reviewing } = opts;
        if (!labels || !reviewing) {
          notImplemented(conn, message.requestId, 'Risk labels');
          break;
        }
        // Labels run only for PRs being reviewed, at the review's commit. Cached labels for other commits still answer.
        const review = reviewing.get(message.pr);
        const headSha = message.headSha ?? review?.headSha;
        let view = headSha ? labels.get(message.pr, headSha) : undefined;
        const canRun = review && (review.phase === 'ready' || review.phase === 'stale') && headSha === review.headSha;
        if (canRun && (message.rerun || !view || view.status === 'failed')) {
          view = labels.run(message.pr, review.headSha, reviewing.settingsOf(message.pr), { rerun: message.rerun });
        }
        conn.send(
          labelsMessage(
            message.requestId,
            view ?? {
              pr: message.pr,
              headSha: headSha ?? '',
              status: 'failed',
              agent: 'cursor',
              model: '',
              files: [],
              error: review ? 'Labels run once the review worktree is ready.' : 'Start reviewing this PR to label its files.',
            },
          ),
        );
        break;
      }
      case 'pr_diff': {
        // A reviewed PR shows the reviewed commit unless the app asks for another.
        const pr = message.pr;
        const headSha = message.headSha ?? opts.reviewing?.get(pr)?.headSha;
        diffs.get(pr, headSha || undefined).then(
          ({ baseSha, headSha, files }) => conn.send({ type: 'pr_diff', requestId: message.requestId, pr, baseSha, headSha, files }),
          (err: unknown) => {
            log('pr diff failed', String(err));
            const e = err instanceof DiffError ? err : new DiffError('fetch_failed', (err as Error).message);
            conn.send({ type: 'event', requestId: message.requestId, event: { type: 'error', code: e.code, message: e.message, fixSteps: e.fixSteps } });
          },
        );
        break;
      }
      case 'setup_checks':
      case 'settings':
      case 'save_settings':
      case 'prune_worktrees':
      case 'diagnostics': {
        const svc = opts.settings;
        if (!svc) {
          notImplemented(conn, message.requestId, 'Settings');
          break;
        }
        const { requestId } = message;
        const failed = (err: unknown) => {
          log(message.type, 'failed', String(err));
          conn.send({ type: 'event', requestId, event: { type: 'error', code: 'bad_request', message: (err as Error).message } });
        };
        if (message.type === 'setup_checks') svc.setupChecks().then((checks) => conn.send({ type: 'setup_checks', requestId, checks }), failed);
        else if (message.type === 'diagnostics') svc.diagnostics().then((text) => conn.send({ type: 'diagnostics', requestId, text }), failed);
        else {
          const work = message.type === 'save_settings' ? svc.save(message.patch) : message.type === 'prune_worktrees' ? svc.prune() : svc.snapshot();
          work.then((snap) => conn.send({ type: 'settings', requestId, ...snap }), failed);
        }
        break;
      }
      case 'threads':
        if (!opts.threads) {
          notImplemented(conn, message.requestId, 'Stored threads');
          break;
        }
        conn.send({ type: 'threads', requestId: message.requestId, pr: message.pr, turns: opts.threads.list(message.pr) });
        break;
    }
  }

  /** The client went away: abort its asks and drop its subscriptions. Server-owned work keeps running. */
  function disconnect(conn: Connection): number {
    const s = connections.get(conn.id);
    if (!s) return 0;
    for (const c of s.running.values()) c.abort();
    for (const sub of s.subscriptions.values()) sub.stop?.();
    connections.delete(conn.id);
    return s.running.size;
  }

  /** Aborts every in-flight ask on every connection and stops agent processes. */
  function stopAll(): void {
    for (const s of connections.values()) for (const c of s.running.values()) c.abort();
    for (const adapter of Object.values(adapters)) adapter.shutdown?.();
  }

  const runningCount = () => [...connections.values()].reduce((n, s) => n + s.running.size, 0);

  return { handle, disconnect, stopAll, runningCount };
}

export type Router = ReturnType<typeof createRouter>;
