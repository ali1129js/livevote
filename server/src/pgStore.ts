import pg from "pg";
import type { PollOption } from "@livevote/shared";
import type { PollRecord, PollStore, VoteRecord } from "./store";

/** The slice of `pg.Pool` this store needs (so tests can inject pg-mem's pool). */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  on?(event: "error", listener: (err: Error) => void): unknown;
}
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean | Error): void;
}

export interface PgStoreOptions {
  /** Postgres connection string (e.g. Neon). Never logged. */
  connectionString?: string;
  /** Inject an existing pool instead (tests). */
  pool?: PgPoolLike;
  /** Table name; letters, digits and underscore only. */
  table?: string;
  /** Called with a short, secret-free description of background pool errors. */
  log?: (msg: string) => void;
  /** Don't run CREATE TABLE on init (schema is managed elsewhere, or the DB role may not create tables). */
  skipSchemaSetup?: boolean;
  /** Delay before connection retries, ms (tests set 0). */
  retryDelayMs?: number;
}

const POLL_COLUMNS =
  "id, host_token_hash, question, options, next_option_seq, multiple, allow_add_own, closes_at, closed_at, created_at, expires_at, votes, adders";

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fromRow(r: Record<string, unknown>): PollRecord {
  return {
    id: String(r.id),
    hostTokenHash: String(r.host_token_hash),
    question: String(r.question),
    options: r.options as PollOption[],
    nextOptionSeq: num(r.next_option_seq),
    multiple: Boolean(r.multiple),
    allowAddOwn: Boolean(r.allow_add_own),
    closesAt: numOrNull(r.closes_at),
    closedAt: numOrNull(r.closed_at),
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    votes: r.votes as Record<string, VoteRecord>,
    adders: r.adders as string[],
  };
}

/** SQLSTATE classes that mean "wrong credentials / config": retrying cannot help. */
const isPermanentConnectError = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("28") || code === "3D000");
};

/**
 * Postgres-backed store (works with Neon, Supabase, Render Postgres, any Postgres 12+).
 *
 * One row per poll. `update` is a transaction that takes a row lock (`SELECT ... FOR UPDATE`),
 * runs the mutation on a copy, writes it back and commits. Concurrent votes on one poll queue up
 * on the lock instead of overwriting each other, a throwing mutation rolls back, and different
 * polls never block each other. Works through PgBouncer transaction pooling (Neon's `-pooler` host)
 * because everything happens inside a single transaction and no named prepared statements are used.
 */
export class PgPollStore implements PollStore {
  readonly kind = "postgres";
  /** Hourly: expired polls are already ignored on read, so sweeping only reclaims space. Rare sweeps let a scale-to-zero DB sleep. */
  readonly sweepIntervalMs = 60 * 60_000;

  private readonly pool: PgPoolLike;
  private readonly table: string;
  private readonly retryDelayMs: number;
  private readonly skipSchemaSetup: boolean;
  private ready: Promise<void> | null = null;

  constructor(opts: PgStoreOptions) {
    const table = opts.table ?? "livevote_polls";
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error("Invalid table name.");
    this.table = table;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    this.skipSchemaSetup = opts.skipSchemaSetup ?? false;
    if (opts.pool) {
      this.pool = opts.pool;
    } else {
      if (!opts.connectionString) throw new Error("PgPollStore needs a connection string or a pool.");
      this.pool = new pg.Pool({
        connectionString: opts.connectionString,
        max: 5, // a Neon pooled endpoint and the free plan are both happy with a handful
        idleTimeoutMillis: 30_000, // drop idle sockets before a scale-to-zero compute does
        connectionTimeoutMillis: 15_000, // allow for a cold compute resume
        query_timeout: 15_000, // client-side: startup `statement_timeout` is rejected by PgBouncer
        keepAlive: true,
      });
    }
    // Idle clients can be killed by the server (Neon suspends compute); pg removes them, we only must not crash.
    this.pool.on?.("error", (err) => opts.log?.(`postgres pool error: ${(err as { code?: string }).code ?? err.name}`));
  }

  init(): Promise<void> {
    this.ready ??= (this.skipSchemaSetup ? Promise.resolve() : this.createSchema()).catch((e: unknown) => {
      this.ready = null; // allow a later retry
      throw e;
    });
    return this.ready;
  }

  private async createSchema(): Promise<void> {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id text PRIMARY KEY,
        host_token_hash text NOT NULL,
        question text NOT NULL,
        options jsonb NOT NULL,
        next_option_seq integer NOT NULL,
        multiple boolean NOT NULL,
        allow_add_own boolean NOT NULL,
        closes_at bigint,
        closed_at bigint,
        created_at bigint NOT NULL,
        expires_at bigint NOT NULL,
        votes jsonb NOT NULL,
        adders jsonb NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${this.table}_expires_at_idx ON ${this.table} (expires_at)`,
    ];
    for (let attempt = 0; ; attempt++) {
      try {
        for (const sql of ddl) await this.run((c) => c.query(sql));
        return;
      } catch (e) {
        // Two instances starting at once can race on CREATE ... IF NOT EXISTS (duplicate_object/table/unique): just retry.
        const code = (e as { code?: string }).code;
        if (attempt < 2 && (code === "23505" || code === "42P07" || code === "42710")) continue;
        throw e;
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Check out a client, retrying transient connect failures (cold Neon compute, dropped idle socket). */
  private async acquire(): Promise<PgClientLike> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.pool.connect();
      } catch (e) {
        lastErr = e;
        if (isPermanentConnectError(e)) break;
        if (attempt < 2) await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
    throw lastErr;
  }

  private async run<T>(fn: (c: PgClientLike) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    let broken = false;
    try {
      return await fn(c);
    } catch (e) {
      broken = isConnectionLoss(e);
      throw e;
    } finally {
      c.release(broken);
    }
  }

  private async tx<T>(fn: (c: PgClientLike) => Promise<T>): Promise<T> {
    return this.run(async (c) => {
      await c.query("BEGIN");
      try {
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        try {
          await c.query("ROLLBACK");
        } catch {
          // connection is gone; the server aborts the transaction by itself
        }
        throw e;
      }
    });
  }

  async create(poll: PollRecord): Promise<void> {
    await this.init();
    await this.run((c) =>
      c.query(
        `INSERT INTO ${this.table} (${POLL_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          poll.id,
          poll.hostTokenHash,
          poll.question,
          JSON.stringify(poll.options),
          poll.nextOptionSeq,
          poll.multiple,
          poll.allowAddOwn,
          poll.closesAt,
          poll.closedAt,
          poll.createdAt,
          poll.expiresAt,
          JSON.stringify(poll.votes),
          JSON.stringify(poll.adders),
        ],
      ),
    );
  }

  async get(id: string): Promise<PollRecord | null> {
    await this.init();
    const res = await this.run((c) => c.query(`SELECT ${POLL_COLUMNS} FROM ${this.table} WHERE id = $1`, [id]));
    const row = res.rows[0];
    return row ? fromRow(row) : null;
  }

  async update<T>(id: string, mutate: (draft: PollRecord) => T): Promise<{ result: T; poll: PollRecord } | null> {
    await this.init();
    return this.tx(async (c) => {
      // The row lock is what makes concurrent read-modify-write safe: the next writer waits here until we commit.
      const res = await c.query(`SELECT ${POLL_COLUMNS} FROM ${this.table} WHERE id = $1 FOR UPDATE`, [id]);
      const row = res.rows[0];
      if (!row) return null;
      const draft = fromRow(row);
      const result = mutate(draft); // throws => ROLLBACK, nothing saved
      await c.query(
        `UPDATE ${this.table} SET question=$2, options=$3, next_option_seq=$4, multiple=$5, allow_add_own=$6,
           closes_at=$7, closed_at=$8, expires_at=$9, votes=$10, adders=$11 WHERE id = $1`,
        [
          id,
          draft.question,
          JSON.stringify(draft.options),
          draft.nextOptionSeq,
          draft.multiple,
          draft.allowAddOwn,
          draft.closesAt,
          draft.closedAt,
          draft.expiresAt,
          JSON.stringify(draft.votes),
          JSON.stringify(draft.adders),
        ],
      );
      return { result, poll: structuredClone(draft) };
    });
  }

  async delete(id: string): Promise<void> {
    await this.init();
    await this.run((c) => c.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]));
  }

  async count(): Promise<number> {
    await this.init();
    const res = await this.run((c) => c.query(`SELECT count(*)::int AS n FROM ${this.table}`));
    return Number(res.rows[0]?.n ?? 0);
  }

  async deleteExpired(now: number): Promise<string[]> {
    await this.init();
    const res = await this.run((c) => c.query(`DELETE FROM ${this.table} WHERE expires_at <= $1 RETURNING id`, [now]));
    return res.rows.map((r) => String(r.id));
  }
}

function isConnectionLoss(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = e instanceof Error ? e.message : "";
  return (
    (typeof code === "string" && (code.startsWith("08") || code.startsWith("57P") || code === "ECONNRESET" || code === "EPIPE")) ||
    /Connection terminated|timeout/i.test(msg)
  );
}
