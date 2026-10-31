import type { PollOption } from "@livevote/shared";

export interface VoteRecord {
  optionIds: string[];
  people: number;
  updatedAt: number;
}

export interface PollRecord {
  id: string;
  /** SHA-256 hex of the host token. The raw token is never stored. */
  hostTokenHash: string;
  question: string;
  options: PollOption[];
  nextOptionSeq: number;
  multiple: boolean;
  allowAddOwn: boolean;
  closesAt: number | null;
  /** Set when the host closes the poll manually. */
  closedAt: number | null;
  createdAt: number;
  expiresAt: number;
  /** voterId -> vote. */
  votes: Record<string, VoteRecord>;
  /** voterIds that already used their one "Add your own". */
  adders: string[];
}

/**
 * Persistence boundary. Two implementations exist: `MemoryPollStore` (volatile, the default)
 * and `PgPollStore` (Postgres, selected by DATABASE_URL). All methods are async on purpose, and
 * `update` is the single atomic read-modify-write primitive (a row-locked transaction in Postgres),
 * so concurrent votes / option adds on one poll never lose updates.
 */
export interface PollStore {
  /** Human-readable kind for logs ("memory", "postgres"). Never contains connection details. */
  readonly kind: string;
  /** How often the server should call `deleteExpired`. Persistent stores sweep rarely to let a scale-to-zero DB sleep. */
  readonly sweepIntervalMs: number;
  /** Prepare the backend (create schema, check connectivity). Safe to call more than once. */
  init(): Promise<void>;
  /** Release connections. */
  close(): Promise<void>;
  create(poll: PollRecord): Promise<void>;
  get(id: string): Promise<PollRecord | null>;
  /**
   * Atomically apply `mutate` to the poll. If `mutate` throws, nothing is saved.
   * Resolves `null` when the poll does not exist.
   */
  update<T>(id: string, mutate: (draft: PollRecord) => T): Promise<{ result: T; poll: PollRecord } | null>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
  /** Remove polls whose `expiresAt` is <= now; returns the removed ids. */
  deleteExpired(now: number): Promise<string[]>;
}
