import type { PrKey, StoredTurn } from '@quack/shared';
import type { Db } from './db.ts';

/** Turns kept per PR; the oldest go first. */
export const MAX_TURNS_PER_PR = 200;
const RETENTION_MS = 30 * 24 * 3600_000;

/**
 * Chat turns per PR in state.db. The server records a turn when an ask from the app finishes, so a
 * thread survives app and server restarts; the app loads it with `threads`.
 */
export class ThreadStore {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  add(pr: PrKey, turn: StoredTurn): void {
    const [owner, repo] = [pr.owner.toLowerCase(), pr.repo.toLowerCase()];
    this.db.prepare('INSERT INTO threads (owner, repo, number, asked_at, turn) VALUES (?, ?, ?, ?, ?)').run(owner, repo, pr.number, turn.askedAt, JSON.stringify(turn));
    this.db
      .prepare(
        `DELETE FROM threads WHERE owner = ? AND repo = ? AND number = ? AND id NOT IN
           (SELECT id FROM threads WHERE owner = ? AND repo = ? AND number = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(owner, repo, pr.number, owner, repo, pr.number, MAX_TURNS_PER_PR);
  }

  /** The PR's turns, oldest first. */
  list(pr: PrKey): StoredTurn[] {
    return (
      this.db.prepare('SELECT turn FROM threads WHERE owner = ? AND repo = ? AND number = ? ORDER BY id').all(pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number) as {
        turn: string;
      }[]
    ).map((r) => JSON.parse(r.turn) as StoredTurn);
  }

  /**
   * Drops whole threads with no turn in 30 days. (The spec keeps threads until 30 days after the PR
   * closes; the server doesn't track closing yet, and a PR quiet for 30 days is almost always closed.)
   */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - RETENTION_MS).toISOString();
    return Number(
      this.db
        .prepare(
          `DELETE FROM threads WHERE (owner, repo, number) IN
             (SELECT owner, repo, number FROM threads GROUP BY owner, repo, number HAVING MAX(asked_at) < ?)`,
        )
        .run(cutoff).changes,
    );
  }
}
