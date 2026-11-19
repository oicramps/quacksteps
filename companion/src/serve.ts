import fs from 'node:fs';
import path from 'node:path';
import { type AgentId, QUACK_VERSION } from '@quack/shared';
import { REST, restGet } from './gh.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { InboxService } from './inbox.ts';
import { LabelRunner } from './labels.ts';
import { ThreadStore } from './threads.ts';
import { SettingsService, applyConfig } from './settings.ts';
import { adapters } from './adapters/index.ts';
import { ReviewingService } from './reviewing.ts';
import { configureLog, log } from './log.ts';
import { LOCK_PATH, SERVER_LOG_FILE, SOCKET_PATH } from './paths.ts';
import { findClone } from './repo.ts';
import { createRouter } from './router.ts';
import { type SocketServer, ensurePrivateDir, startSocketServer } from './socket.ts';
import { enforceRetention } from './worktree.ts';

const DRAIN_MS = 5_000;
/** A closed or merged PR's review (and worktree) is kept this long, for a last look. */
const CLOSED_GRACE_MS = 24 * 3600_000;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to someone else, so it is alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Takes the single-instance lock: a pid file created exclusively in the 0700 run directory.
 * Returns false when another live server holds it. A lock left by a dead process is taken over.
 */
export function acquireInstanceLock(lockPath: string): boolean {
  ensurePrivateDir(path.dirname(lockPath));
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const holder = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
  if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isAlive(holder)) return false;
  fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
  return true;
}

/** Removes the lock only if this process still owns it. */
export function releaseInstanceLock(lockPath: string): void {
  try {
    if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.rmSync(lockPath, { force: true });
  } catch {
    // Already gone.
  }
}

export interface ServeOptions {
  socketPath?: string;
  lockPath?: string;
  /** Tests pass false to keep the process alive; the real server exits after draining. */
  exitProcess?: boolean;
  /** Defaults to ~/.quack/state.db. */
  dbPath?: string;
  /** Tests pass false to keep the poller off. */
  inbox?: boolean;
}

export interface RunningServer {
  /** Stops accepting connections, aborts asks and kills agent process groups, then resolves. */
  drain(reason: string): Promise<void>;
}

/**
 * `quackd serve`: the long-running server launchd keeps alive for the Mac app.
 * Exit codes matter to launchd (`KeepAlive: {SuccessfulExit: false}`):
 *  - 0: a second instance found the lock taken, or SIGTERM (launchd stopping us). Stays down.
 *  - 1: a `shutdown` request (app upgrade). launchd restarts the new binary.
 */
export async function serve(opts: ServeOptions = {}): Promise<RunningServer | null> {
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  const lockPath = opts.lockPath ?? LOCK_PATH;
  const exitProcess = opts.exitProcess ?? true;

  if (exitProcess) configureLog(SERVER_LOG_FILE, { maxBytes: 5 * 1024 * 1024, keep: 3 });

  if (!acquireInstanceLock(lockPath)) {
    log('another server holds', lockPath, '- exiting');
    if (exitProcess) process.exit(0);
    return null;
  }
  log('server starting', QUACK_VERSION, 'pid', process.pid);

  let draining: Promise<void> | null = null;
  let exitCode = 0;
  const startConfig = loadConfig();
  applyConfig(startConfig);
  const db = openDb(opts.dbPath);
  // Labels run when a review becomes ready at a new commit, with the agent chosen when reviewing started.
  const labels: LabelRunner = new LabelRunner({ db, onStatus: (pr, status) => reviewing.setLabels(pr, status) });
  // The agent chosen at Start reviewing, else Settings' labels agent, else the chat agent.
  const labelSettings = (chosen: { agent?: AgentId; model?: string }) => {
    const c = loadConfig();
    const agent = chosen.agent ?? c.labels.agent ?? c.agents.default;
    // A labels model set without a labels agent applies to the chat agent ("Same as chat" plus a faster model).
    const model = chosen.agent ? chosen.model : c.labels.agent ? c.labels.model : c.labels.model || c.agents.model;
    return { ...(agent && { agent }), ...(model && { model }) };
  };
  const reviewing: ReviewingService = new ReviewingService({
    db,
    onReady: (pr, review, settings) => labels.run(pr, review.headSha, labelSettings(settings)),
    // "3 new commits" on a stale review: GitHub's compare, read-only, once per new head.
    countCommits: async (pr, base, head) => {
      const out = await restGet(REST.compare(pr.owner, pr.repo, base, head), { jq: '.ahead_by' });
      const n = Number.parseInt(out.trim(), 10);
      return Number.isInteger(n) && n >= 0 ? n : null;
    },
  });
  // Stopping a review stops its label job.
  reviewing.subscribe((pr, review) => review === null && labels.cancel(pr));
  // Labels a restart interrupted (or that never ran) start again for ready reviews.
  for (const { pr, review } of reviewing.all()) {
    if (review.phase === 'ready' && (review.labels === 'running' || review.labels === 'none')) labels.run(pr, review.headSha, labelSettings(reviewing.settingsOf(pr)));
  }
  const inbox = new InboxService({
    db,
    activeMs: startConfig.poll.activeSeconds * 1000,
    idleMs: startConfig.poll.idleSeconds * 1000,
    reviewOf: (pr) => reviewing.get(pr),
    // Reviewed PRs the searches miss stay in the inbox; closed or merged ones end a day after closing.
    reviewed: () => reviewing.all().map(({ pr }) => pr),
    onClosed: (pr, closed) => {
      if (!reviewing.get(pr)) return;
      if (Date.now() - Date.parse(closed.at) < CLOSED_GRACE_MS) {
        // Within the grace day: the PR tab shows "Merged by … 10 min ago" and offers Stop reviewing.
        reviewing.setClosed(pr, closed);
        return;
      }
      log('review: PR', closed.state, closed.at, '- stopping and removing its worktree', `${pr.owner}/${pr.repo}#${pr.number}`);
      void reviewing.stop(pr, true).catch((err: unknown) => log('stopping a closed review failed', String(err)));
    },
    // New commits on a PR being reviewed make the review stale (the worktree stays put until Update).
    onPoll: (items) => {
      for (const item of items) reviewing.noteHead(item.pr, item.headSha);
    },
  });
  // Starting or stopping a review changes the inbox's "Reviewing" filter right away.
  reviewing.subscribe(() => inbox.republish());
  const threads = new ThreadStore(db);
  const reviewedKeys = () => new Set(reviewing.all().map(({ pr }) => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()));
  const settings = new SettingsService({
    adapters,
    github: () => ({ viewer: inbox.viewer, rateLimit: inbox.rateLimit }),
    repos: () => [...inbox.snapshot().items.map((i) => i.pr), ...reviewing.all().map((r) => r.pr)],
    reviewed: reviewedKeys,
    onSaved: (config) => {
      applyConfig(config);
      inbox.setIntervals(config.poll.activeSeconds * 1000, config.poll.idleSeconds * 1000);
    },
  });
  const router = createRouter({
    threads,
    settings,
    inbox,
    reviewing,
    labels,
    onShutdown: () => {
      exitCode = 1;
      void drain('shutdown request');
    },
  });

  let server: SocketServer;
  try {
    server = await startSocketServer({ socketPath, router });
  } catch (err) {
    releaseInstanceLock(lockPath);
    throw err;
  }

  // Polls from the start, so notifications arrive even before the app connects (every 5 min idle, 1 min with a client).
  if (opts.inbox ?? true) inbox.start();
  // Reviews a restart interrupted mid-preparation pick up where they were.
  reviewing.resume();

  // Retention at start, then daily. Worktrees of PRs being reviewed are kept.
  const prune = () => {
    const config = loadConfig();
    labels.prune();
    threads.prune();
    const reviewed = new Set(reviewing.all().map(({ pr }) => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()));
    void enforceRetention(config, (owner, repo) => findClone(config, owner, repo), Date.now(), (owner, repo, n) => reviewed.has(`${owner}/${repo}#${n}`))
      .then((removed) => removed.length && log('retention removed', removed.length, 'worktree(s)'))
      .catch((err: unknown) => log('retention failed', err instanceof Error ? err.message : String(err)));
  };
  prune();
  const pruneTimer = setInterval(prune, 24 * 3600_000);
  pruneTimer.unref();

  function drain(reason: string): Promise<void> {
    draining ??= (async () => {
      log('draining:', reason, `(${router.runningCount()} running)`);
      // Abort asks first: adapters kill their process groups as each ask unwinds.
      router.stopAll();
      labels.stopAll();
      inbox.stop();
      clearInterval(pruneTimer);
      const deadline = Date.now() + DRAIN_MS;
      while (router.runningCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await server.close();
      db.close();
      releaseInstanceLock(lockPath);
      log('server stopped, exit code', exitCode);
      if (exitProcess) process.exit(exitCode);
    })();
    return draining;
  }

  if (exitProcess) {
    process.on('SIGTERM', () => void drain('SIGTERM'));
    process.on('SIGINT', () => void drain('SIGINT'));
  }

  return { drain };
}
