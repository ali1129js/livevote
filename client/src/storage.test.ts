import { describe, expect, it } from "vitest";
import { getVoterId, safeGet } from "./storage";

describe("getVoterId", () => {
  it("creates a valid id once and reuses it", () => {
    const a = getVoterId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(getVoterId()).toBe(a);
    expect(safeGet("livevote.voterId")).toBe(a);
  });
  it("replaces a corrupted stored id", () => {
    localStorage.setItem("livevote.voterId", "bad id!");
    expect(getVoterId()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
});
