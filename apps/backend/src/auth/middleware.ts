import type { NextFunction, Request, Response } from "express";
import { getSession } from "./session.js";

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await getSession(req, res);
  if (!session.authenticated) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  next();
}
