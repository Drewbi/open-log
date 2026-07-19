import "dotenv/config";
import path from "node:path";

function resolveFromCwd(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export const config = {
  logsDir: resolveFromCwd(process.env.MC_LOGS_DIR ?? "../../example-data/logs"),
  dbPath: resolveFromCwd(process.env.DB_PATH ?? "./data/open-log.db"),
  port: Number(process.env.PORT ?? 4000),
  serverTzOffsetHours: Number(process.env.SERVER_TZ_OFFSET_HOURS ?? 0),
  watchUsePolling: process.env.WATCH_USE_POLLING === "true",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me-32chars",
  authPasswordHash: process.env.AUTH_PASSWORD_HASH ?? "",
  rulesDefaultPath: resolveFromCwd(process.env.RULES_DEFAULT_PATH ?? "../../config/rules.default.json"),
  rulesCustomPath: resolveFromCwd(process.env.RULES_CUSTOM_PATH ?? "../../config/rules.custom.json"),
  frontendDistPath: resolveFromCwd(process.env.FRONTEND_DIST_PATH ?? "../frontend/dist"),
};
