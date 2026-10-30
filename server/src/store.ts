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
 * Persistence boundary. The in-memory implementation is the only one today;
 * a Redis/SQLite/Postgres store can be dropped in by implementing this interface.
 * All methods are async on purpose, and `update` is the single atomic
 * read-modify-write primitive (so a real DB can use a transaction / CAS).
 */
export interface PollStore {
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
