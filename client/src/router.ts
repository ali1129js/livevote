import { useEffect, useState } from "react";

export type Route =
  | { name: "create" }
  | { name: "poll"; pollId: string; hostToken: string | null }
  | { name: "notfound" };

/** Hash routes work on GitHub Pages without server rewrites, and keep the host token out of server logs. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "create" };
  const [p, id, h, token] = parts;
  if (p === "p" && id && /^[A-Za-z0-9]{4,32}$/.test(id)) {
    if (parts.length === 2) return { name: "poll", pollId: id, hostToken: null };
    if (parts.length === 4 && h === "host" && token && /^[A-Za-z0-9_-]{8,128}$/.test(token)) {
      return { name: "poll", pollId: id, hostToken: token };
    }
  }
  return { name: "notfound" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const navigate = (hash: string): void => {
  window.location.hash = hash;
};

/** Absolute link to open a poll, honouring the Vite base path (GitHub Pages sub-path). */
export function pollLink(pollId: string, hostToken?: string): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`;
  return `${base}#/p/${pollId}${hostToken ? `/host/${hostToken}` : ""}`;
}
