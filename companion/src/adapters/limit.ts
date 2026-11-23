import type { Adapter, AdapterEvent, AskOpts } from './types.ts';

/** At most this many agent turns run at once across the server (chat and labels), whatever the agent. */
export const MAX_AGENT_TURNS = 4;

/** A counting semaphore whose waiters are served in order and can be cancelled. */
export class Slots {
  private free: number;
  private readonly waiting: { grant: () => void; reject: (err: Error) => void }[] = [];

  constructor(size: number) {
    this.free = size;
  }

  get available(): number {
    return this.free;
  }

  /** Resolves to a release function once a slot is free. Rejects when `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.grant();
      else this.free++;
    };
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
        reject,
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(waiter);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new Error('cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }
}

/**
 * Wraps every adapter so their turns share `slots`. A turn that has to wait says so as a tool event,
 * so the chat shows why nothing is happening yet.
 */
export function limitAgents<K extends string>(adapters: Record<K, Adapter>, slots = new Slots(MAX_AGENT_TURNS)): Record<K, Adapter> {
  const wrap = (adapter: Adapter): Adapter => ({
    ...adapter,
    async *ask(opts: AskOpts): AsyncIterable<AdapterEvent> {
      let release: (() => void) | null = null;
      if (slots.available === 0) yield { type: 'tool', summary: 'Waiting: other agent turns are running' };
      try {
        release = await slots.acquire(opts.signal);
      } catch {
        return; // cancelled while waiting; the caller reports the cancel
      }
      try {
        yield* adapter.ask(opts);
      } finally {
        release();
      }
    },
  });
  return Object.fromEntries(Object.entries<Adapter>(adapters).map(([k, a]) => [k, wrap(a)])) as Record<K, Adapter>;
}
