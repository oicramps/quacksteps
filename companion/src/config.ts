import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, HOME, QUACK_DIR, contractHome, expandHome } from './paths.ts';
import type { AgentId, SettingsPatch } from '@quack/shared';
import { log } from './log.ts';

export interface Config {
  /** Folders searched (two levels deep) for clones whose origin matches the PR's repo. */
  scanRoots: string[];
  /** Manual overrides: "owner/repo" -> local clone path. */
  repoPaths: Record<string, string>;
  worktreeRoot: string;
  retentionDays: number;
  maxWorktrees: number;
  /** Chat defaults (`agents.default`, `agents.model`). Unset: the app picks the first ready agent. */
  agents: { default?: AgentId; model: string };
  /** Risk labels (`labels.agent`, `labels.model`). An unset agent means "same as chat". */
  labels: { agent?: AgentId; model: string };
  /** Extra folders searched for agent CLIs, git and gh, before the built-in ones. */
  extraPath: string[];
  /** Inbox polling: with the app open, and with no window open. */
  poll: { activeSeconds: number; idleSeconds: number };
}

const AGENT_IDS: readonly AgentId[] = ['cursor', 'claude-code'];
const isAgent = (v: unknown): v is AgentId => typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v);
const int = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
// Model names become CLI arguments: no leading dash (same rule as the socket validator).
const modelName = (v: unknown) => (typeof v === 'string' && /^(?:[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99})?$/.test(v) ? v : '');

export const DEFAULT_SCAN_ROOTS = [
  '~/Documents/Dev/Projects',
  '~/Projects',
  '~/Developer',
  '~/Development',
  '~/Dev',
  '~/repos',
  '~/src',
  '~/code',
  '~/workspace',
  '~/work',
  '~/GitHub',
  '~/git',
];

export const DEFAULTS: Config = {
  scanRoots: DEFAULT_SCAN_ROOTS,
  repoPaths: {},
  worktreeRoot: path.join(QUACK_DIR, 'worktrees').replace(HOME, '~'),
  retentionDays: 7,
  maxWorktrees: 20,
  agents: { model: '' },
  labels: { model: '' },
  extraPath: [],
  poll: { activeSeconds: 60, idleSeconds: 300 },
};

/** Limits for the settings the app can change (also enforced when loading a hand-edited file). */
export const LIMITS = {
  retentionDays: [1, 365],
  maxWorktrees: [1, 500],
  pollActiveSeconds: [30, 3600],
  pollIdleSeconds: [60, 3600],
} as const;

export function hasConfigFile(configFile = CONFIG_FILE): boolean {
  try {
    return fs.existsSync(configFile);
  } catch {
    return false;
  }
}

export function loadConfig(configFile = CONFIG_FILE): Config {
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('config unreadable, using defaults:', String(err));
    }
  }
  const merged = {
    ...DEFAULTS,
    ...fromFile,
    scanRoots: Array.isArray(fromFile.scanRoots) ? fromFile.scanRoots.filter((s): s is string => typeof s === 'string') : DEFAULTS.scanRoots,
    repoPaths:
      fromFile.repoPaths && typeof fromFile.repoPaths === 'object' && !Array.isArray(fromFile.repoPaths)
        ? fromFile.repoPaths
        : DEFAULTS.repoPaths,
  };
  const raw = fromFile as Record<string, unknown>;
  const agents = (raw.agents ?? {}) as Record<string, unknown>;
  const labels = (raw.labels ?? {}) as Record<string, unknown>;
  const poll = (raw.poll ?? {}) as Record<string, unknown>;
  return {
    ...merged,
    retentionDays: int(raw.retentionDays, ...LIMITS.retentionDays, DEFAULTS.retentionDays),
    maxWorktrees: int(raw.maxWorktrees, ...LIMITS.maxWorktrees, DEFAULTS.maxWorktrees),
    agents: { ...(isAgent(agents.default) && { default: agents.default }), model: modelName(agents.model) },
    labels: { ...(isAgent(labels.agent) && { agent: labels.agent }), model: modelName(labels.model) },
    extraPath: Array.isArray(raw.extraPath) ? raw.extraPath.filter((p): p is string => typeof p === 'string' && p.length > 0).map(expandHome) : [],
    poll: {
      activeSeconds: int(poll.activeSeconds, ...LIMITS.pollActiveSeconds, DEFAULTS.poll.activeSeconds),
      idleSeconds: int(poll.idleSeconds, ...LIMITS.pollIdleSeconds, DEFAULTS.poll.idleSeconds),
    },
    scanRoots: merged.scanRoots.map(expandHome),
    repoPaths: Object.fromEntries(
      Object.entries(merged.repoPaths).map(([k, v]) => [k.toLowerCase(), expandHome(String(v))]),
    ),
    worktreeRoot: expandHome(merged.worktreeRoot),
  };
}

function readRawConfig(configFile = CONFIG_FILE): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { ...DEFAULTS };
}

/** Writes to a temp file, then renames: a crash never leaves a half-written config.json. */
function writeRawConfig(raw: Record<string, unknown>, configFile = CONFIG_FILE): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const tmp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configFile);
}

/** Saves an explicit `"owner/repo": "<path>"` mapping into config.json, preserving other settings. */
export function setRepoPath(ownerRepo: string, cloneDir: string, configFile = CONFIG_FILE): void {
  const raw = readRawConfig(configFile);
  const existing =
    raw.repoPaths && typeof raw.repoPaths === 'object' && !Array.isArray(raw.repoPaths)
      ? (raw.repoPaths as Record<string, string>)
      : {};
  raw.repoPaths = { ...existing, [ownerRepo.toLowerCase()]: contractHome(path.resolve(cloneDir)) };
  writeRawConfig(raw, configFile);
}

/** Saves `scanRoots` and/or `repoPaths` updates into config.json. */
export function saveWorkspaceConfig(
  patch: { scanRoots?: string[]; repoPaths?: Record<string, string | null> },
  configFile = CONFIG_FILE,
): void {
  const raw = readRawConfig(configFile);
  if (patch.scanRoots !== undefined) {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const r of patch.scanRoots) {
      const normalized = contractHome(path.resolve(expandHome(r)));
      if (!seen.has(normalized)) {
        seen.add(normalized);
        roots.push(normalized);
      }
    }
    raw.scanRoots = roots;
  }
  if (patch.repoPaths !== undefined) {
    const existing =
      raw.repoPaths && typeof raw.repoPaths === 'object' && !Array.isArray(raw.repoPaths)
        ? { ...(raw.repoPaths as Record<string, string>) }
        : {};
    for (const [k, v] of Object.entries(patch.repoPaths)) {
      const key = k.toLowerCase();
      if (v === null) delete existing[key];
      else existing[key] = contractHome(path.resolve(expandHome(v)));
    }
    raw.repoPaths = existing;
  }
  writeRawConfig(raw, configFile);
}

/** Writes a validated patch into config.json, keeping every other key. */
export function saveSettings(patch: SettingsPatch, configFile = CONFIG_FILE): void {
  const raw = readRawConfig(configFile);
  const obj = (k: string) => (raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k]) ? { ...(raw[k] as Record<string, unknown>) } : {});
  if (patch.retentionDays !== undefined) raw.retentionDays = patch.retentionDays;
  if (patch.maxWorktrees !== undefined) raw.maxWorktrees = patch.maxWorktrees;
  if (patch.chatAgent !== undefined || patch.chatModel !== undefined) {
    const agents = obj('agents');
    if (patch.chatAgent === null) delete agents.default;
    else if (patch.chatAgent !== undefined) agents.default = patch.chatAgent;
    if (patch.chatModel !== undefined) agents.model = patch.chatModel;
    raw.agents = agents;
  }
  if (patch.labelsAgent !== undefined || patch.labelsModel !== undefined) {
    const labels = obj('labels');
    if (patch.labelsAgent === null) delete labels.agent;
    else if (patch.labelsAgent !== undefined) labels.agent = patch.labelsAgent;
    if (patch.labelsModel !== undefined) labels.model = patch.labelsModel;
    raw.labels = labels;
  }
  if (patch.extraPath !== undefined) {
    const worktrees = path.resolve(loadConfig(configFile).worktreeRoot);
    const dirs = patch.extraPath.map((p) => path.resolve(expandHome(p)));
    // A PR can ship an executable called git or gh; never search PR worktrees for programs.
    if (dirs.some((d) => d === worktrees || d.startsWith(worktrees + path.sep))) throw new Error('Extra PATH folders cannot be inside Quack’s worktrees.');
    raw.extraPath = dirs.map(contractHome);
  }
  if (patch.pollActiveSeconds !== undefined || patch.pollIdleSeconds !== undefined) {
    const poll = obj('poll');
    if (patch.pollActiveSeconds !== undefined) poll.activeSeconds = patch.pollActiveSeconds;
    if (patch.pollIdleSeconds !== undefined) poll.idleSeconds = patch.pollIdleSeconds;
    raw.poll = poll;
  }
  writeRawConfig(raw, configFile);
}
