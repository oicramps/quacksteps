import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ServerMessage } from '@quacksteps/shared';
import { MessageDecoder } from './framing.ts';
import { log } from './log.ts';
import { type Connection, type Router, encodeFrames } from './router.ts';
import { ValidationError, validateAppMessage } from './validate.ts';

/** Incoming frames on the socket are capped lower than on stdio: the app never sends large payloads. */
export /** Unsent bytes a client may leave queued before the server gives up on it. */
const MAX_UNREAD_BYTES = 64 * 1024 * 1024;
const SOCKET_MAX_INCOMING = 16 * 1024 * 1024;

export interface SocketServerOptions {
  socketPath: string;
  router: Router;
}

export interface SocketServer {
  close(): Promise<void>;
  connectionCount(): number;
}

/** Creates `dir` with mode 0700, and tightens it if it already exists with looser permissions. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/**
 * Listens on a Unix socket in a 0700 directory, with the socket itself 0600. There is no TCP listener.
 * The first message on every connection must be `hello`; anything else gets `bad_request` and a close.
 * The caller must hold the single-instance lock, so a leftover socket file is stale and safe to remove.
 */
export async function startSocketServer({ socketPath, router }: SocketServerOptions): Promise<SocketServer> {
  ensurePrivateDir(path.dirname(socketPath));
  fs.rmSync(socketPath, { force: true });

  let nextId = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    const id = `sock-${++nextId}`;
    sockets.add(socket);
    let greeted = false;
    let closed = false;

    const conn: Connection = {
      id,
      transport: 'socket',
      send(message: ServerMessage) {
        if (closed || socket.destroyed) return;
        for (const frame of encodeFrames(message)) socket.write(frame);
        // A client that stops reading would make the server buffer without limit.
        if (socket.writableLength > MAX_UNREAD_BYTES) {
          log('socket', id, 'client is not reading; closing');
          closed = true;
          socket.destroy();
        }
      },
    };

    const reject = (requestId: unknown, message: string) => {
      log('socket', id, 'rejected message:', message);
      if (typeof requestId === 'string' && requestId.length <= 100) {
        conn.send({ type: 'event', requestId, event: { type: 'error', code: 'bad_request', message } });
      }
    };

    const decoder = new MessageDecoder(SOCKET_MAX_INCOMING);
    socket.on('data', (chunk: Buffer) => {
      if (closed) return;
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        log('socket', id, 'framing error, closing:', String(err));
        socket.destroy();
        return;
      }
      for (const raw of messages) {
        const requestId = (raw as { requestId?: unknown })?.requestId;
        let message;
        try {
          message = validateAppMessage(raw);
        } catch (err) {
          reject(requestId, err instanceof ValidationError ? err.message : String(err));
          if (!greeted) {
            // Nothing else in this chunk (or after it) is handled before a valid hello.
            closed = true;
            socket.destroySoon();
            return;
          }
          continue;
        }
        if (!greeted) {
          if (message.type !== 'hello') {
            reject(requestId, 'the first message must be hello');
            closed = true;
            socket.destroySoon();
            return;
          }
          greeted = true;
          log('socket', id, 'hello from', message.client, message.clientVersion, 'protocol', message.protocol);
        }
        router.handle(message, conn);
      }
    });

    const onGone = () => {
      if (closed) return;
      closed = true;
      sockets.delete(socket);
      const aborted = router.disconnect(conn);
      log('socket', id, 'closed', aborted ? `aborting ${aborted} request(s)` : '');
    };
    socket.on('close', onGone);
    socket.on('error', (err) => {
      log('socket', id, 'error', err.message);
      onGone();
    });
  });

  // Create the socket file 0600 from the start, then make sure of it.
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(umask);
  }
  fs.chmodSync(socketPath, 0o600);
  log('socket listening on', socketPath);

  return {
    connectionCount: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          fs.rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
