import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeMongoClient } from "./integrations/mongodb.js";

const config = loadConfig();
const { app, db } = createApp(config);
const server = createServer(app);

await db.ready;
server.listen(config.PORT, () => {
  console.info(`ExamCure API listening on http://localhost:${config.PORT}`);
  console.info(`Swagger UI: http://localhost:${config.PORT}/api-docs`);
});

function shutdown(signal: string) {
  console.info(`${signal} received, shutting down...`);
  server.close(async () => {
    await closeMongoClient();
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
