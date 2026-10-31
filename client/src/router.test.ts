import { describe, expect, it } from "vitest";
import { parseHash, pollLink } from "./router";

describe("parseHash", () => {
  it("routes the empty hash to the create screen", () => {
    expect(parseHash("")).toEqual({ name: "create" });
    expect(parseHash("#/")).toEqual({ name: "create" });
  });
  it("parses voter and host links", () => {
    expect(parseHash("#/p/abcd2345xy")).toEqual({ name: "poll", pollId: "abcd2345xy", hostToken: null });
    expect(parseHash("#/p/abcd2345xy/host/Tok-en_1234567890")).toEqual({ name: "poll", pollId: "abcd2345xy", hostToken: "Tok-en_1234567890" });
  });
  it.each(["#/p", "#/p/!!", "#/p/abcd2345xy/host", "#/p/abcd2345xy/admin/xxxxxxxxxx", "#/p/abcd2345xy/host/short", "#/nope"])("treats %s as not found", (h) => {
    expect(parseHash(h)).toEqual({ name: "notfound" });
  });
  it("builds absolute links with the Vite base", () => {
    expect(pollLink("abc12345")).toMatch(/#\/p\/abc12345$/);
    expect(pollLink("abc12345", "tok")).toMatch(/#\/p\/abc12345\/host\/tok$/);
  });
});
