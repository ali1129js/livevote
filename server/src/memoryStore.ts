import type { PollRecord, PollStore } from "./store";

/** Volatile store: everything is lost on restart (acceptable for the free tier; polls live 7 days max). */
export class MemoryPollStore implements PollStore {
  private readonly polls = new Map<string, PollRecord>();

  async create(poll: PollRecord): Promise<void> {
    this.polls.set(poll.id, structuredClone(poll));
  }

  async get(id: string): Promise<PollRecord | null> {
    const p = this.polls.get(id);
    return p ? structuredClone(p) : null;
  }

  async update<T>(id: string, mutate: (draft: PollRecord) => T) {
    const current = this.polls.get(id);
    if (!current) return null;
    // Mutate a copy and commit only on success => all-or-nothing, and runs synchronously (no interleaving).
    const draft = structuredClone(current);
    const result = mutate(draft);
    this.polls.set(id, draft);
    return { result, poll: structuredClone(draft) };
  }

  async delete(id: string): Promise<void> {
    this.polls.delete(id);
  }

  async count(): Promise<number> {
    return this.polls.size;
  }

  async deleteExpired(now: number): Promise<string[]> {
    const removed: string[] = [];
    for (const [id, p] of this.polls) {
      if (p.expiresAt <= now) {
        this.polls.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }
}
