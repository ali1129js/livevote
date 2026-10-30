export interface Config {
  port: number;
  /** Allowed browser origins (exact match, no trailing slash). */
  clientOrigins: string[];
  /** Number of reverse proxies in front of us (Render: 1). */
  trustProxyHops: number;
  production: boolean;
  /** Postgres connection string (e.g. Neon). When null the volatile in-memory store is used. Secret: never log it. */
  databaseUrl: string | null;
  /** Rate limits (defaults suit one small team; raise for load tests / e2e). */
  limits: { createPer10Min: number; joinsPerMinPerIp: number; eventsPer10sPerSocket: number };
}

export function normalizeOrigin(o: string): string {
  return o.trim().replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const raw = env.CLIENT_ORIGIN?.trim();
  if (!raw && production) {
    throw new Error("CLIENT_ORIGIN is required in production (e.g. https://<user>.github.io).");
  }
  const clientOrigins = (raw ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  for (const o of clientOrigins) {
    if (o === "*" || !/^https?:\/\/[^/\s]+$/.test(o)) {
      throw new Error(`CLIENT_ORIGIN entries must be exact origins like https://example.com (got "${o}").`);
    }
  }
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  if (databaseUrl !== null && !/^postgres(ql)?:\/\/\S+$/.test(databaseUrl)) {
    // Deliberately do not echo the value: it contains a password.
    throw new Error("DATABASE_URL must be a postgres:// or postgresql:// connection string.");
  }
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a valid port number.");
  const trustProxyHops = Number(env.TRUST_PROXY ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    throw new Error("TRUST_PROXY must be an integer between 0 and 5.");
  }
  const int = (name: string, fallback: number, max: number): number => {
    const v = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`${name} must be an integer between 1 and ${max}.`);
    return v;
  };
  const limits = {
    createPer10Min: int("RATE_LIMIT_CREATE", 10, 10_000),
    joinsPerMinPerIp: int("RATE_LIMIT_JOINS", 60, 100_000),
    eventsPer10sPerSocket: int("RATE_LIMIT_EVENTS", 30, 100_000),
  };
  return { port, clientOrigins, trustProxyHops, production, databaseUrl, limits };
}
