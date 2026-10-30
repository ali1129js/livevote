import { createServer, type Server as HttpServer } from "node:http";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { Server, type Socket } from "socket.io";
import {
  type Ack,
  type ClientToServerEvents,
  type JoinPayload,
  type ServerToClientEvents,
} from "@livevote/shared";
import type { Config } from "./config";
import { MemoryPollStore } from "./memoryStore";
import { PollService, ServiceError, type Viewer } from "./pollService";
import { RateLimiter, clientIp } from "./rateLimit";
import type { PollStore } from "./store";

interface SocketData {
  pollId?: string;
  viewer?: Viewer;
}

type LiveSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface AppOptions {
  config: Config;
  store?: PollStore;
  clock?: () => number;
  /** Override limits (tests). */
  limits?: { createPerWindow?: number; eventsPerSocket?: number; joinsPerIp?: number; maxPolls?: number };
  log?: (msg: string) => void;
}

export interface RunningApp {
  httpServer: HttpServer;
  service: PollService;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

const room = (pollId: string) => `poll:${pollId}`;

function toAck(e: unknown, log: (m: string) => void): Ack {
  if (e instanceof ServiceError) return { ok: false, error: e.toApi() };
  log(`unexpected error: ${e instanceof Error ? e.name : "unknown"}`);
  return { ok: false, error: { code: "server_error", message: "Something went wrong on the server." } };
}

export function createApp(opts: AppOptions): RunningApp {
  const { config } = opts;
  const clock = opts.clock ?? Date.now;
  const log = opts.log ?? ((m: string) => console.log(`[livevote] ${m}`));
  const store = opts.store ?? new MemoryPollStore();
  const service = new PollService(store, { clock, maxPolls: opts.limits?.maxPolls ?? 5000 });

  const createLimiter = new RateLimiter(opts.limits?.createPerWindow ?? config.limits.createPer10Min, 10 * 60_000);
  const joinLimiter = new RateLimiter(opts.limits?.joinsPerIp ?? config.limits.joinsPerMinPerIp, 60_000);
  const eventLimiter = new RateLimiter(opts.limits?.eventsPerSocket ?? config.limits.eventsPer10sPerSocket, 10_000);

  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin(origin, cb) {
        // No Origin header => not a browser cross-site request (curl, health checks): allowed, but gets no CORS headers.
        if (!origin || config.clientOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ["GET", "POST"],
      maxAge: 600,
    }),
  );

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/polls", express.json({ limit: "8kb" }), async (req, res, next) => {
    try {
      const origin = req.headers.origin;
      if (origin && !config.clientOrigins.includes(origin)) {
        res.status(403).json({ ok: false, error: { code: "forbidden", message: "Origin not allowed." } });
        return;
      }
      const ip = clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress, config.trustProxyHops);
      if (!createLimiter.allow(ip, clock())) {
        res.status(429).json({ ok: false, error: { code: "rate_limited", message: "Too many polls created. Try again in a few minutes." } });
        return;
      }
      const data = await service.createPoll(req.body as unknown);
      res.status(201).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: "not_found", message: "Not found." } });
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (err instanceof ServiceError) {
      const status = err.code === "bad_request" ? 400 : err.code === "limit_reached" ? 503 : 400;
      res.status(status).json({ ok: false, error: err.toApi() });
      return;
    }
    const status = typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? err.status : 500;
    if (status >= 500) log("unexpected http error");
    res.status(status).json({
      ok: false,
      error: { code: status === 500 ? "server_error" : "bad_request", message: status === 500 ? "Something went wrong." : "Invalid request." },
    });
  };
  app.use(onError);

  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    cors: { origin: config.clientOrigins, methods: ["GET", "POST"] },
    maxHttpBufferSize: 10_000,
    // Free-tier proxies drop idle sockets quietly; keep the heartbeat short so clients notice and reconnect.
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  /** Send every connected viewer of a poll the state they are allowed to see. */
  async function broadcast(pollId: string): Promise<void> {
    let poll;
    try {
      poll = await service.load(pollId);
    } catch {
      io.to(room(pollId)).emit("poll:gone");
      return;
    }
    const sockets = await io.in(room(pollId)).fetchSockets();
    for (const s of sockets) {
      const viewer = s.data.viewer;
      if (viewer) s.emit("poll:state", service.viewFor(poll, viewer));
    }
    scheduleClose(poll.id, poll.closesAt, poll.closedAt);
  }

  // When a poll's closing time passes, tell everyone (results unlock for non-voters).
  const closeTimers = new Map<string, NodeJS.Timeout>();
  function scheduleClose(pollId: string, closesAt: number | null, closedAt: number | null): void {
    const existing = closeTimers.get(pollId);
    if (existing) clearTimeout(existing);
    closeTimers.delete(pollId);
    if (closesAt === null || closedAt !== null) return;
    const delay = closesAt - clock();
    if (delay <= 0 || delay > 2 ** 31 - 1) return;
    const t = setTimeout(() => {
      closeTimers.delete(pollId);
      void broadcast(pollId);
    }, delay + 20);
    t.unref();
    closeTimers.set(pollId, t);
  }

  function guard<A extends unknown[]>(
    socket: LiveSocket,
    handler: (viewer: Viewer, pollId: string, ...args: A) => Promise<void>,
  ) {
    return (...raw: unknown[]) => {
      const ack = raw[raw.length - 1];
      const reply: (a: Ack) => void = typeof ack === "function" ? (ack as (a: Ack) => void) : () => undefined;
      const args = raw.slice(0, -1) as A;
      void (async () => {
        try {
          if (!eventLimiter.allow(socket.id, clock())) {
            throw new ServiceError("rate_limited", "Slow down a little and try again.");
          }
          const { viewer, pollId } = socket.data;
          if (!viewer || !pollId) throw new ServiceError("not_joined", "Join a poll first.");
          await handler(viewer, pollId, ...args);
          reply({ ok: true });
        } catch (e) {
          reply(toAck(e, log));
        }
      })();
    };
  }

  io.on("connection", (socket: LiveSocket) => {
    socket.on("poll:join", (payload: JoinPayload, ack) => {
      const reply = typeof ack === "function" ? ack : () => undefined;
      void (async () => {
        try {
          const ip = clientIp(socket.handshake.headers["x-forwarded-for"], socket.handshake.address, config.trustProxyHops);
          if (!joinLimiter.allow(ip, clock()) || !eventLimiter.allow(socket.id, clock())) {
            throw new ServiceError("rate_limited", "Too many requests. Try again in a moment.");
          }
          if (typeof payload !== "object" || payload === null || typeof payload.pollId !== "string" || payload.pollId.length > 32) {
            throw new ServiceError("bad_request", "Invalid poll link.");
          }
          const { viewer, poll } = await service.authenticate(payload.pollId, payload.voterId, payload.hostToken);
          // Leave any previously joined poll, then join this one.
          if (socket.data.pollId && socket.data.pollId !== poll.id) await socket.leave(room(socket.data.pollId));
          socket.data.pollId = poll.id;
          socket.data.viewer = viewer;
          await socket.join(room(poll.id));
          scheduleClose(poll.id, poll.closesAt, poll.closedAt);
          reply({ ok: true, data: service.viewFor(poll, viewer) });
        } catch (e) {
          reply(toAck(e, log) as Ack<never>);
        }
      })();
    });

    socket.on(
      "vote:cast",
      guard(socket, async (viewer, pollId, payload: unknown) => {
        await service.castVote(pollId, viewer, payload as never);
        await broadcast(pollId);
      }),
    );

    socket.on("option:add", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => undefined;
      void (async () => {
        try {
          if (!eventLimiter.allow(socket.id, clock())) throw new ServiceError("rate_limited", "Slow down a little and try again.");
          const { viewer, pollId } = socket.data;
          if (!viewer || !pollId) throw new ServiceError("not_joined", "Join a poll first.");
          const { result } = await service.addOption(pollId, viewer, (payload as { label?: unknown } | null)?.label);
          reply({ ok: true, data: result });
          await broadcast(pollId);
        } catch (e) {
          reply(toAck(e, log) as Ack<never>);
        }
      })();
    });

    socket.on(
      "host:close",
      guard(socket, async (viewer, pollId) => {
        await service.close(pollId, viewer);
        await broadcast(pollId);
      }),
    );
    socket.on(
      "host:reset",
      guard(socket, async (viewer, pollId) => {
        await service.reset(pollId, viewer);
        await broadcast(pollId);
      }),
    );
    socket.on(
      "host:removeOption",
      guard(socket, async (viewer, pollId, payload: unknown) => {
        await service.removeOption(pollId, viewer, (payload as { optionId?: unknown } | null)?.optionId);
        await broadcast(pollId);
      }),
    );
  });

  // Housekeeping: expire polls after 7 days and prune rate-limit windows.
  const sweeper = setInterval(() => {
    const now = clock();
    createLimiter.prune(now);
    joinLimiter.prune(now);
    eventLimiter.prune(now);
    void service.sweepExpired().then((ids) => {
      for (const id of ids) io.to(room(id)).emit("poll:gone");
    });
  }, 60_000);
  sweeper.unref();

  return {
    httpServer,
    service,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, () => {
          const addr = httpServer.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },
    async close() {
      clearInterval(sweeper);
      for (const t of closeTimers.values()) clearTimeout(t);
      await io.close();
      if (httpServer.listening) await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
