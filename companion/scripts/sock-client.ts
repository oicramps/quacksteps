// A tiny client for the quackd socket, for poking the server before the Mac app exists.
//
//   bun scripts/sock-client.ts status
//   bun scripts/sock-client.ts agents
//   bun scripts/sock-client.ts inbox [--full] [--watch]
//   bun scripts/sock-client.ts refresh [--full]
//   bun scripts/sock-client.ts ask polarsteps/igloo#123 "What does this PR change?" [cursor|claude-code] [model]
//   bun scripts/sock-client.ts start polarsteps/igloo#123 [agent]    (Start reviewing; waits until it settles)
//   bun scripts/sock-client.ts update|watch polarsteps/igloo#123
//   bun scripts/sock-client.ts stop polarsteps/igloo#123 [--remove]
//   bun scripts/sock-client.ts labels polarsteps/igloo#123 [--rerun]   (waits until labels are ready or failed)
//   bun scripts/sock-client.ts diff polarsteps/igloo#123 [sha]   (file list; --patch prints patches)
//   bun scripts/sock-client.ts threads polarsteps/igloo#123        (the stored chat for a PR)
//   bun scripts/sock-client.ts shutdown
//
// --socket=<path> overrides ~/.quack/run/quack.sock. Prints every message as one JSON line;
// text deltas are printed inline so an answer reads naturally.
import net from 'node:net';
import type { InboxMessage, PrDiffMessage, RiskLabelsMessage } from '@quacksteps/shared';
import { QUACK_VERSION, SOCKET_PROTOCOL_VERSION } from '@quacksteps/shared';
import { MessageDecoder, encodeMessage } from '../src/framing.ts';
import { SOCKET_PATH } from '../src/paths.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--socket='));
const socketPath = process.argv.find((a) => a.startsWith('--socket='))?.slice(9) ?? SOCKET_PATH;
const [verb = 'status', ...rest] = args;

function parsePr(target: string | undefined) {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(target ?? '');
  if (!m) {
    console.error('expected owner/repo#number');
    process.exit(2);
  }
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

const socket = net.createConnection(socketPath);
const decoder = new MessageDecoder();
const send = (m: unknown) => socket.write(encodeMessage(m));
const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;

socket.on('error', (err) => {
  console.error(`Can't reach the server at ${socketPath}: ${err.message}`);
  process.exit(1);
});

socket.on('connect', () => {
  send({ type: 'hello', requestId: 'hello', client: 'cli', clientVersion: QUACK_VERSION, protocol: SOCKET_PROTOCOL_VERSION });
  switch (verb) {
    case 'status':
      send({ type: 'status', requestId: 'status' });
      break;
    case 'agents':
      send({ type: 'subscribe', requestId: 'agents', topic: 'agents' });
      break;
    case 'inbox':
      // Snapshot first (if stored), then the next poll. --watch keeps listening.
      send({ type: 'subscribe', requestId: 'inbox', topic: 'inbox' });
      break;
    case 'refresh':
      send({ type: 'inbox', requestId: 'inbox', refresh: true });
      break;
    case 'start':
    case 'stop':
    case 'update':
    case 'watch': {
      const pr = parsePr(rest[0]);
      // Watch the PR's review until it settles (ready, stale, failed or stopped).
      send({ type: 'subscribe', requestId: 'watch', topic: { pr } });
      if (verb === 'start') send({ type: 'start_review', requestId: 'review', pr, agent: rest[1] ?? 'cursor' });
      if (verb === 'update') send({ type: 'update_review', requestId: 'review', pr });
      if (verb === 'stop') send({ type: 'stop_review', requestId: 'review', pr, removeWorktree: process.argv.includes('--remove') });
      break;
    }
    case 'labels': {
      const pr = parsePr(rest[0]);
      send({ type: 'subscribe', requestId: 'watch', topic: { pr } });
      send({ type: 'risk_labels', requestId: 'labels', pr, rerun: process.argv.includes('--rerun') });
      break;
    }
    case 'threads':
      send({ type: 'threads', requestId: 'threads', pr: parsePr(rest[0]) });
      break;
    case 'diff':
      send({ type: 'pr_diff', requestId: 'diff', pr: parsePr(rest[0]), ...(rest[1] && { headSha: rest[1] }) });
      break;
    case 'shutdown':
      send({ type: 'shutdown', requestId: 'shutdown' });
      break;
    case 'ask': {
      const [target, question, agent = 'cursor', model = ''] = rest;
      if (!question) {
        console.error('usage: ask owner/repo#number "question" [agent] [model]');
        process.exit(2);
      }
      send({
        type: 'ask',
        requestId: 'ask',
        agent,
        model,
        pr: parsePr(target),
        selections: [],
        question,
        sessionId: null,
      });
      break;
    }
    default:
      console.error(`unknown verb ${verb}`);
      process.exit(2);
  }
});

let inText = false;
let snapshotAt: string | undefined;
const messagesSeen = new Set<string>();

const age = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** A summary by default; --full lists every PR. */
function printInbox(m: InboxMessage) {
  const reviews = m.items.filter((i) => i.role === 'reviewer' && i.reviewer!.requested !== false);
  const reviewedHere = m.items.filter((i) => i.role === 'reviewer' && i.reviewer!.requested === false);
  const mine = m.items.filter((i) => i.role === 'author');
  const tally = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {}));
  console.log(stamp(), `inbox fetched ${m.fetchedAt || 'never'}${m.fetchedAt ? ` (${age(m.fetchedAt)} ago)` : ''}`);
  console.log(`  review requests: ${reviews.length} (${tally(reviews.map((r) => r.reviewer!.via)).map(([k, v]) => `${v} via ${k}`).join(', ')})`);
  if (reviews[0]) console.log(`  longest wait: ${age(reviews[0].reviewer!.requestedAt)}`);
  if (reviewedHere.length) console.log(`  already reviewed, still reviewing here: ${reviewedHere.map((i) => `${i.pr.repo}#${i.pr.number}`).join(', ')}`);
  console.log(`  my PRs: ${mine.length} -> ${tally(mine.map((i) => String(i.author!.state ?? 'draft'))).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (m.more && (m.more.reviewer || m.more.author)) console.log(`  more on GitHub: +${m.more.reviewer} review, +${m.more.author} mine`);
  if (m.events.length) console.log(`  events: ${m.events.map((e) => `${e.kind} ${e.pr.repo}#${e.pr.number}`).join(', ')}`);
  if (m.error) console.log(`  error: ${m.error.code}: ${m.error.message}`);
  if (process.argv.includes('--full')) {
    for (const i of m.items) {
      const what = i.role === 'reviewer' && i.reviewer!.requested === false ? 'reviewed, still reviewing here' : i.role === 'reviewer' ? `waiting ${age(i.reviewer!.requestedAt)} via ${i.reviewer!.via}` : `${i.author!.state ?? 'draft'} for ${age(i.author!.since)} ${i.author!.reasons.join('; ')}`;
      console.log(`  ${i.role.padEnd(8)} ${i.pr.repo}#${i.pr.number} ci:${i.ci} ${what}`);
    }
  }
}
socket.on('data', (chunk) => {
  for (const raw of decoder.push(chunk)) {
    const m = raw as { type: string; requestId: string; event?: { type: string; delta?: string }; pending?: unknown[] };
    if (m.type === 'event' && m.event?.type === 'text') {
      process.stdout.write(m.event.delta ?? '');
      inText = true;
      continue;
    }
    if (inText) {
      process.stdout.write('\n');
      inText = false;
    }
    if (m.type === 'inbox') {
      printInbox(m as unknown as InboxMessage);
      if (!process.argv.includes('--watch') && (m as unknown as InboxMessage).fetchedAt !== snapshotAt) socket.end();
      snapshotAt ??= (m as unknown as InboxMessage).fetchedAt;
      continue;
    }
    if (m.type === 'pr_diff') {
      const d = m as unknown as PrDiffMessage;
      console.log(stamp(), `diff ${d.baseSha.slice(0, 7)}...${d.headSha.slice(0, 7)}, ${d.files.length} files, ${d.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0)} patch chars`);
      for (const f of d.files) {
        console.log(`  ${f.status.padEnd(8)} +${f.additions} -${f.deletions}${f.binary ? ' binary' : ''}${f.truncated ? ' truncated' : ''} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path}`);
        if (process.argv.includes('--patch') && f.patch) console.log(f.patch);
      }
      socket.end();
      continue;
    }
    if (m.type === 'risk_labels') {
      const l = m as unknown as RiskLabelsMessage;
      console.log(stamp(), `labels [${l.requestId}] ${l.status}${l.queued ? ' (queued)' : ''} ${l.headSha.slice(0, 7)} ${l.agent}${l.model ? `/${l.model}` : ''}${l.previousHeadSha ? ` showing ${l.previousHeadSha.slice(0, 7)}` : ''}${l.error ? ` error: ${l.error}` : ''}`);
      if (l.status !== 'running') for (const f of l.files) console.log(`  ${String(f.rank).padStart(3)} ${f.risk.padEnd(9)} ${f.source.padEnd(5)} ${f.path} - ${f.reason}`);
      if (verb === 'labels' && l.status !== 'running') socket.end();
      continue;
    }
    console.log(stamp(), JSON.stringify(m));
    messagesSeen.add(m.requestId);
    const review = (m as { review?: { phase: string } | null }).review;
    const settled = m.type === 'review' && m.requestId === 'watch' && (review === null ? verb === 'stop' : review?.phase !== 'preparing');
    const finished =
      (['start', 'stop', 'update', 'watch'].includes(verb) && settled && (verb === 'watch' || messagesSeen.has('review'))) ||
      (verb === 'status' && m.type === 'status' && (m.pending?.length ?? 0) === 0) ||
      (verb === 'agents' && m.type === 'agents' && (m.pending?.length ?? 0) === 0) ||
      (verb === 'shutdown' && m.type === 'ack') ||
      (verb === 'diff' && m.type === 'event') ||
      (verb === 'threads' && (m.type === 'threads' || m.type === 'event')) ||
      (verb === 'ask' && m.type === 'event' && (m.event?.type === 'done' || m.event?.type === 'error'));
    if (finished) socket.end();
  }
});
