import type { ErrorCode, FixStep } from '@quack/shared';
import { type RunResult, findBinary, run } from './exec.ts';

/**
 * Read-only GitHub access for the server. The only GraphQL documents it can send are the
 * constants in `QUERIES`, compiled into the binary; there is no way to pass a document in,
 * so the server can never send a mutation.
 */

export const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' };

/**
 * Fields shared by both inbox searches. `mergeable` and `mergeStateStatus` are deliberately absent:
 * GitHub computes them on request, and with them a 30-PR search took 8-10 s and the combined
 * search hit GitHub's 10 s limit (HTTP 502). They are fetched separately, for my PRs only.
 */
const PR_FIELDS = `
  id number title url isDraft createdAt updatedAt additions deletions
  author { login }
  repository { nameWithOwner owner { __typename } defaultBranchRef { name } }
  headRefOid headRefName baseRefName
  reviewDecision
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
`;

/** Merge state for my non-draft PRs, by node id, in small chunks. */
export const MERGE_CHUNK = 10;

export const QUERIES = {
  /** Review requests for me or my teams. */
  inboxReview: `query QuackInboxReview($q: String!) {
  viewer { login }
  rateLimit { limit remaining resetAt }
  search(query: $q, type: ISSUE, first: 100) {
    issueCount
    nodes { ... on PullRequest {
      ${PR_FIELDS}
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
      latestReviews(first: 20) { nodes { state author { login } } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT], last: 20) {
        nodes {
          __typename
          ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
          ... on ReadyForReviewEvent { createdAt }
        }
      }
    } }
  }
}`,
  /** My own open PRs. */
  inboxMine: `query QuackInboxMine($q: String!) {
  rateLimit { limit remaining resetAt }
  search(query: $q, type: ISSUE, first: 100) {
    issueCount
    nodes { ... on PullRequest {
      ${PR_FIELDS}
      reviewThreads(last: 100) { totalCount nodes { isResolved } }
      latestReviews(first: 20) { nodes { state submittedAt author { login } } }
    } }
  }
}`,
  /** `ids` is a JSON array of up to MERGE_CHUNK PR node ids. */
  mergeState: `query QuackMergeState($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest { id mergeable mergeStateStatus } }
}`,
  /** A PR I'm reviewing that the searches no longer return (I reviewed it, or it closed). */
  reviewedPr: `query QuackReviewedPr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    ${PR_FIELDS}
    state closedAt mergedBy { login }
    timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT], last: 20) {
      nodes {
        __typename
        ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
        ... on ReadyForReviewEvent { createdAt }
      }
    }
  } }
}`,
  /** The open PR whose head branch is \`head\`: the PR a stacked PR sits on top of. */
  stackParent: `query QuackStackParent($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: OPEN, first: 1) { nodes { number title headRefName baseRefName } }
  }
}`,
  /** One cheap query against an org, so onboarding can detect SSO that hides org PRs. */
  orgAccess: `query QuackOrgAccess($login: String!) {
  organization(login: $login) { login repositories(first: 1) { totalCount } }
}`,
} as const;

export type QueryName = keyof typeof QUERIES;

/** A gh failure the app can explain, with the same fix-step shape as agent errors. */
export class GhError extends Error {
  readonly code: ErrorCode;
  readonly fixSteps: FixStep[];
  /** For rate limits: when GitHub says to try again. */
  readonly retryAt?: Date;
  /** True for a secondary (abuse) rate limit, which has no reset time and needs backoff. */
  readonly secondary: boolean;
  /** True for a GitHub-side hiccup (502/504) that needs no action from the user. */
  readonly transient: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    fixSteps: FixStep[] = [],
    extra: { retryAt?: Date; secondary?: boolean; transient?: boolean } = {},
  ) {
    super(message);
    this.code = code;
    this.fixSteps = fixSteps;
    this.retryAt = extra.retryAt;
    this.secondary = extra.secondary ?? false;
    this.transient = extra.transient ?? false;
  }
}

export const FIX_INSTALL_GH: FixStep[] = [
  { text: 'Install the GitHub CLI', command: 'brew install gh' },
  { text: 'Log in to github.com', command: 'gh auth login --hostname github.com --web' },
  { text: 'Then press Re-check.' },
];

export const FIX_LOGIN_GH: FixStep[] = [
  { text: 'Log in to github.com with the GitHub CLI', command: 'gh auth login --hostname github.com --web' },
  { text: 'Then press Re-check.' },
];

/** Authorising the CLI for an org that enforces SAML SSO. Wording to confirm against the polarsteps org. */
export const fixSso = (org: string): FixStep[] => [
  { text: `Refresh your GitHub CLI login so it asks to authorise ${org}`, command: 'gh auth refresh --hostname github.com' },
  { text: `In the browser, press Authorize next to ${org} under "Organization access", then finish the login.` },
  { text: 'Then press Re-check.' },
];

/** GraphQL `errors[]` entries GitHub returned alongside (possibly partial) data. */
export interface GraphQLErrorEntry {
  type?: string;
  message: string;
  path?: (string | number)[];
}

export interface GraphQLResult<T> {
  data: T;
  errors: GraphQLErrorEntry[];
}

export type GhRunner = (args: string[]) => Promise<RunResult>;

const defaultRunner: GhRunner = async (args) => {
  const gh = findBinary(['gh']);
  if (!gh) throw new GhError('gh_unavailable', "The GitHub CLI (gh) isn't installed.", FIX_INSTALL_GH);
  return run(gh, args, { timeoutMs: 45_000, env: GH_ENV });
};

/** Maps gh's stderr for a failed call onto an explainable error. */
export function classifyGhFailure(res: RunResult, now = new Date()): GhError {
  const text = `${res.stderr}\n${res.stdout}`;
  if (/not logged in|gh auth login|authentication required|HTTP 401|Bad credentials/i.test(text)) {
    return new GhError('gh_not_logged_in', "The GitHub CLI isn't logged in to github.com.", FIX_LOGIN_GH);
  }
  if (/secondary rate limit|abuse detection|HTTP 429/i.test(text)) {
    return new GhError('rate_limited', 'GitHub asked us to slow down.', [], { secondary: true });
  }
  if (/API rate limit exceeded|rate limit/i.test(text)) {
    const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(text);
    return new GhError('rate_limited', 'GitHub asked us to slow down.', [], {
      retryAt: reset ? new Date(Number(reset[1]) * 1000) : new Date(now.getTime() + 15 * 60_000),
    });
  }
  if (/HTTP 50[234]/i.test(text)) {
    // GitHub's GraphQL gateway times out heavy queries at ~10 s. Transient: the next poll retries.
    return new GhError('gh_unavailable', 'GitHub took too long to answer. Retrying on the next check.', [], { transient: true });
  }
  const first = text.trim().split('\n').find(Boolean) ?? `gh exited with ${res.code}`;
  return new GhError('gh_unavailable', `GitHub CLI call failed: ${first.slice(0, 300)}`, FIX_LOGIN_GH);
}

/**
 * Runs one of the compiled-in GraphQL documents with string variables.
 * GraphQL errors with data (e.g. SAML-hidden orgs) are returned, not thrown.
 */
export async function graphql<T>(
  name: QueryName,
  variables: Record<string, string | number | string[]>,
  runner: GhRunner = defaultRunner,
): Promise<GraphQLResult<T>> {
  const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${QUERIES[name]}`];
  for (const [key, value] of Object.entries(variables)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error(`bad variable name ${key}`);
    if (Array.isArray(value)) {
      // gh sends `key[]=v` entries as a JSON array.
      for (const v of value) args.push('-f', `${key}[]=${v}`);
    } else if (typeof value === 'number') {
      // -F sends a number for Int variables. Only integers, so nothing else gh's -F would interpret (@file, true) gets through.
      if (!Number.isSafeInteger(value)) throw new Error(`bad number for ${key}`);
      args.push('-F', `${key}=${value}`);
    } else {
      // -f always sends a string; the document is never taken from a variable.
      args.push('-f', `${key}=${value}`);
    }
  }
  const res = await runner(args);
  let body: { data?: T; errors?: GraphQLErrorEntry[] } | null = null;
  try {
    body = JSON.parse(res.stdout);
  } catch {
    // Not JSON: fall through to the failure classification.
  }
  if (body?.data) return { data: body.data, errors: body.errors ?? [] };
  if (body?.errors?.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    if (/rate limit/i.test(msg)) throw classifyGhFailure({ ...res, stderr: `${res.stderr}\n${msg}` });
    throw new GhError('gh_unavailable', `GitHub returned an error: ${msg.slice(0, 300)}`);
  }
  throw classifyGhFailure(res);
}

/** True when GitHub hid some data because the CLI isn't authorised for an org's SAML SSO. */
export function samlErrors(errors: GraphQLErrorEntry[]): GraphQLErrorEntry[] {
  return errors.filter((e) => /SAML|single sign-on|\bSSO\b/i.test(`${e.type ?? ''} ${e.message}`));
}

/**
 * The only REST endpoints the server reads, as fixed path templates (GET only; the method is pinned).
 * Owner and repo come from validated PR keys and are URL-encoded anyway.
 */
export const REST = {
  /** A PR's head and base. */
  pull: (owner: string, repo: string, n: number) => `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${n}`,
  /** A PR's changed files with patches, 100 per page (GitHub stops at 3,000 files). */
  pullFiles: (owner: string, repo: string, n: number) => `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${n}/files?per_page=100`,
  /** How far one commit is ahead of another ("3 new commits"). Both are full SHAs. */
  compare: (owner: string, repo: string, base: string, head: string) =>
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${base}...${head}`,
} as const;

/** GET on one of the `REST` paths. With `paginate`, gh follows every page and `jq` runs on each. */
export async function restGet(path: string, opts: { paginate?: boolean; jq?: string } = {}, runner: GhRunner = defaultRunner): Promise<string> {
  const allowed =
    /^repos\/[^/?]+\/[^/?]+\/pulls\/\d+(\/files\?per_page=100)?$/.test(path) || /^repos\/[^/?]+\/[^/?]+\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(path);
  if (!allowed) throw new Error(`refusing REST path ${path}`);
  const args = ['api', '--hostname', 'github.com', '-X', 'GET', path];
  if (opts.paginate) args.push('--paginate');
  if (opts.jq) args.push('--jq', opts.jq);
  const res = await runner(args);
  if (res.code !== 0) throw classifyGhFailure(res);
  return res.stdout;
}
