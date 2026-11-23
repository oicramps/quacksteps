export type AgentId = 'cursor' | 'claude-code';

export type AgentState = 'ready' | 'not_logged_in' | 'not_installed';

/** `thinking`: the agent is running and working on the answer, before any output. */
export type ProgressStep =
  | 'finding_repo'
  | 'fetching_pr'
  | 'preparing_worktree'
  | 'fetching_ci'
  | 'starting_agent'
  | 'thinking'
  // Socket protocol (v2) only: a risk-label run on a PR being reviewed.
  | 'labeling';

/** Set on an ask that should explain failing checks instead of answering free text. */
export type AskTask = 'explain_ci';

export type ErrorCode =
  | 'bad_request'
  | 'repo_not_found'
  | 'fetch_failed'
  | 'agent_not_installed'
  | 'agent_not_logged_in'
  | 'timeout'
  | 'cancelled'
  | 'agent_failed'
  | 'version_mismatch'
  // Socket protocol (v2) only.
  | 'gh_unavailable'
  | 'gh_not_logged_in'
  /** GitHub hid an org's PRs because the CLI isn't authorised for its SAML single sign-on. */
  | 'gh_sso_required'
  | 'rate_limited'
  | 'server_busy'
  | 'not_implemented';

export interface FixStep {
  text: string;
  command?: string;
}

export interface AgentStatus {
  id: AgentId;
  label: string;
  state: AgentState;
  version?: string;
  /** Where the CLI was found (Settings › Agents shows it; launchd's PATH is minimal). */
  path?: string;
  /** Empty string means "let the tool pick its default model". */
  models: string[];
  fixSteps: FixStep[];
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** Set when the page shows a specific commit; otherwise the companion resolves it. */
  headSha?: string;
  baseRef?: string;
  title?: string;
}

export interface CodeSelection {
  path?: string;
  /** GitHub's file anchor (SHA-256 of the path), used when the page doesn't expose the path. */
  fileAnchor?: string;
  /** 'old' when the lines refer to the base version (a deleted or changed line's left side). */
  side?: 'old' | 'new';
  startLine?: number;
  endLine?: number;
  /** The selected text, so the agent sees the code even when line numbers can't be read. */
  text?: string;
}

// Extension -> companion

export interface StatusRequest {
  type: 'status';
  requestId: string;
}

export interface AskRequest {
  type: 'ask';
  requestId: string;
  agent: AgentId;
  model: string;
  pr: PrRef;
  selections: CodeSelection[];
  question: string;
  sessionId: string | null;
  /** Earlier turns of the thread, sent when it continues on a new agent session (e.g. after switching agents). */
  history?: HistoryTurn[];
  task?: AskTask;
}

export interface HistoryTurn {
  question: string;
  answer: string;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: string;
}

/** A check that is failing on the pull request. `link` opens the job on GitHub. */
export interface CheckRun {
  name: string;
  workflow: string;
  link: string;
  runId?: string;
  jobId?: string;
}

export interface ChecksRequest {
  type: 'checks';
  requestId: string;
  pr: PrRef;
}

/** The thread is over: the companion can stop the agent process kept open for it. No reply. */
export interface CloseSessionRequest {
  type: 'close_session';
  requestId: string;
  agent: AgentId;
  sessionId: string;
}

export interface WorkspacePrTarget {
  owner: string;
  repo: string;
}

export interface WorkspaceCheckRequest {
  type: 'workspace_check';
  requestId: string;
  pr?: WorkspacePrTarget;
}

export interface WorkspaceSaveRequest {
  type: 'workspace_save';
  requestId: string;
  /** Replace configured scanRoots when provided. */
  scanRoots?: string[];
  /** Add a single folder of repos or an individual git clone path. */
  addPath?: string;
  /** Remove or set repoPaths entries (null removes the key). */
  repoPaths?: Record<string, string | null>;
  pr?: WorkspacePrTarget;
}

export type ExtensionMessage =
  | StatusRequest
  | AskRequest
  | CancelRequest
  | CloseSessionRequest
  | ChecksRequest
  | WorkspaceCheckRequest
  | WorkspaceSaveRequest;

// Companion -> extension

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; summary: string }
  | { type: 'done'; sessionId: string | null; headSha: string; model: string }
  | { type: 'error'; code: ErrorCode; message: string; fixSteps?: FixStep[] };

export type RootState = 'ok' | 'empty' | 'missing' | 'blocked';

export interface RootCheck {
  path: string;
  state: RootState;
  repoCount: number;
}

export interface RepoOverrideCheck {
  repo: string;
  path: string;
  state: 'ok' | 'missing' | 'blocked' | 'not_git' | 'mismatch';
  detail?: string;
}

export interface WorkspaceStatus {
  /** True when ~/.quack/config.json exists on disk. */
  configured: boolean;
  /** False when the companion could not run `git --version`. */
  gitAvailable: boolean;
  roots: RootCheck[];
  overrides: RepoOverrideCheck[];
  /** Total accessible git repositories across scanRoots and valid repoPaths. */
  totalRepos: number;
  /** Present when checked for an open PR. */
  prMatch?: {
    repo: string;
    found: boolean;
    path?: string;
    detail?: string;
  };
}

export interface StatusResponse {
  type: 'status';
  requestId: string;
  version: string;
  /** PROTOCOL_VERSION of this companion. Missing on companions from before it existed. */
  protocol?: number;
  /** Feature flags advertised by the companion. */
  capabilities?: { workspace?: boolean };
  /** The agents checked so far. */
  agents: AgentStatus[];
  /** Agents still being checked. A further status message follows until this is empty or absent. */
  pending?: AgentId[];
}

export interface WorkspaceResponse {
  type: 'workspace';
  requestId: string;
  workspace: WorkspaceStatus;
  /** Validation or permission error when saving a new path, if any. */
  error?: string;
  /** Human-readable note when a path was added/verified. */
  notice?: string;
}

export interface ChecksResponse {
  type: 'checks';
  requestId: string;
  failing: CheckRun[];
  /** False when gh is missing or not logged in. The panel then hides the CI row. */
  available: boolean;
}

export interface ProgressMessage {
  type: 'progress';
  requestId: string;
  step: ProgressStep;
  detail?: string;
}

export interface EventMessage {
  type: 'event';
  requestId: string;
  event: AgentEvent;
}

export type CompanionMessage = StatusResponse | ProgressMessage | EventMessage | ChecksResponse | WorkspaceResponse;

// ---------------------------------------------------------------------------
// Socket protocol (v2): the Mac app <-> quackd over ~/.quack/run/quack.sock.
// Every message above is also valid on the socket. The stdio host never sees these.
// ---------------------------------------------------------------------------

/** Identifies a pull request without a commit. Reviews, labels and threads are keyed by it. */
export interface PrKey {
  owner: string;
  repo: string;
  number: number;
}

// App -> server

/** Must be the first message on a connection. */
export interface HelloRequest {
  type: 'hello';
  requestId: string;
  client: 'mac-app' | 'cli';
  clientVersion: string;
  protocol: number;
}

/** Drains and exits with code 1 so launchd restarts the (new) binary. Used for upgrades. */
export interface ShutdownRequest {
  type: 'shutdown';
  requestId: string;
}

export type SubscriptionTopic = 'inbox' | 'agents' | { pr: PrKey };

export interface SubscribeRequest {
  type: 'subscribe';
  requestId: string;
  topic: SubscriptionTopic;
}

/** `requestId` is the subscription's requestId. */
export interface UnsubscribeRequest {
  type: 'unsubscribe';
  requestId: string;
}

/** One inbox snapshot; `refresh` forces a poll first. */
export interface InboxRequest {
  type: 'inbox';
  requestId: string;
  refresh?: boolean;
}

/**
 * "Start reviewing" (the tech spec's "claim"): prepares a warm worktree at the PR's head and ranks
 * its files. Replies with a ReviewMessage; later changes arrive on the `{ pr }` subscription.
 * Starting a PR that is already being reviewed just returns its state.
 */
export interface StartReviewRequest {
  type: 'start_review';
  requestId: string;
  pr: PrKey;
  /** The labels agent and model; default to the server's settings. */
  agent?: AgentId;
  model?: string;
}

/** "Stop reviewing". The worktree stays for the lazy ask path unless `removeWorktree`. */
export interface StopReviewRequest {
  type: 'stop_review';
  requestId: string;
  pr: PrKey;
  removeWorktree?: boolean;
}

/** "Update": moves a stale review's worktree to the PR's new head and re-runs labels. */
export interface UpdateReviewRequest {
  type: 'update_review';
  requestId: string;
  pr: PrKey;
}

export interface RiskLabelsRequest {
  type: 'risk_labels';
  requestId: string;
  pr: PrKey;
  headSha?: string;
  rerun?: boolean;
}

export interface PrDiffRequest {
  type: 'pr_diff';
  requestId: string;
  pr: PrKey;
  headSha?: string;
}

/** Stored chat turns for this PR. */
export interface ThreadsRequest {
  type: 'threads';
  requestId: string;
  pr: PrKey;
}

/** First run: the five checks, with fix steps for the failing ones. */
export interface SetupChecksRequest {
  type: 'setup_checks';
  requestId: string;
}

/** Settings window: config, server, GitHub and worktree facts in one reply. */
export interface SettingsRequest {
  type: 'settings';
  requestId: string;
}

/** What Settings can change besides scan folders and linked clones (those go through `workspace_save`). */
export interface SettingsPatch {
  retentionDays?: number;
  maxWorktrees?: number;
  chatAgent?: AgentId | null;
  chatModel?: string;
  /** null: the labels use the chat agent. */
  labelsAgent?: AgentId | null;
  labelsModel?: string;
  extraPath?: string[];
  pollActiveSeconds?: number;
  pollIdleSeconds?: number;
}

/** Saves the patch and replies with `settings`. */
export interface SaveSettingsRequest {
  type: 'save_settings';
  requestId: string;
  patch: SettingsPatch;
}

/** Settings › Prune now: applies retention right away and replies with `settings`. */
export interface PruneWorktreesRequest {
  type: 'prune_worktrees';
  requestId: string;
}

/** Settings › Copy diagnostics: doctor output and the last 500 log lines, secrets removed. */
export interface DiagnosticsRequest {
  type: 'diagnostics';
  requestId: string;
}

export type AppMessage =
  | ExtensionMessage
  | HelloRequest
  | ShutdownRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | InboxRequest
  | StartReviewRequest
  | StopReviewRequest
  | UpdateReviewRequest
  | RiskLabelsRequest
  | PrDiffRequest
  | ThreadsRequest
  | SetupChecksRequest
  | SettingsRequest
  | SaveSettingsRequest
  | PruneWorktreesRequest
  | DiagnosticsRequest;

// Server -> app

export interface HelloResponse {
  type: 'hello';
  requestId: string;
  version: string;
  protocol: number;
  /** GitHub login from `gh`, or null when unknown. */
  viewer: string | null;
  capabilities: { workspace: true; inbox: boolean; labels: boolean; review: boolean; agents: AgentId[] };
}

export type AuthorState = 'waiting_on_reviewers' | 'waiting_on_me' | 'blocked_by_ci' | 'ready_to_merge';

/** Where "Start reviewing" got to while preparing; drives the design spec's four-step checklist. */
export type ReviewStep = 'finding_clone' | 'fetching' | 'checking_out' | 'labeling';

/**
 * A PR being reviewed. No state at all means "Not started".
 * - preparing: finding the clone, fetching, checking out (see `step`).
 * - ready: the worktree is at `headSha`.
 * - stale: GitHub has `latestHeadSha`; the worktree stays at `headSha` until Update.
 * - failed: preparing failed; `error` and `fixSteps` say why.
 */
export interface ReviewState {
  startedAt: string;
  headSha: string;
  latestHeadSha: string;
  worktreePath: string;
  phase: 'preparing' | 'ready' | 'stale' | 'failed';
  step?: ReviewStep;
  labels: 'none' | 'running' | 'ready' | 'failed';
  error?: string;
  fixSteps?: FixStep[];
  /** Set when the PR was merged or closed; the review ends a day later. */
  closed?: ClosedInfo;
  /** While stale: how many commits `latestHeadSha` is ahead of `headSha` ("3 new commits"), when GitHub says. */
  newCommits?: number;
}

export interface ClosedInfo {
  state: 'merged' | 'closed';
  at: string;
  /** Who merged it, when GitHub says. */
  by?: string;
}

export interface InboxItem {
  pr: PrKey;
  title: string;
  url: string;
  /** The PR author's GitHub login. (The tech spec named this `author`, which clashed with the field below.) */
  authorLogin: string;
  isDraft: boolean;
  headSha: string;
  baseRef: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  role: 'reviewer' | 'author';
  /**
   * `requested: false` when my review is no longer requested (I already reviewed) but I'm still
   * reviewing the PR here; such items stay in the "Reviewing" filter and don't count as waiting.
   */
  reviewer?: {
    requestedAt: string;
    via: 'user' | 'team';
    team?: string;
    requested?: false;
    /** Other reviewers who already approved. Set: the request isn't waiting on me (shown lower, not counted). */
    approvedBy?: string[];
  };
  /** `state` is null for drafts. */
  author?: { state: AuthorState | null; since: string; reasons: string[] };
  ci: 'passing' | 'failing' | 'pending' | 'none';
  /** Set while I'm reviewing this PR (the inbox's "Reviewing" filter). */
  review?: ReviewState;
  /** Set when the PR is part of a stack: its base branch is another open PR's head, or another PR sits on top of it. */
  stack?: StackInfo;
  /** Whether the repo belongs to an organization or a person (the inbox's account picker groups by it). */
  ownerType?: 'org' | 'user';
}

/** A PR's place in a stack of PRs, bottom (1) to top (size). */
export interface StackInfo {
  position: number;
  size: number;
  /** The PR this one sits on top of, if any. */
  parent?: { number: number; title: string };
}

export type InboxEvent =
  | { kind: 'review_requested'; pr: PrKey }
  | { kind: 'state_changed'; pr: PrKey; from: AuthorState | null; to: AuthorState | null }
  | { kind: 'ci_failed'; pr: PrKey; headSha: string }
  | { kind: 'new_commits'; pr: PrKey; headSha: string };

export interface InboxMessage {
  type: 'inbox';
  requestId: string;
  fetchedAt: string;
  items: InboxItem[];
  /** What changed since the last message on this subscription. */
  events: InboxEvent[];
  /** Results GitHub reported beyond the 100 fetched per search. */
  more?: { reviewer: number; author: number };
  error?: { code: ErrorCode; message: string; fixSteps?: FixStep[] };
}

/** The reply to start/stop/update, and pushed on a `{ pr }` subscription whenever the review changes. Null: not reviewing. */
export interface ReviewMessage {
  type: 'review';
  requestId: string;
  pr: PrKey;
  review: ReviewState | null;
}

export interface FileRisk {
  path: string;
  risk: 'high' | 'medium' | 'low' | 'unlabeled';
  reason: string;
  rank: number;
  source: 'agent' | 'rule';
}

export interface RiskLabelsMessage {
  type: 'risk_labels';
  requestId: string;
  pr: PrKey;
  headSha: string;
  status: 'running' | 'ready' | 'failed';
  agent: AgentId;
  model: string;
  generatedAt?: string;
  files: FileRisk[];
  /**
   * Set while running when `files` are an older commit's labels, kept visible (dimmed) until the
   * new run finishes.
   */
  previousHeadSha?: string;
  /** Waiting for a free label slot (the server runs at most 2 jobs at once): the spec's `server_busy`. */
  queued?: boolean;
  /** While running: when the job started, how many files go to the agent, and what it did last. */
  progress?: { startedAt: string; agentFiles: number; activity: string[] };
  error?: string;
}

export interface PrDiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  patch?: string;
  truncated: boolean;
}

export interface PrDiffMessage {
  type: 'pr_diff';
  requestId: string;
  pr: PrKey;
  baseSha: string;
  headSha: string;
  files: PrDiffFile[];
}

export interface StoredTurn {
  question: string;
  answer: string;
  agent: AgentId;
  model: string;
  sessionId: string | null;
  headSha: string;
  selections: CodeSelection[];
  askedAt: string;
}

export interface ThreadsMessage {
  type: 'threads';
  requestId: string;
  pr: PrKey;
  turns: StoredTurn[];
}

/** Pushed on an `agents` subscription when readiness changes. */
export interface AgentsMessage {
  type: 'agents';
  requestId: string;
  agents: AgentStatus[];
  pending: AgentId[];
}

export interface SetupCheck {
  id: 'server' | 'gh' | 'git' | 'agent' | 'clone';
  ok: boolean;
  /** The passing state, e.g. "git is available". */
  title: string;
  /** One plain line: what was found, or what is wrong. */
  detail: string;
  fixSteps: FixStep[];
}

export interface SetupChecksMessage {
  type: 'setup_checks';
  requestId: string;
  checks: SetupCheck[];
}

/** Effective settings, after defaults. Paths are absolute. */
export interface ServerSettings {
  scanRoots: string[];
  repoPaths: Record<string, string>;
  worktreeRoot: string;
  retentionDays: number;
  maxWorktrees: number;
  chatAgent: AgentId | null;
  chatModel: string;
  labelsAgent: AgentId | null;
  labelsModel: string;
  extraPath: string[];
  pollActiveSeconds: number;
  pollIdleSeconds: number;
}

export interface SettingsMessage {
  type: 'settings';
  requestId: string;
  settings: ServerSettings;
  server: { version: string; pid: number; startedAt: string; socketPath: string; logPath: string };
  github: { viewer: string | null; rateLimit: { limit: number; remaining: number; resetAt: string } | null };
  worktrees: { root: string; count: number; bytes: number };
  /** Repos from the inbox and reviews, and the clone found for each (null: not found). */
  clones: { repo: string; path: string | null }[];
  /** After `prune_worktrees`: the worktrees removed. */
  removed?: string[];
  /** After a `save_settings` that was refused. */
  error?: string;
}

export interface DiagnosticsMessage {
  type: 'diagnostics';
  requestId: string;
  text: string;
}

/** Acknowledges requests that have no other reply (unsubscribe, shutdown). */
export interface AckMessage {
  type: 'ack';
  requestId: string;
}

export type ServerMessage =
  | CompanionMessage
  | HelloResponse
  | InboxMessage
  | ReviewMessage
  | RiskLabelsMessage
  | PrDiffMessage
  | ThreadsMessage
  | AgentsMessage
  | SetupChecksMessage
  | SettingsMessage
  | DiagnosticsMessage
  | AckMessage;

export const PROGRESS_LABELS: Record<ProgressStep, string> = {
  finding_repo: 'Finding local clone',
  fetching_pr: 'Fetching PR',
  preparing_worktree: 'Preparing worktree',
  fetching_ci: 'Fetching CI logs',
  starting_agent: 'Starting agent',
  thinking: 'Thinking',
  labeling: 'Labeling risk',
};
