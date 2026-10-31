import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installProcessGuards, isTransientDbError, type ProcessLike } from "./processGuards";

function fakeProcess() {
  const ee = new EventEmitter();
  const exit = vi.fn();
  const proc = {
    on: (ev: string, l: (...a: any[]) => void) => ee.on(ev, l),
    exit,
  } as unknown as ProcessLike;
  return { ee, exit, proc };
}

describe("installProcessGuards", () => {
  it("keeps running on a rejected promise and logs only the class", () => {
    const { ee, exit, proc } = fakeProcess();
    const logs: string[] = [];
    installProcessGuards((m) => logs.push(m), proc);
    ee.emit(
      "unhandledRejection",
      Object.assign(new Error("secret host db.example.neon.tech"), {
        code: "ETIMEDOUT",
      }),
    );
    expect(exit).not.toHaveBeenCalled();
    expect(logs).toEqual(["unhandled rejection (ETIMEDOUT); continuing"]);
  });

  it("keeps running when the database drops a socket", () => {
    const { ee, exit, proc } = fakeProcess();
    installProcessGuards(() => {}, proc);
    ee.emit("uncaughtException", new Error("Connection terminated unexpectedly"));
    ee.emit("uncaughtException", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    expect(exit).not.toHaveBeenCalled();
  });

  it("still exits on a genuine programming error", () => {
    const { ee, exit, proc } = fakeProcess();
    installProcessGuards(() => {}, proc);
    ee.emit("uncaughtException", new TypeError("x is not a function"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("classifies transient database errors", () => {
    expect(isTransientDbError({ code: "57P01" })).toBe(true);
    expect(isTransientDbError(new Error("Connection terminated due to connection timeout"))).toBe(true);
    expect(isTransientDbError(new RangeError("nope"))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});
