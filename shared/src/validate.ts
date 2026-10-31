import { LIMITS } from "./limits";
import { cleanLabel, normalizeLabel } from "./normalize";
import type { CreatePollInput } from "./types";

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

export function validateQuestion(raw: unknown): Validation<string> {
  if (typeof raw !== "string") return fail("Question is required.");
  const q = cleanLabel(raw);
  if (q.length < 3) return fail("Question must have at least 3 characters.");
  if (q.length > LIMITS.questionMax) return fail(`Question can have at most ${LIMITS.questionMax} characters.`);
  return { ok: true, value: q };
}

export function validateOptionLabel(raw: unknown): Validation<string> {
  if (typeof raw !== "string") return fail("Option text is required.");
  const label = cleanLabel(raw);
  if (label.length < 1) return fail("Option text can't be empty.");
  if (label.length > LIMITS.optionMax) return fail(`Options can have at most ${LIMITS.optionMax} characters.`);
  if (normalizeLabel(label) === "") return fail("Option text needs letters or numbers.");
  return { ok: true, value: label };
}

export function validatePeople(raw: unknown): Validation<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return fail("People must be a whole number.");
  if (raw < LIMITS.peopleMin || raw > LIMITS.peopleMax) {
    return fail(`People must be between ${LIMITS.peopleMin} and ${LIMITS.peopleMax}.`);
  }
  return { ok: true, value: raw };
}

export function validateCreateInput(raw: unknown, now: number): Validation<CreatePollInput> {
  if (typeof raw !== "object" || raw === null) return fail("Invalid request.");
  const r = raw as Record<string, unknown>;

  const q = validateQuestion(r.question);
  if (!q.ok) return q;

  if (!Array.isArray(r.options)) return fail("Options are required.");
  if (r.options.length < LIMITS.optionsMin || r.options.length > LIMITS.optionsMax) {
    return fail(`Add between ${LIMITS.optionsMin} and ${LIMITS.optionsMax} options.`);
  }
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of r.options as unknown[]) {
    const o = validateOptionLabel(item);
    if (!o.ok) return o;
    const key = normalizeLabel(o.value);
    if (seen.has(key)) return fail(`"${o.value}" appears twice. Options must be different.`);
    seen.add(key);
    options.push(o.value);
  }

  if (typeof r.multiple !== "boolean") return fail("Multiple-picks setting is required.");
  if (typeof r.allowAddOwn !== "boolean") return fail("Add-your-own setting is required.");

  let closesAt: number | null = null;
  if (r.closesAt !== null && r.closesAt !== undefined) {
    if (typeof r.closesAt !== "number" || !Number.isFinite(r.closesAt)) return fail("Closing time is invalid.");
    if (r.closesAt <= now + 60_000) return fail("Closing time must be at least a minute in the future.");
    if (r.closesAt > now + LIMITS.closeMaxAheadMs) return fail("Closing time can be at most 7 days ahead.");
    closesAt = Math.floor(r.closesAt);
  }

  return { ok: true, value: { question: q.value, options, multiple: r.multiple, allowAddOwn: r.allowAddOwn, closesAt } };
}

export function isValidVoterId(v: unknown): v is string {
  return typeof v === "string" && v.length >= LIMITS.voterIdMin && v.length <= LIMITS.voterIdMax && /^[A-Za-z0-9_-]+$/.test(v);
}
