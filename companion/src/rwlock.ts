/**
 * A reader-writer lock per worktree directory.
 *
 * Readers are agent turns (chat and label jobs) at the worktree's current commit. Several can run at
 * once because every agent is read-only. Writers change the tree: checkout, Update, cleanup, prune.
 * A writer waits for the readers to finish, and new readers queue behind a waiting writer, so a long
 * label run can't starve an Update and a stream of chat turns can't starve a writer either.
 *
 * Grants are strictly FIFO across the queue, except that consecutive readers at the head are let in together.
 */

export type Release = () => void;

interface Waiter {
  kind: 'read' | 'write';
  grant: () => void;
}

class DirLock {
  readers = 0;
  writer = false;
  readonly queue: Waiter[] = [];
  /** Set when a reader left changes behind; the next writer must discard them first. */
  dirty = false;

  get idle(): boolean {
    return this.readers === 0 && !this.writer && this.queue.length === 0;
  }

  pump(): void {
    while (this.queue.length) {
      const head = this.queue[0];
      if (head.kind === 'write') {
        if (this.readers > 0 || this.writer) return;
        this.queue.shift();
        this.writer = true;
        head.grant();
        return;
      }
      if (this.writer) return;
      this.queue.shift();
      this.readers++;
      head.grant();
    }
  }
}

const locks = new Map<string, DirLock>();

function lockFor(dir: string): DirLock {
  let l = locks.get(dir);
  if (!l) {
    l = new DirLock();
    locks.set(dir, l);
  }
  return l;
}

function acquire(dir: string, kind: 'read' | 'write', signal?: AbortSignal): Promise<Release> {
  const lock = lockFor(dir);
  return new Promise<Release>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    let released = false;
    const release: Release = () => {
      if (released) return;
      released = true;
      if (kind === 'write') lock.writer = false;
      else lock.readers--;
      lock.pump();
      if (lock.idle && !lock.dirty) locks.delete(dir);
    };
    const waiter: Waiter = {
      kind,
      grant: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(release);
      },
    };
    const onAbort = () => {
      const i = lock.queue.indexOf(waiter);
      if (i < 0) return; // already granted
      lock.queue.splice(i, 1);
      lock.pump(); // a removed writer may have been holding readers back
      if (lock.idle && !lock.dirty) locks.delete(dir);
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    lock.queue.push(waiter);
    lock.pump();
  });
}

/** Shared access: the tree must not change while held. */
export function acquireRead(dir: string, signal?: AbortSignal): Promise<Release> {
  return acquire(dir, 'read', signal);
}

/** Exclusive access, to change the tree. Waits for current readers; blocks new ones. */
export function acquireWrite(dir: string, signal?: AbortSignal): Promise<Release> {
  return acquire(dir, 'write', signal);
}

/** Records that a reader left changes in `dir`; the next writer (or the cleanup it schedules) discards them. */
export function markDirty(dir: string): void {
  lockFor(dir).dirty = true;
}

/** True once, then cleared: whether a writer holding the lock must discard reader changes first. */
export function takeDirty(dir: string): boolean {
  const l = locks.get(dir);
  if (!l?.dirty) return false;
  l.dirty = false;
  return true;
}

/** For tests and diagnostics. */
export function lockState(dir: string): { readers: number; writer: boolean; waiting: string[]; dirty: boolean } {
  const l = locks.get(dir);
  return { readers: l?.readers ?? 0, writer: l?.writer ?? false, waiting: l?.queue.map((w) => w.kind) ?? [], dirty: l?.dirty ?? false };
}
