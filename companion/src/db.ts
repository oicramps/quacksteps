import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QUACK_DIR } from './paths.ts';

/**
 * The server's state, in one SQLite file: ~/.quack/state.db.
 * `node:sqlite` works under both Node and Bun, so there is no runtime-specific code here.
 * Migrations run at open; each one runs once, in order, recorded in `schema_version`.
 */

export const STATE_DB = path.join(QUACK_DIR, 'state.db');

const MIGRATIONS: string[] = [
  // 1: inbox
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- The last inbox snapshot, so the app shows something instantly on launch. Replaced each poll.
  CREATE TABLE inbox_items (
    role TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    item TEXT NOT NULL,
    PRIMARY KEY (role, owner, repo, number)
  );

  -- My PRs' author state and when it started, since GitHub doesn't say. Kept 30 days after last seen.
  CREATE TABLE state_history (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    state TEXT,
    since TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (owner, repo, number)
  );

  -- Merge state is fetched separately and can fail or come back UNKNOWN; the last known value is kept.
  CREATE TABLE merge_state (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    mergeable TEXT NOT NULL,
    merge_state_status TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    PRIMARY KEY (owner, repo, number)
  );

  -- Dedupe keys for inbox events, so a restart never repeats a notification. Kept 30 days.
  CREATE TABLE notifications_sent (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
  `,
  // 2: reviews ("Start reviewing"; the tech spec's claims)
  `
  CREATE TABLE reviews (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    state TEXT NOT NULL,
    agent TEXT,
    model TEXT,
    PRIMARY KEY (owner, repo, number)
  );
  `,
  // 3: risk labels, cached by everything that changes the result. Kept 30 days after generated_at.
  `
  CREATE TABLE risk_labels (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version INTEGER NOT NULL,
    generated_at TEXT NOT NULL,
    files TEXT NOT NULL,
    PRIMARY KEY (owner, repo, number, head_sha, agent, model, prompt_version)
  );
  CREATE INDEX risk_labels_by_pr ON risk_labels (owner, repo, number, generated_at);
  `,
  // 4: chat turns per PR, so a thread survives app and server restarts.
  `
  CREATE TABLE threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    asked_at TEXT NOT NULL,
    turn TEXT NOT NULL
  );
  CREATE INDEX threads_by_pr ON threads (owner, repo, number, id);
  `,
];

export type Db = DatabaseSync;

/** Opens (creating if needed) the state database and brings its schema up to date. `:memory:` for tests. */
export function openDb(file = STATE_DB): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    fs.chmodSync(file, 0o600);
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  return row?.version ?? 0;
}

function migrate(db: Db): void {
  let version = schemaVersion(db);
  if (version > MIGRATIONS.length) {
    throw new Error(`state.db is at schema ${version}, newer than this server (${MIGRATIONS.length}). Update Quacksteps.`);
  }
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version++;
      db.exec('DELETE FROM schema_version');
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Runs `fn` in a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getKv(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
