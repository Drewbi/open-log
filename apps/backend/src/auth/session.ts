import type { SessionOptions } from "iron-session";
import { getIronSession } from "iron-session";
import type { Request, Response } from "express";
import { config } from "../config.js";

export interface SessionData {
  authenticated?: boolean;
}

export const sessionOptions: SessionOptions = {
  cookieName: "mc_log_timeline_session",
  password: config.sessionSecret,
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
};

export function getSession(req: Request, res: Response) {
  return getIronSession<SessionData>(req, res, sessionOptions);
}
