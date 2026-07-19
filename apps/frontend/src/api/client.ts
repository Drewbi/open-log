import type { RawLine, TimelineEvent } from "@open-log/shared-types";

async function getJson<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url.toString().replace(window.location.origin, ""));
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface ListEventsParams {
  [key: string]: string | number | undefined;
  from?: number;
  to?: number;
  types?: string;
  actor?: string;
  limit?: number;
}

export function fetchEvents(params: ListEventsParams): Promise<{ events: TimelineEvent[] }> {
  return getJson("/api/events", params);
}

export interface ListRawLinesParams {
  [key: string]: string | number | undefined;
  aroundId?: number;
  before?: number;
  after?: number;
}

export function fetchRawLines(params: ListRawLinesParams): Promise<{ lines: RawLine[] }> {
  return getJson("/api/raw-lines", params);
}

export function searchRawLines(q: string, limit = 100): Promise<{ lines: RawLine[] }> {
  return getJson("/api/raw-lines/search", { q, limit });
}

export async function getAuthStatus(): Promise<{ authenticated: boolean; serverName: string }> {
  const res = await fetch("/api/auth/status");
  if (!res.ok) throw new Error(`auth status failed: ${res.status}`);
  return res.json();
}

export async function login(password: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error === "invalid password" ? "Incorrect password" : `Login failed: ${res.status}`);
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
