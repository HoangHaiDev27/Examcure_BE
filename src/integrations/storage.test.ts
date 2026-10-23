import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { AppDatabase } from "../db/database.js";
import { createStorage } from "./storage.js";

const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-storage-secret-at-least-thirty-two-characters",
  STORAGE_DRIVER: "mongo",
});
const opened: AppDatabase[] = [];
function setup() {
  const name = "examcure_test_" + randomUUID().replaceAll("-", "");
  const db = new AppDatabase(config.MONGODB_URI, name);
  opened.push(db);
  return { db, storage: createStorage(config, db) };
}
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

describe("mongo file storage", () => {
  it("round-trips a multi-chunk binary buffer", async () => {
    const { storage } = setup(),
      data = randomBytes(600 * 1024);
    await storage.put("a/b.bin", data, "application/octet-stream");
    expect(await storage.size("a/b.bin")).toBe(data.length);
    expect((await storage.get("a/b.bin")).equals(data)).toBe(true);
  });
  it("reports missing keys", async () => {
    const { storage } = setup();
    expect(await storage.size("missing")).toBeNull();
    await expect(storage.get("missing")).rejects.toThrow("File missing");
  });
  it("keeps exactly one revision per key", async () => {
    const { db, storage } = setup();
    await storage.put("k", Buffer.from("one"), "text/plain");
    await storage.put("k", Buffer.from("second"), "text/plain");
    expect((await storage.get("k")).toString()).toBe("second");
    await db.ready;
    const files = db.client
      .db(db.databaseName)
      .collection("material_files.files");
    expect(await files.countDocuments({ filename: "k" })).toBe(1);
  });
  it("converges under concurrent puts of the same key", async () => {
    const { db, storage } = setup();
    await Promise.all(
      [1, 2, 3, 4].map((n) => storage.put("c", Buffer.from("v" + n), "text/plain")),
    );
    await storage.put("c", Buffer.from("last"), "text/plain");
    const files = db.client
      .db(db.databaseName)
      .collection("material_files.files");
    expect(await files.countDocuments({ filename: "c" })).toBe(1);
    expect((await storage.get("c")).toString()).toBe("last");
  });
  it("requires a database", () => {
    expect(() => createStorage(config)).toThrow(/database/);
  });
});
