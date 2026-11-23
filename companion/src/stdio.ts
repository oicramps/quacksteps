import type { ServerMessage } from '@quacksteps/shared';
import { ALLOWED_EXTENSION_IDS, DEV_EXTENSION_ID, QUACK_VERSION } from '@quacksteps/shared';
import { findClone } from './repo.ts';
import { loadConfig } from './config.ts';
import { MessageDecoder } from './framing.ts';
import { log } from './log.ts';
import { MenuActivity, startMenuBar, type MenuStatus } from './menubar.ts';
import { type Connection, createRouter, encodeFrames } from './router.ts';
import { ValidationError, validateMessage } from './validate.ts';
import { enforceRetention } from './worktree.ts';

/**
 * Checks whether the caller's `chrome-extension://<id>/` origin is allowlisted.
 * The unpacked dev id is accepted only when this process was launched with
 * `QUACK_ALLOW_DEV=1` (the `--dev` install). Store installs leave it unset.
 */
export function isAllowedOrigin(origin: string | undefined, allowDev = process.env.QUACK_ALLOW_DEV === '1'): boolean {
  const ids = allowDev ? ALLOWED_EXTENSION_IDS : ALLOWED_EXTENSION_IDS.filter((id) => id !== DEV_EXTENSION_ID);
  return ids.some((id) => origin === `chrome-extension://${id}/`);
}

/** Runs the Chrome Native Messaging stdio event loop for an allowlisted extension origin. */
export function startHost(origin: string | undefined): void {
  if (!isAllowedOrigin(origin)) {
    log('rejected caller origin', String(origin));
    process.exit(1);
  }
  log('host started', QUACK_VERSION);
  const bar = startMenuBar();
  const activity = new MenuActivity();
  const showMenu = (status: MenuStatus | null) => {
    if (status) bar.update(status);
  };
  // Chrome can exit the host without a clean stdin end. The helper also watches our pid.
  process.on('exit', () => bar.stop());
  const config = loadConfig();
  void enforceRetention(config, (owner, repo) => findClone(config, owner, repo)).catch((err: unknown) => {
    log('retention failed', err instanceof Error ? err.message : String(err));
  });

  const conn: Connection = {
    id: 'stdio',
    transport: 'stdio',
    send(message: ServerMessage) {
      if (message.type === 'progress') showMenu(activity.progress(message.requestId, message.step));
      else if (message.type === 'event' && (message.event.type === 'done' || message.event.type === 'error')) {
        showMenu(activity.end(message.requestId));
      }
      for (const frame of encodeFrames(message)) process.stdout.write(frame);
    },
  };
  const router = createRouter();

  const decoder = new MessageDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (err) {
      log('framing error, exiting:', String(err));
      process.exit(1);
    }
    for (const raw of messages) {
      try {
        // The extension may only send v1 messages; socket-only ones are rejected here.
        const message = validateMessage(raw);
        if (message.type === 'ask') showMenu(activity.begin(message.requestId, `${message.pr.owner}/${message.pr.repo}#${message.pr.number}`));
        if (message.type === 'cancel') showMenu(activity.end(message.requestId));
        router.handle(message, conn);
      } catch (err) {
        const requestId = (raw as { requestId?: unknown })?.requestId;
        log('rejected message:', err instanceof ValidationError ? err.message : String(err));
        if (typeof requestId === 'string' && requestId.length <= 100) {
          conn.send({ type: 'event', requestId, event: { type: 'error', code: 'bad_request', message: (err as Error).message } });
        }
      }
    }
  });

  // When the browser closes the native port, abort in-flight requests and terminate agent processes.
  process.stdin.on('end', () => {
    log('port closed, stopping', router.runningCount(), 'request(s)');
    router.stopAll();
    bar.stop();
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
