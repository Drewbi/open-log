import argon2 from "argon2";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { EventsQuery, LoginRequest, RawLinesQuery, RawLinesSearchQuery } from "@open-log/shared-types";
import { requireAuth } from "../auth/middleware.js";
import { getSession } from "../auth/session.js";
import { config } from "../config.js";
import { getEventById, listEvents, listRawLinesAround, searchRawLines } from "../db/queries.js";
import { ingestEvents } from "../ingest/fileWatcher.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- Public auth routes ---

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

apiRouter.get("/auth/status", async (req, res) => {
  const session = await getSession(req, res);
  res.json({ authenticated: Boolean(session.authenticated) });
});

apiRouter.post("/auth/login", loginLimiter, async (req, res) => {
  const parsed = LoginRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!config.authPasswordHash) {
    res.status(500).json({ error: "AUTH_PASSWORD_HASH is not configured" });
    return;
  }
  const valid = await argon2.verify(config.authPasswordHash, parsed.data.password).catch(() => false);
  if (!valid) {
    res.status(401).json({ error: "invalid password" });
    return;
  }
  const session = await getSession(req, res);
  session.authenticated = true;
  await session.save();
  res.json({ ok: true });
});

apiRouter.post("/auth/logout", async (req, res) => {
  const session = await getSession(req, res);
  session.destroy();
  res.json({ ok: true });
});

// --- Everything below requires a valid session ---
apiRouter.use(requireAuth);

const HEARTBEAT_MS = 30_000;

apiRouter.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const send = (type: "event" | "raw_line", data: unknown) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };
  const onEvent = (data: unknown) => send("event", data);
  const onRawLine = (data: unknown) => send("raw_line", data);
  ingestEvents.on("event", onEvent);
  ingestEvents.on("raw_line", onRawLine);

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    ingestEvents.off("event", onEvent);
    ingestEvents.off("raw_line", onRawLine);
  });
});

apiRouter.get("/events", (req, res) => {
  const parsed = EventsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const events = listEvents(parsed.data);
  res.json({ events });
});

apiRouter.get("/events/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const event = getEventById(id);
  if (!event) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ event });
});

apiRouter.get("/raw-lines", (req, res) => {
  const parsed = RawLinesQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { aroundId, before, after } = parsed.data;
  const lines = listRawLinesAround(aroundId, before, after);
  res.json({ lines });
});

apiRouter.get("/raw-lines/search", (req, res) => {
  const parsed = RawLinesSearchQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const lines = searchRawLines(parsed.data);
  res.json({ lines });
});
