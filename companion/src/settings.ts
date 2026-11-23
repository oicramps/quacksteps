import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentStatus, DiagnosticsMessage, SettingsMessage, SettingsPatch, SetupCheck } from '@quacksteps/shared';
import { QUACK_VERSION } from '@quacksteps/shared';
import type { Adapter } from './adapters/types.ts';
import { redactSecrets } from './checks.ts';
import { type Config, loadConfig, saveSettings } from './config.ts';
import { doctorReport, ghAuth } from './doctor.ts';
import { findBinary, run, setExtraPath } from './exec.ts';
import { FIX_INSTALL_GH, FIX_LOGIN_GH, type GhRunner, fixSso, graphql, samlErrors } from './gh.ts';
import { log } from './log.ts';
import { SERVER_LOG_FILE, SOCKET_PATH, contractHome } from './paths.ts';
import { findClone, inspectWorkspace } from './repo.ts';
import { enforceRetention } from './worktree.ts';

/**
 * The server side of First run and Settings: the five setup checks, one settings snapshot, saving,
 * pruning and diagnostics. Everything external is injectable for tests.
 */

export interface SettingsDeps {
  adapters: Record<string, Adapter>;
  /** GitHub login and rate limit from the inbox poller. */
  github: () => SettingsMessage['github'];
  /** Repos the app knows about: from the inbox and reviews. */
  repos: () => { owner: string; repo: string }[];
  /** Worktrees of PRs being reviewed: never pruned. */
  reviewed: () => Set<string>;
  /** Called after settings were saved, so the server applies them (poll intervals, PATH). */
  onSaved?: (config: Config) => void;
  config?: () => Config;
  org?: string;
  startedAt?: string;
  gh?: GhRunner;
  /** Writes the patch; defaults to ~/.quack/config.json. */
  saveConfig?: (patch: SettingsPatch) => void;
  /** Overrides for tests. */
  checkGh?: () => Promise<SetupCheck>;
  checkClone?: (config: Config) => Promise<SetupCheck>;
}

const fixGit = [{ text: 'Install the Xcode command line tools, which include git', command: 'xcode-select --install' }];

export class SettingsService {
  private readonly deps: SettingsDeps;
  private readonly config: () => Config;
  private readonly org: string;
  private readonly startedAt: string;

  constructor(deps: SettingsDeps) {
    this.deps = deps;
    this.config = deps.config ?? (() => loadConfig());
    this.org = deps.org ?? 'polarsteps';
    this.startedAt = deps.startedAt ?? new Date().toISOString();
  }

  /** First run: server, gh with SSO, git, an agent, a clone. All five must pass. */
  async setupChecks(): Promise<SetupCheck[]> {
    const config = this.config();
    const [gh, git, agent, clone] = await Promise.all([
      (this.deps.checkGh ?? (() => this.checkGh()))(),
      this.checkGit(),
      this.checkAgents(),
      (this.deps.checkClone ?? ((c: Config) => this.checkClone(c)))(config),
    ]);
    const server: SetupCheck = { id: 'server', ok: true, title: 'Quack server is running', detail: `quackd ${QUACK_VERSION} at ${contractHome(SOCKET_PATH)}`, fixSteps: [] };
    return [server, gh, git, agent, clone];
  }

  async snapshot(extra: Partial<Pick<SettingsMessage, 'removed' | 'error'>> = {}): Promise<Omit<SettingsMessage, 'type' | 'requestId'>> {
    const config = this.config();
    const [worktrees, clones] = await Promise.all([worktreeStats(config.worktreeRoot), this.clones(config)]);
    return {
      settings: {
        scanRoots: config.scanRoots,
        repoPaths: config.repoPaths,
        worktreeRoot: config.worktreeRoot,
        retentionDays: config.retentionDays,
        maxWorktrees: config.maxWorktrees,
        chatAgent: config.agents.default ?? null,
        chatModel: config.agents.model,
        labelsAgent: config.labels.agent ?? null,
        labelsModel: config.labels.model,
        extraPath: config.extraPath,
        pollActiveSeconds: config.poll.activeSeconds,
        pollIdleSeconds: config.poll.idleSeconds,
      },
      server: { version: QUACK_VERSION, pid: process.pid, startedAt: this.startedAt, socketPath: SOCKET_PATH, logPath: SERVER_LOG_FILE },
      github: this.deps.github(),
      worktrees,
      clones,
      ...extra,
    };
  }

  /** Saves, applies, and returns the new snapshot. A failed write is reported, not thrown. */
  async save(patch: SettingsPatch) {
    try {
      (this.deps.saveConfig ?? saveSettings)(patch);
      this.deps.onSaved?.(this.config());
      return this.snapshot();
    } catch (err) {
      log('saving settings failed', String(err));
      return this.snapshot({ error: `Couldn't save settings: ${(err as Error).message}` });
    }
  }

  /** Settings › Prune now. Reviewed PRs' worktrees are kept. */
  async prune() {
    const config = this.config();
    const reviewed = this.deps.reviewed();
    const removed = await enforceRetention(config, (owner, repo) => findClone(config, owner, repo), Date.now(), (owner, repo, n) => reviewed.has(`${owner}/${repo}#${n}`));
    return this.snapshot({ removed });
  }

  /** Doctor output and the last 500 server log lines, with secrets and tokens removed. */
  async diagnostics(): Promise<DiagnosticsMessage['text']> {
    const report = JSON.stringify(await doctorReport(), null, 2);
    let tail = '';
    try {
      tail = (await fs.readFile(SERVER_LOG_FILE, 'utf8')).split('\n').slice(-501).join('\n');
    } catch {
      tail = '(no server log yet)';
    }
    return redactSecrets(`Quacksteps diagnostics\n\n== doctor ==\n${report}\n\n== last 500 lines of ${contractHome(SERVER_LOG_FILE)} ==\n${tail}`);
  }

  private async checkGh(): Promise<SetupCheck> {
    const title = `GitHub CLI can see ${this.org}`;
    const auth = await ghAuth();
    if (!auth.path) return { id: 'gh', ok: false, title, detail: "The GitHub CLI (gh) isn't installed.", fixSteps: FIX_INSTALL_GH };
    if (!auth.loggedIn) return { id: 'gh', ok: false, title, detail: "gh isn't logged in to github.com.", fixSteps: FIX_LOGIN_GH };
    try {
      const res = await graphql<{ organization: unknown }>('orgAccess', { login: this.org }, this.deps.gh);
      if (samlErrors(res.errors).length) {
        return {
          id: 'gh',
          ok: false,
          title,
          detail: `Logged in as ${auth.account}, but not authorised for the ${this.org} org's single sign-on. Org PRs would be missing.`,
          fixSteps: fixSso(this.org),
        };
      }
    } catch (err) {
      return { id: 'gh', ok: false, title, detail: `Couldn't ask GitHub: ${(err as Error).message}`, fixSteps: FIX_LOGIN_GH };
    }
    return { id: 'gh', ok: true, title, detail: `Logged in as ${auth.account}.`, fixSteps: [] };
  }

  private async checkGit(): Promise<SetupCheck> {
    const title = 'git is available';
    const bin = findBinary(['git']);
    if (!bin) return { id: 'git', ok: false, title, detail: "git isn't installed.", fixSteps: fixGit };
    const v = await run(bin, ['--version'], { timeoutMs: 10_000 });
    if (v.code !== 0) return { id: 'git', ok: false, title, detail: `git at ${bin} doesn't run. Xcode's license may need accepting.`, fixSteps: fixGit };
    return { id: 'git', ok: true, title, detail: `${v.stdout.trim().replace(/^git version /, 'git ')} at ${bin}`, fixSteps: [] };
  }

  private async checkAgents(): Promise<SetupCheck> {
    const title = 'An agent is ready';
    const statuses: AgentStatus[] = await Promise.all(
      Object.values(this.deps.adapters).map((a) =>
        a.isAvailable().catch((): AgentStatus => ({ id: a.id, label: a.label, state: 'not_installed', models: [], fixSteps: [] })),
      ),
    );
    const ready = statuses.filter((s) => s.state === 'ready');
    const describe = (s: AgentStatus) => `${s.label}${s.version ? ` ${s.version.split(/\s/)[0]}` : ''}`;
    const notes = statuses
      .filter((s) => s.state !== 'ready')
      .map((s) => `${s.label} ${s.state === 'not_logged_in' ? "isn't logged in" : "isn't installed"}`);
    if (ready.length) {
      const detail = `${ready.map(describe).join(' and ')} ${ready.length > 1 ? 'are' : 'is'} ready.${notes.length ? ` ${notes.join('; ')}; that's fine.` : ''}`;
      return { id: 'agent', ok: true, title, detail, fixSteps: [] };
    }
    // Prefer the agent closest to working: logged out beats not installed.
    const nearest = statuses.find((s) => s.state === 'not_logged_in') ?? statuses[0];
    return { id: 'agent', ok: false, title, detail: `${notes.join('; ')}.`, fixSteps: nearest?.fixSteps ?? [] };
  }

  private async checkClone(config: Config): Promise<SetupCheck> {
    const title = 'Found a clone';
    const ws = await inspectWorkspace();
    const where = config.scanRoots.map(contractHome).slice(0, 3).join(', ');
    if (ws.totalRepos > 0) {
      const plural = `${ws.totalRepos} clone${ws.totalRepos === 1 ? '' : 's'}`;
      const roots = ws.roots.filter((r) => r.repoCount).map((r) => contractHome(r.path));
      // Clones can also come only from linked paths (repoPaths), outside every scan folder.
      return { id: 'clone', ok: true, title, detail: roots.length ? `${plural} in ${roots.join(', ')}` : `${plural} linked in Settings`, fixSteps: [] };
    }
    const blocked = ws.roots.filter((r) => r.state === 'blocked').map((r) => contractHome(r.path));
    return {
      id: 'clone',
      ok: false,
      title,
      detail: blocked.length ? `Quacksteps can't read ${blocked.join(', ')}.` : `No clones in ${where || 'your project folders'} yet.`,
      fixSteps: [
        { text: 'Choose the folder where you keep your clones, or clone one now.' },
        { text: `Clone a ${this.org} repo`, command: `git clone git@github.com:${this.org}/<repo>.git ~/code/<repo>` },
      ],
    };
  }

  private async clones(config: Config): Promise<SettingsMessage['clones']> {
    const seen = new Map<string, { owner: string; repo: string }>();
    for (const r of this.deps.repos()) seen.set(`${r.owner}/${r.repo}`.toLowerCase(), r);
    const out = await Promise.all(
      [...seen.values()].map(async (r) => ({ repo: `${r.owner}/${r.repo}`, path: await findClone(config, r.owner, r.repo).catch(() => null) })),
    );
    return out.sort((a, b) => Number(!a.path) - Number(!b.path) || a.repo.localeCompare(b.repo));
  }
}

/** Applies the config parts the server uses at runtime. */
export function applyConfig(config: Config): void {
  setExtraPath(config.extraPath);
}

/** Counts `<root>/<owner>/<repo>/pr-<n>` worktrees and their disk use (via `du`, which handles big trees fast). */
export async function worktreeStats(root: string): Promise<SettingsMessage['worktrees']> {
  let count = 0;
  try {
    for (const owner of await fs.readdir(root, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      for (const repo of await fs.readdir(path.join(root, owner.name), { withFileTypes: true })) {
        if (!repo.isDirectory()) continue;
        count += (await fs.readdir(path.join(root, owner.name, repo.name))).filter((n) => /^pr-\d+$/.test(n)).length;
      }
    }
  } catch {
    return { root, count: 0, bytes: 0 };
  }
  const du = await run('/usr/bin/du', ['-sk', root], { timeoutMs: 30_000 });
  const kb = Number.parseInt(du.stdout, 10);
  return { root, count, bytes: Number.isFinite(kb) ? kb * 1024 : 0 };
}
