/** Minimal slice of `process` we hook, so tests can pass an EventEmitter. */
export interface ProcessLike {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (err: Error) => void): unknown;
  exit(code?: number): never | void;
}

/** True for socket-level errors from the database driver (Neon suspending, a pooler restart, a reset connection). */
export function isTransientDbError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = e instanceof Error ? e.message : "";
  return (
    (typeof code === "string" &&
      (code.startsWith("08") || code.startsWith("57P") || ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED"].includes(code))) ||
    /Connection terminated|Client has encountered a connection error|read ECONNRESET/i.test(msg)
  );
}

/**
 * A free instance has no supervisor beyond Render's restart, and a restart means a cold start for the next visitor.
 * So: a rejected promise or a dropped database socket is logged (class/code only, never the message: driver messages can
 * contain hosts) and the process keeps serving. Any other uncaught exception is a real bug: log it and exit non-zero.
 */
export function installProcessGuards(log: (msg: string) => void, proc: ProcessLike = process): void {
  const label = (e: unknown): string => {
    const err = e as { code?: string; name?: string } | null;
    return err?.code ?? err?.name ?? typeof e;
  };
  proc.on("unhandledRejection", (reason) => log(`unhandled rejection (${label(reason)}); continuing`));
  proc.on("uncaughtException", (err) => {
    if (isTransientDbError(err)) {
      log(`database connection error (${label(err)}); continuing`);
      return;
    }
    log(`fatal uncaught exception (${label(err)}); exiting`);
    proc.exit(1);
  });
}
