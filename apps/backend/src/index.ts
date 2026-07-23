import path from "node:path";
import express from "express";
import { config } from "./config.js";
import "./db/index.js";
import { apiRouter } from "./api/routes.js";
import { startIngestion } from "./ingest/fileWatcher.js";
import { RuleEngine } from "./rules/engine.js";

const ruleEngine = RuleEngine.loadFromFiles(config.rulesDefaultPath, config.rulesCustomPath);
startIngestion(ruleEngine);

const app = express();
app.set("trust proxy", "loopback");
app.use(express.json());
app.use("/api", apiRouter);

if (process.env.NODE_ENV === "production") {
  app.use(express.static(config.frontendDistPath));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.frontendDistPath, "index.html"));
  });
}

app.listen(config.port, () => {
  console.log(`open-log backend listening on :${config.port}`);
});
