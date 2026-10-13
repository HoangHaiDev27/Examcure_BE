import { spawn } from "node:child_process";
import { startMongoFixture } from "./mongo-test-fixture.mjs";
const mode = process.argv[2];
const fixture = await startMongoFixture();
try {
  const args =
    mode === "database"
      ? ["--test", "tests/database.test.mjs"]
      : [
          "node_modules/vitest/vitest.mjs",
          ...(mode === "watch" ? ["src"] : ["run", "src"]),
          "--testTimeout=15000",
          "--hookTimeout=20000",
          ...process.argv.slice(3),
        ];
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, TEST_MONGODB_URI: fixture.uri },
  });
  const interrupt = () => child.kill();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  process.exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
} finally {
  await fixture.stop();
}
