import { describe, expect, it } from "vitest";
import { cleanLabel, normalizeLabel } from "./normalize";

describe("normalizeLabel", () => {
  it.each([
    ["Italiano", "italiano"],
    ["  ITALIANO  ", "italiano"],
    ["Café   Nero!", "cafe nero"],
    ["Crème brûlée", "creme brulee"],
    ["Straße", "strasse"],
    ["Döner-Haus", "doner haus"],
    ["Thai\u00a0Food", "thai food"],
    ["ｓｕｓｈｉ", "sushi"],
  ])("%j -> %j", (input, out) => {
    expect(normalizeLabel(input)).toBe(out);
  });

  it("treats near-duplicates as equal", () => {
    expect(normalizeLabel("Pizza  Hut")).toBe(normalizeLabel("pizza hut."));
    expect(normalizeLabel("Sushi")).not.toBe(normalizeLabel("Sushi Bar"));
  });

  it("returns an empty key for symbol-only text", () => {
    expect(normalizeLabel("!!! ???")).toBe("");
  });
});

describe("cleanLabel", () => {
  it("trims, collapses whitespace and strips control characters", () => {
    expect(cleanLabel("  Pizza \n\t  Place\u0000 ")).toBe("Pizza Place");
  });
});
