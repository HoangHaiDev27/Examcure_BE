import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ContentRepository } from "../db/content.js";

const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-me-secret-at-least-thirty-two-characters",
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
async function user(schoolId = "fptu") {
  const u = await built.db.createUser({
    id: randomUUID(),
    email: randomUUID() + "@example.com",
    fullName: "User",
    passwordHash: null,
    mssv: "",
    schoolId,
    role: "student",
    status: "active",
    googleSubject: null,
    emailVerifiedAt: new Date().toISOString(),
  });
  return { user: u, ...(await built.tokens.issue(u)) };
}
const get = (t: string, p: string) =>
  request(built.app).get("/api/v1" + p).auth(t, { type: "bearer" });
const iso = (daysAgo: number, extraMs = 0) =>
  new Date(Date.now() - daysAgo * 86400000 + extraMs).toISOString();
async function subject(code: string) {
  return repo.insert("subjects", {
    school_code: "fptu",
    code,
    name: "Name " + code,
    description: null,
    created_by: null,
    created_at: iso(0),
  });
}
async function exam(subjectId: string) {
  return repo.insert("exams", {
    subject_id: subjectId,
    title: "Exam " + subjectId.slice(0, 4),
    duration_minutes: 30,
    status: "published",
    created_at: iso(0),
  });
}
async function attempt(
  userId: string,
  subjectId: string,
  score: number,
  submittedAt: string,
  answers: unknown[] = [],
  examId?: string,
) {
  return repo.insert("attempts", {
    user_id: userId,
    exam_id: examId ?? (await exam(subjectId)),
    subject_id: subjectId,
    school_code: "fptu",
    answers,
    correct_count: 1,
    total_count: 2,
    score,
    spent_sec: 10,
    submitted_at: submittedAt,
  });
}

describe("Me routes", () => {
  it("require auth", async () => {
    for (const p of ["/Me/attempts", "/Me/dashboard", "/Me/wrong-answers"])
      expect((await request(built.app).get("/api/v1" + p)).status).toBe(401);
  });

  it("paginates attempts and isolates users", async () => {
    const me = await user(),
      other = await user(),
      s = await subject("PRF192");
    const times = [5, 4, 3, 2, 1].map((d) => iso(d));
    for (const [i, t] of times.entries()) await attempt(me.user.id, s, i, t);
    await attempt(other.user.id, s, 9, iso(0));
    const p1 = await get(me.token, "/Me/attempts?limit=2");
    expect(p1.status).toBe(200);
    expect(p1.body.attempts.map((a: any) => a.score)).toEqual([4, 3]);
    expect(p1.body.attempts[0]).toMatchObject({
      subjectId: s,
      subjectCode: "PRF192",
      subjectName: "Name PRF192",
      correctCount: 1,
      totalCount: 2,
      submittedAt: times[4],
    });
    expect(p1.body.nextBefore).toBe(times[3]);
    const p2 = await get(
      me.token,
      `/Me/attempts?limit=2&before=${encodeURIComponent(p1.body.nextBefore)}`,
    );
    expect(p2.body.attempts.map((a: any) => a.score)).toEqual([2, 1]);
    const p3 = await get(
      me.token,
      `/Me/attempts?limit=2&before=${encodeURIComponent(p2.body.nextBefore)}`,
    );
    expect(p3.body.attempts.map((a: any) => a.score)).toEqual([0]);
    expect(p3.body.nextBefore).toBeNull();
    for (const q of ["limit=0", "limit=51", "limit=x", "before=nope"])
      expect((await get(me.token, "/Me/attempts?" + q)).status).toBe(400);
  });

  it("computes dashboard stats", async () => {
    const me = await user(),
      a = await subject("AAA101"),
      b = await subject("BBB101");
    // oldest -> newest; 10 attempts so trend is capped at 8
    await attempt(me.user.id, a, 8, iso(30));
    await attempt(me.user.id, a, 6, iso(20));
    await attempt(me.user.id, b, 3, iso(6));
    await attempt(me.user.id, b, 4, iso(2));
    await attempt(me.user.id, a, 7, iso(1));
    const r = await get(me.token, "/Me/dashboard");
    expect(r.status).toBe(200);
    expect(r.body.stats).toEqual({
      totalAttempts: 5,
      averageScore: 5.6,
      attemptsThisWeek: 3,
      subjectsInProgress: 2,
      rankPercentile: null,
    });
    expect(r.body.trend.map((t: any) => t.score)).toEqual([8, 6, 3, 4, 7]);
    expect(r.body.recentAttempts.map((t: any) => t.score)).toEqual([
      7, 4, 3, 6, 8,
    ]);
    expect(r.body.weakestSubject).toEqual({
      subjectId: b,
      code: "BBB101",
      name: "Name BBB101",
      averageScore: 3.5,
    });
    for (let i = 0; i < 5; i++) await attempt(me.user.id, a, 5, iso(0, -i));
    const r2 = await get(me.token, "/Me/dashboard");
    expect(r2.body.trend).toHaveLength(8);
    expect(r2.body.recentAttempts).toHaveLength(5);
  });

  it("empty user gets zeros and nulls", async () => {
    const me = await user();
    const r = await get(me.token, "/Me/dashboard");
    expect(r.body).toEqual({
      stats: {
        totalAttempts: 0,
        averageScore: null,
        attemptsThisWeek: 0,
        subjectsInProgress: 0,
        rankPercentile: null,
      },
      trend: [],
      recentAttempts: [],
      weakestSubject: null,
    });
    expect((await get(me.token, "/Me/attempts")).body).toEqual({
      attempts: [],
      nextBefore: null,
    });
    expect((await get(me.token, "/Me/wrong-answers")).body).toEqual({ items: [] });
  });

  it("ranks within the school cohort only with 5+ users", async () => {
    const s = await subject("AAA101");
    const me = await user();
    await attempt(me.user.id, s, 5, iso(1));
    const peers = [];
    for (const score of [9, 7, 3]) {
      const p = await user();
      peers.push(p);
      await attempt(p.user.id, s, score, iso(1));
    }
    const foreign = await user("hcmus");
    await attempt(foreign.user.id, s, 10, iso(1));
    // 4 cohort users (foreign excluded) -> null
    expect((await get(me.token, "/Me/dashboard")).body.stats.rankPercentile).toBeNull();
    const fifth = await user();
    await attempt(fifth.user.id, s, 1, iso(1));
    // means: 9,7,5,3,1 -> me rank 3 of 5 -> 60
    expect((await get(me.token, "/Me/dashboard")).body.stats.rankPercentile).toBe(60);
    expect((await get(peers[0]!.token, "/Me/dashboard")).body.stats.rankPercentile).toBe(20);
    // a cohort user without attempts is not counted
    await user();
    expect((await get(me.token, "/Me/dashboard")).body.stats.rankPercentile).toBe(60);
  });

  it("lists wrong answers by latest answer per question", async () => {
    const me = await user(),
      other = await user(),
      s = await subject("AAA101");
    const q = async (prompt: string) =>
      repo.insert("questions", {
        subject_id: s,
        prompt,
        explanation: "exp " + prompt,
        difficulty: "basic",
        status: "approved",
        created_at: iso(0),
        question_options: [0, 1, 2, 3].map((position) => ({
          id: randomUUID(),
          position,
          content: `${prompt}-opt${position}`,
          is_correct: position === 0,
        })),
      });
    const [wrongThenRight, rightThenWrong, blank, gone] = [
      await q("wtr"),
      await q("rtw"),
      await q("blank"),
      await q("gone"),
    ];
    const ans = (id: string, sel: number | null) => ({
      question_id: id,
      selected_position: sel,
      correct_position: 0,
      is_correct: sel === 0,
      points: 1,
    });
    await attempt(me.user.id, s, 1, iso(3), [
      ans(wrongThenRight, 1),
      ans(rightThenWrong, 0),
      ans(blank, 2),
      ans(gone, 1),
    ]);
    await attempt(me.user.id, s, 1, iso(2), [
      ans(wrongThenRight, 0),
      ans(rightThenWrong, 3),
      ans(blank, null),
    ]);
    await attempt(me.user.id, s, 1, iso(1), [ans(rightThenWrong, 2)]);
    await attempt(other.user.id, s, 1, iso(0), [ans(wrongThenRight, 1)]);
    await built.db.updateMany("questions", { id: gone }, { $set: { status: "approved" } });
    await (built.db as any).client
      .db((built.db as any).databaseName)
      .collection("questions")
      .deleteOne({ _id: gone });
    const r = await get(me.token, "/Me/wrong-answers");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0]).toEqual({
      questionId: rightThenWrong,
      subjectId: s,
      subjectCode: "AAA101",
      subjectName: "Name AAA101",
      prompt: "rtw",
      yourAnswer: "rtw-opt2",
      correctAnswer: "rtw-opt0",
      explanation: "exp rtw",
      submittedAt: expect.any(String),
    });
    expect(r.body.items[1]).toMatchObject({
      questionId: blank,
      yourAnswer: null,
      correctAnswer: "blank-opt0",
    });
    expect((await get(me.token, "/Me/wrong-answers?limit=1")).body.items).toHaveLength(1);
    for (const l of ["0", "51"])
      expect((await get(me.token, "/Me/wrong-answers?limit=" + l)).status).toBe(400);
  });
});
