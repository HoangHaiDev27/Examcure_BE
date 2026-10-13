import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppDatabase } from "../dist/db/database.js";
import { loadConfig } from "../dist/config.js";
import { seedSubjects } from "../dist/services/subject-seed.service.js";

const args = process.argv.slice(2),
  fileFlag = args.indexOf("--file"),
  file = resolve(
    fileFlag >= 0 && args[fileFlag + 1]
      ? args[fileFlag + 1]
      : "seed/fptu-subjects.json",
  ),
  dryRun = args.includes("--dry-run");
const config = loadConfig(process.env, "maintenance"),
  db = new AppDatabase(config.MONGODB_URI, config.MONGODB_DATABASE);
try {
  await db.ready;
  const input = JSON.parse(await readFile(file, "utf8"));
  console.log(
    JSON.stringify(
      { dryRun, ...(await seedSubjects(db, input, { dryRun })) },
      null,
      2,
    ),
  );
} finally {
  await db.close();
}
