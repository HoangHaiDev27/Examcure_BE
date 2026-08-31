import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, db } = createApp(config);
const server = createServer(app);

server.listen(config.PORT, () => {
  console.info(`ExamCure API listening on http://localhost:${config.PORT}`);
  console.info(`Swagger UI: http://localhost:${config.PORT}/api-docs`);
});

function shutdown(signal: string) {
  console.info(`${signal} received, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
