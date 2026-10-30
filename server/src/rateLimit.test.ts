import { describe, expect, it } from "vitest";
import { RateLimiter, clientIp } from "./rateLimit";

describe("RateLimiter", () => {
  it("blocks after max hits in a window and recovers", () => {
    const l = new RateLimiter(3, 1000);
    expect([0, 1, 2, 3].map(() => l.allow("k", 0))).toEqual([true, true, true, false]);
    expect(l.allow("other", 0)).toBe(true);
    expect(l.allow("k", 999)).toBe(false);
    expect(l.allow("k", 1000)).toBe(true);
  });
  it("prunes expired windows", () => {
    const l = new RateLimiter(1, 10);
    l.allow("a", 0);
    l.allow("b", 5);
    l.prune(10);
    expect(l.size).toBe(1);
  });
});

describe("clientIp", () => {
  it("ignores X-Forwarded-For when no proxy is trusted (spoofing)", () => {
    expect(clientIp("1.2.3.4", "9.9.9.9", 0)).toBe("9.9.9.9");
  });
  it("takes the Nth entry from the right behind trusted proxies", () => {
    expect(clientIp("6.6.6.6, 1.2.3.4", "10.0.0.1", 1)).toBe("1.2.3.4");
    expect(clientIp("6.6.6.6, 1.2.3.4, 10.1.1.1", "10.0.0.1", 2)).toBe("1.2.3.4");
  });
  it("falls back to the socket address", () => {
    expect(clientIp(undefined, "9.9.9.9", 1)).toBe("9.9.9.9");
    expect(clientIp(undefined, undefined, 0)).toBe("unknown");
  });
});
