import { describe, expect, it } from "vitest";
import { LIMITS } from "./limits";
import { isValidVoterId, validateCreateInput, validateOptionLabel, validatePeople, validateQuestion } from "./validate";

const NOW = 1_700_000_000_000;
const good = { question: "Where do we eat?", options: ["Italiano", "Sushi"], multiple: false, allowAddOwn: true, closesAt: null };

describe("validateCreateInput", () => {
  it("accepts a valid poll and cleans text", () => {
    const r = validateCreateInput({ ...good, question: "  Where   do we eat? ", options: [" Italiano ", "Sushi"] }, NOW);
    expect(r).toEqual({ ok: true, value: { ...good, question: "Where do we eat?", options: ["Italiano", "Sushi"] } });
  });

  it.each([
    ["not an object", null],
    ["short question", { ...good, question: "ab" }],
    ["long question", { ...good, question: "x".repeat(LIMITS.questionMax + 1) }],
    ["one option", { ...good, options: ["Only"] }],
    ["seven options", { ...good, options: ["1", "2", "3", "4", "5", "6", "7"] }],
    ["non-string option", { ...good, options: ["A", 3] }],
    ["empty option", { ...good, options: ["A", "   "] }],
    ["long option", { ...good, options: ["A", "x".repeat(LIMITS.optionMax + 1)] }],
    ["duplicate options", { ...good, options: ["Café", "cafe!"] }],
    ["symbol-only option", { ...good, options: ["A", "***"] }],
    ["multiple not boolean", { ...good, multiple: "yes" }],
    ["allowAddOwn missing", { ...good, allowAddOwn: undefined }],
    ["closing in the past", { ...good, closesAt: NOW - 1 }],
    ["closing in 10 s", { ...good, closesAt: NOW + 10_000 }],
    ["closing in 8 days", { ...good, closesAt: NOW + 8 * 24 * 3600 * 1000 }],
    ["closing NaN", { ...good, closesAt: Number.NaN }],
  ])("rejects %s", (_name, input) => {
    expect(validateCreateInput(input, NOW).ok).toBe(false);
  });

  it("accepts 6 options and a valid closing time", () => {
    const r = validateCreateInput({ ...good, options: ["1", "2", "3", "4", "5", "6"], closesAt: NOW + 3_600_000 }, NOW);
    expect(r.ok).toBe(true);
  });
});

describe("validatePeople / question / option / voterId", () => {
  it.each([1, 2, 20])("accepts people=%i", (n) => expect(validatePeople(n).ok).toBe(true));
  it.each([0, 21, 1.5, -1, "3", null, Number.NaN])("rejects people=%j", (n) => expect(validatePeople(n).ok).toBe(false));
  it("validates question and option text", () => {
    expect(validateQuestion(42).ok).toBe(false);
    expect(validateOptionLabel(undefined).ok).toBe(false);
    expect(validateOptionLabel("Pizza").ok).toBe(true);
  });
  it("validates voter ids", () => {
    expect(isValidVoterId("a".repeat(16))).toBe(true);
    expect(isValidVoterId("short")).toBe(false);
    expect(isValidVoterId("has space and is long enough")).toBe(false);
    expect(isValidVoterId(5)).toBe(false);
  });
});
