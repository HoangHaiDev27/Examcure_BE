import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
const docker = async (...args) =>
  (
    await exec("docker", args, {
      windowsHide: true,
      // A fresh machine may need to download the MongoDB image on its first run.
      timeout: args[0] === "run" ? 300000 : 30000,
    })
  ).stdout.trim();

/** Own ephemeral replica set, no host volumes or existing database credentials. */
export async function startMongoFixture({ replicaSet = true } = {}) {
  const name = `examcure-mongo-test-${randomUUID()}`;
  await docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "-p",
    "127.0.0.1::27017",
    "mongo:8.0",
    ...(replicaSet ? ["--replSet", "examcure-rs"] : []),
    "--bind_ip_all",
  );
  const stop = () => docker("stop", name);
  try {
    const port = (await docker("port", name, "27017/tcp")).split(":").at(-1);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await docker(
          "exec",
          name,
          "mongosh",
          "--quiet",
          "--eval",
          replicaSet
            ? 'try { rs.status() } catch(e) { rs.initiate({_id:"examcure-rs",members:[{_id:0,host:"127.0.0.1:27017"}]}) }; if(!db.hello().isWritablePrimary) quit(1)'
            : "if(!db.runCommand({ping:1}).ok) quit(1)",
        );
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!ready)
      throw new Error("Isolated MongoDB replica set did not become primary");
    return {
      uri: `mongodb://127.0.0.1:${port}/?directConnection=true${replicaSet ? "&replicaSet=examcure-rs" : ""}`,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
