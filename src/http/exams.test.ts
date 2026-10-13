import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ContentRepository } from "../db/content.js";

const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-exams-secret-at-least-thirty-two-characters",
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
async function user(role: "student" | "admin" = "student") {
  const u = await built.db.createUser({
    id: randomUUID(),
    email: randomUUID() + "@example.com",
    fullName: "User",
    passwordHash: null,
    mssv: "",
    schoolId: "fptu",
    role,
    status: "active",
    googleSubject: null,
    emailVerifiedAt: new Date().toISOString(),
  });
  return { user: u, ...(await built.tokens.issue(u)) };
}
const at = new Date().toISOString();
async function makeSubject() {
  return repo.insert("subjects", {
    school_code: "fptu",
    code: "PRF192",
    display_code: "PRF192",
    name: "Prog",
    description: null,
    created_by: null,
    created_at: at,
  });
}
async function makeQuestion(
  subjectId: string,
  status = "approved",
  correct = 1,
) {
  return repo.insert("questions", {
    subject_id: subjectId,
    prompt: "Q " + randomUUID(),
    explanation: "because",
    difficulty: "basic",
    status,
    created_at: at,
    question_options: [3, 2, 1, 0].map((position) => ({
      id: randomUUID(),
      position,
      content: "opt" + position,
      is_correct: position === correct,
    })),
    question_sources: [{ id: randomUUID(), chunk_id: "c", excerpt: "secret" }],
  });
}
async function makeExam(
  subjectId: string,
  qs: Array<[string, number]>,
  status = "published",
  extra: Record<string, unknown> = {},
) {
  const id = randomUUID();
  await repo.insert("exams", {
    id,
    subject_id: subjectId,
    title: "Exam",
    duration_minutes: 30,
    status,
    published_at: status === "published" ? at : null,
    created_at: at,
    exam_questions: qs.map(([question_id, points], i) => ({
      exam_id: id,
      question_id,
      position: i + 1,
      points,
    })),
    ...extra,
  });
  return id;
}
const get = (t: string, p: string) =>
  request(built.app).get("/api/v1" + p).auth(t, { type: "bearer" });
const post = (t: string, p: string, body: unknown) =>
  request(built.app).post("/api/v1" + p).auth(t, { type: "bearer" }).send(body);

describe("student exams", () => {
  it("requires auth", async () => {
    const id = randomUUID();
    for (const r of [
      request(built.app).get(`/api/v1/Exams/${id}`),
      request(built.app).get(`/api/v1/Subjects/${id}/exams`),
      request(built.app).get(`/api/v1/Attempts/${id}`),
      request(built.app).post(`/api/v1/Exams/${id}/attempts`).send({}),
    ])
      expect((await r).status).toBe(401);
  });

  it("serves an exam without answer data and skips unapproved questions", async () => {
    const { token } = await user(),
      s = await makeSubject(),
      q1 = await makeQuestion(s),
      q2 = await makeQuestion(s, "rejected"),
      q3 = await makeQuestion(s),
      e = await makeExam(s, [
        [q1, 1],
        [q2, 1],
        [q3, 1],
      ]);
    const r = await get(token, `/Exams/${e}`);
    expect(r.status).toBe(200);
    expect(r.body.exam.questionCount).toBe(2);
    expect(r.body.exam.questions.map((q: any) => q.id)).toEqual([q1, q3]);
    expect(r.body.exam.questions[0].options.map((o: any) => o.position)).toEqual(
      [0, 1, 2, 3],
    );
    expect(r.body.exam.subject).toEqual({
      id: s,
      schoolCode: "fptu",
      code: "PRF192",
      name: "Prog",
    });
    const json = JSON.stringify(r.body);
    for (const key of [
      "is_correct",
      "isCorrect",
      "explanation",
      "question_sources",
      "status",
      "difficulty",
      "because",
      "secret",
    ])
      expect(json).not.toContain(key);
  });

  it("404 for drafts and unknown exams, 409 for empty exams", async () => {
    const { token } = await user(),
      s = await makeSubject(),
      q = await makeQuestion(s),
      draft = await makeExam(s, [[q, 1]], "draft"),
      rejected = await makeQuestion(s, "rejected"),
      empty = await makeExam(s, [[rejected, 1]]);
    expect((await get(token, `/Exams/${draft}`)).status).toBe(404);
    expect(
      (await post(token, `/Exams/${draft}/attempts`, { answers: [], spentSec: 1 }))
        .status,
    ).toBe(404);
    expect((await get(token, `/Exams/${randomUUID()}`)).status).toBe(404);
    const r = await get(token, `/Exams/${empty}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("EXAM_EMPTY");
    expect(
      (await post(token, `/Exams/${empty}/attempts`, { answers: [], spentSec: 1 }))
        .status,
    ).toBe(409);
  });

  it("grades with mixed points and blanks, excludes rejected questions", async () => {
    const { token } = await user(),
      s = await makeSubject(),
      a = await makeQuestion(s, "approved", 1),
      b = await makeQuestion(s, "approved", 2),
      c = await makeQuestion(s, "approved", 3),
      x = await makeQuestion(s, "rejected", 0),
      e = await makeExam(s, [
        [a, 1],
        [x, 5],
        [b, 2],
        [c, 3],
      ]);
    const r = await post(token, `/Exams/${e}/attempts`, {
      answers: [
        { questionId: a, selectedPosition: 1 },
        { questionId: b, selectedPosition: 0 },
      ],
      spentSec: 999999 > 86400 ? 86400 : 0,
    });
    expect(r.status).toBe(201);
    // correct: a (1 of 6 points); b wrong, c blank
    expect(r.body).toMatchObject({ score: 1.7, correctCount: 1, totalCount: 3 });
    const row = await built.db.findOne("attempts", { id: r.body.attemptId });
    expect(row).toMatchObject({
      school_code: "fptu",
      subject_id: s,
      spent_sec: 30 * 60 + 60,
    });
    expect(row!.answers).toEqual([
      { question_id: a, selected_position: 1, correct_position: 1, is_correct: true, points: 1 },
      { question_id: b, selected_position: 0, correct_position: 2, is_correct: false, points: 2 },
      { question_id: c, selected_position: null, correct_position: 3, is_correct: false, points: 3 },
    ]);
  });

  it("rejects duplicate, unknown, rejected and malformed answers", async () => {
    const { token } = await user(),
      s = await makeSubject(),
      a = await makeQuestion(s),
      x = await makeQuestion(s, "rejected"),
      e = await makeExam(s, [
        [a, 1],
        [x, 1],
      ]);
    const send = (answers: unknown[]) =>
      post(token, `/Exams/${e}/attempts`, { answers, spentSec: 5 });
    expect(
      (await send([
        { questionId: a, selectedPosition: 0 },
        { questionId: a, selectedPosition: 1 },
      ])).status,
    ).toBe(400);
    expect((await send([{ questionId: randomUUID(), selectedPosition: 0 }])).status).toBe(400);
    expect((await send([{ questionId: x, selectedPosition: 0 }])).status).toBe(400);
    expect((await send([{ questionId: a, selectedPosition: 4 }])).status).toBe(400);
    expect(await built.db.count("attempts")).toBe(0);
  });

  it("owner-only attempts with a stable snapshot", async () => {
    const me = await user(),
      other = await user(),
      admin = await user("admin"),
      s = await makeSubject(),
      a = await makeQuestion(s, "approved", 1),
      e = await makeExam(s, [[a, 1]]);
    const r = await post(me.token, `/Exams/${e}/attempts`, {
      answers: [{ questionId: a, selectedPosition: 1 }],
      spentSec: 10,
    });
    const path = `/Attempts/${r.body.attemptId}`;
    expect((await get(other.token, path)).status).toBe(404);
    expect((await get(admin.token, path)).status).toBe(404);
    // admin flips the correct option afterwards
    await built.db.update(
      "questions",
      { id: a },
      {
        $set: {
          explanation: "new explanation",
          question_options: [0, 1, 2, 3].map((position) => ({
            id: randomUUID(),
            position,
            content: "opt" + position,
            is_correct: position === 3,
          })),
        },
      },
    );
    const v = await get(me.token, path);
    expect(v.status).toBe(200);
    expect(v.body.attempt).toMatchObject({
      id: r.body.attemptId,
      score: 10,
      correctCount: 1,
      totalCount: 1,
      spentSec: 10,
      exam: { id: e, title: "Exam", durationMinutes: 30 },
      subject: { id: s, code: "PRF192" },
    });
    expect(v.body.attempt.questions[0]).toMatchObject({
      id: a,
      selectedPosition: 1,
      correctPosition: 1,
      isCorrect: true,
      explanation: "new explanation",
    });
  });

  it("lists published exams with per-user lastScore", async () => {
    const me = await user(),
      other = await user(),
      s = await makeSubject(),
      a = await makeQuestion(s, "approved", 1),
      pub1 = await makeExam(s, [[a, 1]], "published", {
        published_at: "2026-01-01T00:00:00.000Z",
      }),
      pub2 = await makeExam(s, [[a, 1]], "published", {
        published_at: "2026-02-01T00:00:00.000Z",
      });
    await makeExam(s, [[a, 1]], "draft");
    const attempt = (u: string, score: number, when: string) =>
      repo.insert("attempts", {
        user_id: u,
        exam_id: pub1,
        subject_id: s,
        school_code: "fptu",
        answers: [],
        score,
        submitted_at: when,
      });
    await attempt(me.user.id, 3, "2026-01-01T00:00:00.000Z");
    await attempt(me.user.id, 6, "2026-02-01T00:00:00.000Z");
    await attempt(other.user.id, 9, "2026-03-01T00:00:00.000Z");
    const r = await get(me.token, `/Subjects/${s}/exams`);
    expect(r.status).toBe(200);
    expect(r.body.exams.map((x: any) => x.id)).toEqual([pub2, pub1]);
    expect(r.body.exams[0]).toMatchObject({
      title: "Exam",
      durationMinutes: 30,
      questionCount: 1,
      lastScore: null,
    });
    expect(r.body.exams[1].lastScore).toBe(6);
    expect((await get(me.token, `/Subjects/${randomUUID()}/exams`)).status).toBe(404);
  });
});

describe("attempt rate limit", () => {
  it("is keyed per user", async () => {
    const a = await user(),
      b = await user(),
      s = await makeSubject(),
      q = await makeQuestion(s),
      e = await makeExam(s, [[q, 1]]);
    const send = (t: string) =>
      post(t, `/Exams/${e}/attempts`, { answers: [], spentSec: 1 });
    for (let i = 0; i < 30; i++) expect((await send(a.token)).status).toBe(201);
    expect((await send(a.token)).status).toBe(429);
    expect((await send(b.token)).status).toBe(201);
  }, 60000);
});
