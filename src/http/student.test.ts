import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ContentRepository } from "../db/content.js";
import { seedSubjects } from "../services/subject-seed.service.js";

const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-student-secret-at-least-thirty-two-characters",
});
let built: ReturnType<typeof createApp>, repo: ContentRepository;
beforeEach(() => {
  built = createApp(
    {
      ...config,
      MONGODB_DATABASE: "examcure_test_" + randomUUID().replaceAll("-", ""),
    },
    {
      otpSender: { async send() {} },
      storage: {
        async put() {},
        async get() {
          throw new Error("none");
        },
        async size() {
          return null;
        },
      },
    },
  );
  repo = new ContentRepository(built.db);
});
afterEach(async () => {
  await built.db.close();
});
async function student() {
  const user = await built.db.createUser({
    id: randomUUID(),
    email: randomUUID() + "@example.com",
    fullName: "User",
    passwordHash: null,
    mssv: "",
    schoolId: "fptu",
    role: "student",
    status: "active",
    googleSubject: null,
    emailVerifiedAt: new Date().toISOString(),
  });
  return { user, ...(await built.tokens.issue(user)) };
}
const entry = (over: Record<string, unknown> = {}) => ({
  code: "PRF192",
  name: "Programming Fundamentals",
  faculty: "CNTT",
  kind: "code",
  durationMin: 60,
  questionCount: 40,
  difficulty: "basic",
  curriculumTerms: [1],
  ...over,
});
const seed = (subjects: unknown[]) => ({ schoolCode: "fptu", subjects });
const list = (token: string, qs = "schoolCode=fptu") =>
  request(built.app)
    .get("/api/v1/Subjects?" + qs)
    .auth(token, { type: "bearer" });

describe("subject seed", () => {
  it("ships a valid seed file", async () => {
    const file = JSON.parse(
      readFileSync(new URL("../../seed/fptu-subjects.json", import.meta.url), "utf8"),
    );
    const r = await seedSubjects(built.db, file, { dryRun: true });
    expect(r.inserted).toBe(file.subjects.length);
  });
  it("inserts, then is idempotent", async () => {
    const input = seed([
      entry(),
      entry({ code: "ENG302c", curriculumTerms: [1, 3] }),
    ]);
    expect(await seedSubjects(built.db, input)).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(await seedSubjects(built.db, input)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
    });
    expect(await built.db.count("subjects")).toBe(2);
    const row = await built.db.findOne("subjects", { code: "ENG302C" });
    expect(row).toMatchObject({
      school_code: "fptu",
      display_code: "ENG302c",
      curriculum_terms: [1, 3],
      description: null,
      created_by: null,
    });
    const audits = await built.db.find("audit_logs", {
      action: "subjects.seeded",
    });
    expect(audits).toHaveLength(2);
  });
  it("keeps admin name/description and fills only missing metadata", async () => {
    const admin = await student();
    await repo.createSubject(admin.user.id, {
      schoolCode: "fptu",
      code: "prf192",
      name: "Admin name",
      description: "Admin desc",
    });
    expect(await seedSubjects(built.db, seed([entry()]))).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    const row = await built.db.findOne("subjects", { code: "PRF192" });
    expect(row).toMatchObject({
      name: "Admin name",
      description: "Admin desc",
      created_by: admin.user.id,
      faculty: "CNTT",
      display_code: "PRF192",
    });
    await built.db.update(
      "subjects",
      { code: "PRF192" },
      { $set: { faculty: "Custom" } },
    );
    await seedSubjects(built.db, seed([entry({ faculty: "Other" })]));
    expect((await built.db.findOne("subjects", { code: "PRF192" }))!.faculty).toBe(
      "Custom",
    );
    // admin re-save keeps the new fields
    await repo.createSubject(admin.user.id, {
      schoolCode: "fptu",
      code: "PRF192",
      name: "Renamed",
    });
    expect(await built.db.findOne("subjects", { code: "PRF192" })).toMatchObject({
      name: "Renamed",
      faculty: "Custom",
      curriculum_terms: [1],
      difficulty: "basic",
    });
  });
  it("dry run writes nothing", async () => {
    expect(
      await seedSubjects(built.db, seed([entry()]), { dryRun: true }),
    ).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(await built.db.count("subjects")).toBe(0);
    expect(await built.db.count("audit_logs")).toBe(0);
  });
});

describe("GET /Subjects", () => {
  it("requires a token", async () => {
    expect(
      (await request(built.app).get("/api/v1/Subjects?schoolCode=fptu")).status,
    ).toBe(401);
  });
  it("validates the query", async () => {
    const { token } = await student();
    expect((await list(token, "")).status).toBe(400);
    expect((await list(token, "schoolCode=a%20b")).status).toBe(400);
  });
  it("returns shape, sorting, filter, counts and per-user lastScore", async () => {
    const a = await student(),
      b = await student();
    await seedSubjects(
      built.db,
      seed([
        entry({ code: "ZZZ101", curriculumTerms: [1] }),
        entry({ code: "AAA201", curriculumTerms: [2, 1] }),
        entry({ code: "ENG302c", curriculumTerms: [3] }),
      ]),
    );
    await repo.createSubject(a.user.id, {
      schoolCode: "fptu",
      code: "NOTERM",
      name: "No terms",
    });
    await repo.createSubject(a.user.id, {
      schoolCode: "hcmus",
      code: "OTHER",
      name: "Other school",
    });
    const id = async (code: string) =>
      (await built.db.findOne("subjects", { code }))!.id as string;
    const eng = await id("ENG302C");
    for (const [status, n] of [
      ["published", 2],
      ["draft", 3],
    ] as const)
      for (let i = 0; i < n; i++)
        await repo.insert("exams", {
          subject_id: eng,
          title: "E",
          duration_minutes: 30,
          status,
          created_at: new Date().toISOString(),
        });
    const attempt = (user: string, score: number, at: string) =>
      repo.insert("attempts", {
        user_id: user,
        exam_id: randomUUID(),
        subject_id: eng,
        school_code: "fptu",
        answers: [],
        score,
        submitted_at: at,
      });
    await attempt(a.user.id, 4, "2026-01-01T00:00:00.000Z");
    await attempt(a.user.id, 7.5, "2026-02-01T00:00:00.000Z");
    await attempt(b.user.id, 9, "2026-03-01T00:00:00.000Z");

    const res = await list(a.token, "schoolCode=FPTU");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.subjects.map((s: any) => s.code)).toEqual([
      "AAA201",
      "ZZZ101",
      "ENG302c",
      "NOTERM",
    ]);
    const e = res.body.subjects[2];
    expect(e).toEqual({
      id: eng,
      schoolCode: "fptu",
      code: "ENG302c",
      name: "Programming Fundamentals",
      description: null,
      faculty: "CNTT",
      terms: [3],
      kind: "code",
      durationMin: 60,
      questionCount: 40,
      difficulty: "basic",
      publishedExamCount: 2,
      lastScore: 7.5,
    });
    const bare = res.body.subjects[3];
    expect(bare).toMatchObject({
      code: "NOTERM",
      terms: [],
      faculty: null,
      kind: null,
      durationMin: null,
      questionCount: null,
      difficulty: null,
      publishedExamCount: 0,
      lastScore: null,
    });
    expect(res.body.subjects[0].lastScore).toBeNull();
    expect((await list(b.token)).body.subjects[2].lastScore).toBe(9);

    const one = await list(a.token, "schoolCode=fptu&code=eng302C");
    expect(one.body.subjects.map((s: any) => s.code)).toEqual(["ENG302c"]);
    expect((await list(a.token, "schoolCode=nope")).body).toEqual({
      subjects: [],
    });
  });
});
