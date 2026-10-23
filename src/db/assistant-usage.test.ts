import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "./database.js";
import { AssistantUsageRepository, assistantDayKey } from "./assistant-usage.js";

let db: AppDatabase, repo: AssistantUsageRepository;
const T = new Date("2026-05-10T03:00:00Z");
beforeEach(() => {
  db = new AppDatabase(process.env.TEST_MONGODB_URI!, "examcure_test_" + randomUUID().replaceAll("-", ""));
  repo = new AssistantUsageRepository(db);
});
afterEach(async () => {
  await db.close();
});

describe("assistantDayKey", () => {
  it("uses the UTC+7 calendar day", () => {
    expect(assistantDayKey(new Date("2026-05-10T16:59:59Z"))).toBe("2026-05-10");
    expect(assistantDayKey(new Date("2026-05-10T17:00:00Z"))).toBe("2026-05-11");
    expect(assistantDayKey(new Date("2026-12-31T17:00:00Z"))).toBe("2027-01-01");
  });
});

describe("assistant quota", () => {
  it("creates the doc on first reserve and stops at the limit", async () => {
    const u = randomUUID();
    expect(await repo.reserveAssistantQuota(u, T, 3)).toEqual({ ok: true, day: "2026-05-10", used: 1, remaining: 2 });
    expect(await repo.reserveAssistantQuota(u, T, 3)).toMatchObject({ ok: true, used: 2, remaining: 1 });
    expect(await repo.reserveAssistantQuota(u, T, 3)).toMatchObject({ ok: true, used: 3, remaining: 0 });
    expect(await repo.reserveAssistantQuota(u, T, 3)).toEqual({ ok: false, day: "2026-05-10", used: 3, remaining: 0 });
    expect(await repo.assistantUsage(u, T, 3)).toEqual({ used: 3, remaining: 0, limit: 3 });
    const doc = await db.findOne("assistant_usage", { user_id: u });
    expect(doc).toMatchObject({ day: "2026-05-10", count: 3 });
    expect((doc!.purge_at as Date).toISOString()).toBe("2026-05-17T17:00:00.000Z");
  });
  it("refund restores one and never goes below zero", async () => {
    const u = randomUUID();
    const r = await repo.reserveAssistantQuota(u, T, 2);
    await repo.reserveAssistantQuota(u, T, 2);
    await repo.refundAssistantQuota(u, r.day);
    expect((await repo.assistantUsage(u, T, 2)).used).toBe(1);
    await repo.refundAssistantQuota(u, r.day);
    await repo.refundAssistantQuota(u, r.day);
    expect((await repo.assistantUsage(u, T, 2)).used).toBe(0);
    expect(await repo.reserveAssistantQuota(u, T, 2)).toMatchObject({ ok: true, used: 1 });
  });
  it("refunds the reserved day even after midnight, and a new day resets", async () => {
    const u = randomUUID();
    const before = new Date("2026-05-10T16:59:59Z"),
      after = new Date("2026-05-10T17:00:01Z");
    const r = await repo.reserveAssistantQuota(u, before, 1);
    expect(await repo.reserveAssistantQuota(u, before, 1)).toMatchObject({ ok: false });
    expect(await repo.reserveAssistantQuota(u, after, 1)).toMatchObject({ ok: true, day: "2026-05-11", used: 1 });
    await repo.refundAssistantQuota(u, r.day);
    expect((await repo.assistantUsage(u, before, 1)).used).toBe(0);
    expect((await repo.assistantUsage(u, after, 1)).used).toBe(1);
  });
  // Open many pooled connections first so the reserves below really run in parallel.
  const warmPool = () => Promise.all(Array.from({ length: 30 }, () => db.count("assistant_usage")));
  it("grants every concurrent first-of-day reserve while under the limit", async () => {
    await warmPool();
    for (let round = 0; round < 5; round++) {
      const u = randomUUID();
      const results = await Promise.all(Array.from({ length: 12 }, () => repo.reserveAssistantQuota(u, T, 50)));
      expect(results.filter((r) => r.ok)).toHaveLength(12);
      expect((await db.findOne("assistant_usage", { user_id: u }))!.count).toBe(12);
    }
  });
  it("never exceeds the limit under concurrency", async () => {
    await warmPool();
    const u = randomUUID();
    const results = await Promise.all(Array.from({ length: 15 }, () => repo.reserveAssistantQuota(u, T, 5)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(10);
    expect((await db.findOne("assistant_usage", { user_id: u }))!.count).toBe(5);
  });
  it("keeps users independent", async () => {
    const a = randomUUID(),
      b = randomUUID();
    await repo.reserveAssistantQuota(a, T, 1);
    expect(await repo.reserveAssistantQuota(a, T, 1)).toMatchObject({ ok: false });
    expect(await repo.reserveAssistantQuota(b, T, 1)).toMatchObject({ ok: true, used: 1 });
    expect(await repo.assistantUsage(randomUUID(), T, 4)).toEqual({ used: 0, remaining: 4, limit: 4 });
  });
});
