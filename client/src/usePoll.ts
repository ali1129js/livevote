import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  Ack,
  AddOptionResult,
  ApiError,
  ClientState,
  ClientToServerEvents,
  ServerToClientEvents,
} from "@livevote/shared";
import { SERVER_URL, WAKING_AFTER_MS } from "./config";
import { getVoterId } from "./storage";

export type Connection = "connecting" | "waking" | "online" | "reconnecting";

type LiveSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface PollActions {
  vote(optionIds: string[], people: number): Promise<Ack>;
  addOption(label: string): Promise<Ack<AddOptionResult>>;
  close(): Promise<Ack>;
  reset(): Promise<Ack>;
  removeOption(optionId: string): Promise<Ack>;
}

export interface UsePoll {
  connection: Connection;
  /** Seconds since we started trying to connect (for the waking-up screen). */
  waitedSeconds: number;
  state: ClientState | null;
  fatal: ApiError | null;
  /** ms to add to Date.now() to get server time. */
  clockOffset: number;
  actions: PollActions;
}

const OFFLINE: ApiError = { code: "server_error", message: "You're offline. Reconnecting…" };
const ACK_TIMEOUT_MS = 8000;

export function usePoll(pollId: string, hostToken: string | null): UsePoll {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [waitedSeconds, setWaited] = useState(0);
  const [state, setState] = useState<ClientState | null>(null);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [clockOffset, setOffset] = useState(0);
  const socketRef = useRef<LiveSocket | null>(null);

  const apply = useCallback((s: ClientState) => {
    setState(s);
    setOffset(s.serverNow - Date.now());
  }, []);

  useEffect(() => {
    const voterId = getVoterId();
    const startedAt = Date.now();
    let everOnline = false;
    let disposed = false;

    const socket: LiveSocket = io(SERVER_URL, {
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 3000,
      timeout: 12_000,
    });
    socketRef.current = socket;

    const join = () => {
      socket.timeout(ACK_TIMEOUT_MS).emit(
        "poll:join",
        { pollId, voterId, ...(hostToken ? { hostToken } : {}) },
        (err: Error | null, ack?: Ack<ClientState>) => {
          if (disposed) return;
          if (err || !ack) return; // the next reconnect will retry
          if (ack.ok) {
            everOnline = true;
            setFatal(null);
            setConnection("online");
            apply((ack as { data: ClientState }).data);
          } else if (ack.error.code === "rate_limited") {
            setTimeout(() => !disposed && join(), 2000);
          } else {
            setFatal(ack.error);
            socket.disconnect();
          }
        },
      );
    };

    socket.on("connect", join);
    socket.on("poll:state", apply);
    socket.on("poll:gone", () => {
      setFatal({ code: "not_found", message: "This poll has expired or was removed." });
      socket.disconnect();
    });
    socket.on("disconnect", (reason) => {
      if (reason === "io client disconnect") return;
      setConnection(everOnline ? "reconnecting" : "connecting");
    });

    // Watch how long we've been waiting; a cold Render free instance takes ~30 s.
    const ticker = setInterval(() => {
      if (everOnline) return;
      const waited = Date.now() - startedAt;
      setWaited(Math.floor(waited / 1000));
      if (waited >= WAKING_AFTER_MS) setConnection((c) => (c === "online" ? c : "waking"));
    }, 500);

    return () => {
      disposed = true;
      clearInterval(ticker);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [pollId, hostToken, apply]);

  const call = useCallback(<T,>(event: keyof ClientToServerEvents, ...args: unknown[]): Promise<Ack<T>> => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return Promise.resolve({ ok: false, error: OFFLINE } as Ack<T>);
    return new Promise<Ack<T>>((resolve) => {
      (socket.timeout(ACK_TIMEOUT_MS).emit as (...a: unknown[]) => void)(event, ...args, (err: Error | null, ack: Ack<T>) => {
        if (err) resolve({ ok: false, error: { code: "server_error", message: "The server didn't answer in time. Try again." } } as Ack<T>);
        else resolve(ack);
      });
    });
  }, []);

  const refreshOnClosed = useCallback(
    async <T,>(p: Promise<Ack<T>>): Promise<Ack<T>> => {
      const ack = await p;
      if (!ack.ok && ack.error.code === "closed") {
        // Our view was stale: re-join to pull the closed state.
        socketRef.current?.timeout(ACK_TIMEOUT_MS).emit(
          "poll:join",
          { pollId, voterId: getVoterId(), ...(hostToken ? { hostToken } : {}) },
          (err: Error | null, a?: Ack<ClientState>) => {
            if (!err && a && a.ok) apply((a as { data: ClientState }).data);
          },
        );
      }
      return ack;
    },
    [pollId, hostToken, apply],
  );

  const actions: PollActions = {
    vote: (optionIds, people) => refreshOnClosed(call("vote:cast", { optionIds, people })),
    addOption: (label) => refreshOnClosed(call<AddOptionResult>("option:add", { label })),
    close: () => refreshOnClosed(call("host:close")),
    reset: () => call("host:reset"),
    removeOption: (optionId) => call("host:removeOption", { optionId }),
  };

  return { connection, waitedSeconds, state, fatal, clockOffset, actions };
}
