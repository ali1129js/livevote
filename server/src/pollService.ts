import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  LIMITS,
  computeResults,
  isValidVoterId,
  normalizeLabel,
  validateCreateInput,
  validateOptionLabel,
  validatePeople,
  type AddOptionResult,
  type ApiError,
  type ClientState,
  type CreatePollResult,
  type ErrorCode,
  type PublicPoll,
  type VotePayload,
} from "@livevote/shared";
import type { PollRecord, PollStore } from "./store";

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
  toApi(): ApiError {
    return { code: this.code, message: this.message };
  }
}

export interface Viewer {
  voterId: string;
  isHost: boolean;
}

export interface ServiceOptions {
  clock?: () => number;
  maxPolls?: number;
}

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (i, l, o, 0, 1)

function randomId(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ID_ALPHABET[(bytes[i] ?? 0) % ID_ALPHABET.length];
  return out;
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isClosed(p: PollRecord, now: number): boolean {
  return p.closedAt !== null || (p.closesAt !== null && now >= p.closesAt);
}

export class PollService {
  private readonly clock: () => number;
  private readonly maxPolls: number;

  constructor(
    private readonly store: PollStore,
    opts: ServiceOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.maxPolls = opts.maxPolls ?? 5000;
  }

  async createPoll(raw: unknown): Promise<CreatePollResult> {
    const now = this.clock();
    const v = validateCreateInput(raw, now);
    if (!v.ok) throw new ServiceError("bad_request", v.message);
    if ((await this.store.count()) >= this.maxPolls) {
      throw new ServiceError("limit_reached", "The server is full right now. Please try again later.");
    }
    const input = v.value;
    const hostToken = randomBytes(24).toString("base64url");
    const record: PollRecord = {
      id: randomId(10),
      hostTokenHash: hashToken(hostToken),
      question: input.question,
      options: input.options.map((label, i) => ({ id: `o${i + 1}`, label, addedByVoter: false })),
      nextOptionSeq: input.options.length + 1,
      multiple: input.multiple,
      allowAddOwn: input.allowAddOwn,
      closesAt: input.closesAt,
      closedAt: null,
      createdAt: now,
      expiresAt: now + LIMITS.pollTtlMs,
      votes: {},
      adders: [],
    };
    await this.store.create(record);
    return { pollId: record.id, hostToken };
  }

  async load(pollId: string): Promise<PollRecord> {
    const p = typeof pollId === "string" ? await this.store.get(pollId) : null;
    if (!p || p.expiresAt <= this.clock()) throw new ServiceError("not_found", "This poll doesn't exist or has expired.");
    return p;
  }

  /** Validates the voter id and (optional) host token, and returns who is asking. */
  async authenticate(pollId: string, voterId: unknown, hostToken: unknown): Promise<{ viewer: Viewer; poll: PollRecord }> {
    if (!isValidVoterId(voterId)) throw new ServiceError("bad_request", "Invalid voter id.");
    const poll = await this.load(pollId);
    let isHost = false;
    if (hostToken !== undefined && hostToken !== null) {
      if (typeof hostToken !== "string" || hostToken.length > 128 || !tokenMatches(hostToken, poll.hostTokenHash)) {
        throw new ServiceError("forbidden", "This host link isn't valid.");
      }
      isHost = true;
    }
    return { viewer: { voterId, isHost }, poll };
  }

  viewFor(p: PollRecord, viewer: Viewer): ClientState {
    const now = this.clock();
    const closed = isClosed(p, now);
    const mine = p.votes[viewer.voterId];
    const publicPoll: PublicPoll = {
      id: p.id,
      question: p.question,
      options: p.options.map((o) => ({ ...o })),
      multiple: p.multiple,
      allowAddOwn: p.allowAddOwn,
      closesAt: p.closesAt,
      closed,
      closedBy: !closed ? null : p.closedAt !== null ? "host" : "time",
      expiresAt: p.expiresAt,
    };
    // Late joiners must vote first: results are only sent to people who voted, the host, or once closed.
    const maySeeResults = viewer.isHost || closed || mine !== undefined;
    return {
      poll: publicPoll,
      serverNow: now,
      isHost: viewer.isHost,
      myVote: mine ? { optionIds: [...mine.optionIds], people: mine.people } : null,
      canAddOption:
        p.allowAddOwn && !closed && !p.adders.includes(viewer.voterId) && p.options.length < LIMITS.optionsTotalMax,
      results: maySeeResults ? computeResults({ options: p.options, votes: Object.values(p.votes) }) : null,
    };
  }

  async castVote(pollId: string, viewer: Viewer, payload: VotePayload): Promise<PollRecord> {
    if (typeof payload !== "object" || payload === null || !Array.isArray(payload.optionIds)) {
      throw new ServiceError("bad_request", "Invalid vote.");
    }
    const people = validatePeople(payload.people);
    if (!people.ok) throw new ServiceError("bad_request", people.message);
    const ids = payload.optionIds;
    if (ids.length > LIMITS.optionsTotalMax || !ids.every((i) => typeof i === "string")) {
      throw new ServiceError("bad_request", "Invalid vote.");
    }
    const optionIds = [...new Set(ids)];
    const now = this.clock();
    const res = await this.store.update(pollId, (p) => {
      if (isClosed(p, now)) throw new ServiceError("closed", "This poll is closed.");
      if (optionIds.length < 1) throw new ServiceError("bad_request", "Pick at least one option.");
      if (!p.multiple && optionIds.length > 1) throw new ServiceError("bad_request", "Pick just one option.");
      if (!optionIds.every((id) => p.options.some((o) => o.id === id))) {
        throw new ServiceError("bad_request", "One of the options no longer exists. Please pick again.");
      }
      if (!(viewer.voterId in p.votes) && Object.keys(p.votes).length >= LIMITS.votersPerPollMax) {
        throw new ServiceError("limit_reached", "This poll has reached its voter limit.");
      }
      p.votes[viewer.voterId] = { optionIds, people: people.value, updatedAt: now };
    });
    if (!res) throw new ServiceError("not_found", "This poll doesn't exist or has expired.");
    return res.poll;
  }

  async addOption(pollId: string, viewer: Viewer, rawLabel: unknown): Promise<{ result: AddOptionResult; poll: PollRecord }> {
    const label = validateOptionLabel(rawLabel);
    if (!label.ok) throw new ServiceError("bad_request", label.message);
    const now = this.clock();
    const res = await this.store.update(pollId, (p): AddOptionResult => {
      if (isClosed(p, now)) throw new ServiceError("closed", "This poll is closed.");
      if (!p.allowAddOwn) throw new ServiceError("forbidden", "The host didn't enable adding your own option.");
      const key = normalizeLabel(label.value);
      const existing = p.options.find((o) => normalizeLabel(o.label) === key);
      if (existing) return { optionId: existing.id, merged: true }; // merged duplicate: doesn't use up the voter's add
      if (p.adders.includes(viewer.voterId)) throw new ServiceError("forbidden", "You've already added an option.");
      if (p.options.length >= LIMITS.optionsTotalMax) {
        throw new ServiceError("limit_reached", `This poll already has ${LIMITS.optionsTotalMax} options.`);
      }
      const id = `o${p.nextOptionSeq++}`;
      p.options.push({ id, label: label.value, addedByVoter: true });
      p.adders.push(viewer.voterId);
      return { optionId: id, merged: false };
    });
    if (!res) throw new ServiceError("not_found", "This poll doesn't exist or has expired.");
    return { result: res.result, poll: res.poll };
  }

  private requireHost(viewer: Viewer): void {
    if (!viewer.isHost) throw new ServiceError("forbidden", "Only the host can do that.");
  }

  async close(pollId: string, viewer: Viewer): Promise<PollRecord> {
    this.requireHost(viewer);
    const now = this.clock();
    const res = await this.store.update(pollId, (p) => {
      if (isClosed(p, now)) throw new ServiceError("closed", "This poll is already closed.");
      p.closedAt = now;
    });
    if (!res) throw new ServiceError("not_found", "This poll doesn't exist or has expired.");
    return res.poll;
  }

  /** Clears all votes (and voters' add-your-own allowances) and re-opens the poll. */
  async reset(pollId: string, viewer: Viewer): Promise<PollRecord> {
    this.requireHost(viewer);
    const now = this.clock();
    const res = await this.store.update(pollId, (p) => {
      p.votes = {};
      p.adders = [];
      p.closedAt = null;
      if (p.closesAt !== null && p.closesAt <= now) p.closesAt = null; // an elapsed deadline would re-close it at once
    });
    if (!res) throw new ServiceError("not_found", "This poll doesn't exist or has expired.");
    return res.poll;
  }

  async removeOption(pollId: string, viewer: Viewer, optionId: unknown): Promise<PollRecord> {
    this.requireHost(viewer);
    const now = this.clock();
    const res = await this.store.update(pollId, (p) => {
      if (isClosed(p, now)) throw new ServiceError("closed", "This poll is closed. Reset it to change options.");
      if (typeof optionId !== "string" || !p.options.some((o) => o.id === optionId)) {
        throw new ServiceError("bad_request", "That option doesn't exist.");
      }
      if (p.options.length <= LIMITS.optionsMin) {
        throw new ServiceError("bad_request", `A poll needs at least ${LIMITS.optionsMin} options.`);
      }
      p.options = p.options.filter((o) => o.id !== optionId);
      for (const [voterId, v] of Object.entries(p.votes)) {
        v.optionIds = v.optionIds.filter((id) => id !== optionId);
        if (v.optionIds.length === 0) delete p.votes[voterId]; // their only pick vanished: they can vote again
      }
    });
    if (!res) throw new ServiceError("not_found", "This poll doesn't exist or has expired.");
    return res.poll;
  }

  /** Delete polls older than 7 days. Returns the ids so sockets can be told. */
  sweepExpired(): Promise<string[]> {
    return this.store.deleteExpired(this.clock());
  }
}
