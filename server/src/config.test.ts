import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("defaults to the local Vite origin in development", () => {
    const c = loadConfig({});
    expect(c.clientOrigins).toContain("http://localhost:5173");
    expect(c.port).toBe(3001);
    expect(c.production).toBe(false);
  });
  it("requires CLIENT_ORIGIN in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/CLIENT_ORIGIN/);
  });
  it("parses a comma list and strips trailing slashes", () => {
    const c = loadConfig({ CLIENT_ORIGIN: "https://a.github.io/, https://b.example.com", PORT: "8080", TRUST_PROXY: "1" });
    expect(c.clientOrigins).toEqual(["https://a.github.io", "https://b.example.com"]);
    expect(c.port).toBe(8080);
    expect(c.trustProxyHops).toBe(1);
  });
  it.each(["*", "https://a.github.io/path", "ftp://x.com", "not a url"])("rejects origin %j", (o) => {
    expect(() => loadConfig({ CLIENT_ORIGIN: o })).toThrow();
  });
  it("reads rate limit overrides and rejects nonsense", () => {
    expect(loadConfig({}).limits).toEqual({ createPer10Min: 10, joinsPerMinPerIp: 60, eventsPer10sPerSocket: 30 });
    expect(loadConfig({ RATE_LIMIT_CREATE: "500" }).limits.createPer10Min).toBe(500);
    expect(() => loadConfig({ RATE_LIMIT_CREATE: "0" })).toThrow(/RATE_LIMIT_CREATE/);
  });
  it("rejects a bad port or proxy count", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow();
    expect(() => loadConfig({ TRUST_PROXY: "9" })).toThrow();
  });
});
