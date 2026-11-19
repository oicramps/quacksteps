import fs from 'node:fs';
import net from 'node:net';
import { QUACK_VERSION, SOCKET_PROTOCOL_VERSION } from '@quack/shared';
import type { HelloResponse } from '@quack/shared';
import { adapters } from './adapters/index.ts';
import { loadConfig } from './config.ts';
import { STATE_DB } from './db.ts';
import { findBinary, run } from './exec.ts';
import { GH_ENV } from './gh.ts';
import { MessageDecoder, encodeMessage } from './framing.ts';
import { LOCK_PATH, SERVER_LOG_FILE, SOCKET_PATH } from './paths.ts';

export type ServerProbe =
  | { running: true; version: string; protocol: number; viewer: string | null; capabilities: HelloResponse['capabilities'] }
  | { running: false; reason: string };

/** Says hello on the socket the way the app does, and reports what answered. */
export function probeServer(socketPath = SOCKET_PATH, timeoutMs = 3_000): Promise<ServerProbe> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve({ running: false, reason: 'no socket (the server is not running)' });
    const socket = net.createConnection(socketPath);
    const decoder = new MessageDecoder();
    const done = (result: ServerProbe) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ running: false, reason: `no answer within ${timeoutMs / 1000} s` }), timeoutMs);
    socket.on('error', (err) => done({ running: false, reason: err.message }));
    socket.on('connect', () =>
      socket.write(encodeMessage({ type: 'hello', requestId: 'doctor', client: 'cli', clientVersion: QUACK_VERSION, protocol: SOCKET_PROTOCOL_VERSION })),
    );
    socket.on('data', (chunk) => {
      for (const m of decoder.push(chunk) as { type: string }[]) {
        if (m.type === 'hello') {
          const h = m as HelloResponse;
          done({ running: true, version: h.version, protocol: h.protocol, viewer: h.viewer, capabilities: h.capabilities });
        } else if (m.type === 'event') {
          done({ running: false, reason: 'the server refused the hello (protocol mismatch?)' });
        }
      }
    });
  });
}

export interface GhAuth {
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  /** The github.com account, never the token. */
  account: string | null;
}

/** Parses `gh auth status` for github.com. Only the account name is kept; token lines are ignored. */
export function parseGhAuthStatus(output: string, code: number): Pick<GhAuth, 'loggedIn' | 'account'> {
  const account = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(output)?.[1] ?? null;
  return { loggedIn: code === 0 && account !== null, account };
}

export async function ghAuth(): Promise<GhAuth> {
  const gh = findBinary(['gh']);
  if (!gh) return { path: null, version: null, loggedIn: false, account: null };
  const [version, status] = await Promise.all([
    run(gh, ['--version'], { timeoutMs: 10_000, env: GH_ENV }),
    run(gh, ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000, env: GH_ENV }),
  ]);
  return { path: gh, version: version.stdout.split('\n')[0].trim() || null, ...parseGhAuthStatus(`${status.stdout}\n${status.stderr}`, status.code) };
}

/** Everything `quack-companion doctor` prints, as one JSON-able object. */
export async function doctorReport() {
  const [server, gh, git, agents] = await Promise.all([
    probeServer(),
    ghAuth(),
    (async () => {
      const bin = findBinary(['git']);
      const v = bin ? await run(bin, ['--version'], { timeoutMs: 10_000 }) : null;
      return { path: bin, version: v?.stdout.trim() || null };
    })(),
    Promise.all(Object.values(adapters).map((a) => a.isAvailable())),
  ]);
  return {
    version: QUACK_VERSION,
    server,
    paths: { socket: SOCKET_PATH, lock: LOCK_PATH, stateDb: STATE_DB, serverLog: SERVER_LOG_FILE },
    gh,
    git,
    binaries: Object.fromEntries(['cursor-agent', 'agent', 'claude'].map((b) => [b, findBinary([b])])),
    config: loadConfig(),
    agents,
  };
}
