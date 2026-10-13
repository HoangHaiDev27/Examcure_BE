import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ContentRepository } from "../db/content.js";
import { waitForExamGenerations } from "../services/exam-generation.service.js";

const external = vi.hoisted(() => ({
  chunks: [] as any[],
  generate: vi.fn(),
}));
vi.mock("../integrations/mongodb.js", () => ({
  getVectorCollection: async () => ({}),
  closeMongoClient: async () => {},
}));
vi.mock("../integrations/openai.js", () => ({
  createEmbeddings: async (inputs: string[]) => inputs.map(() => []),
  generateQuestions: (...args: unknown[]) => external.generate(...args),
}));
vi.mock("../integrations/vector-search.js", () => ({
  retrieveMaterialChunks: async () => external.chunks,
}));

const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-admin-secret-at-least-thirty-two-characters",
});
let built: ReturnType<typeof createApp>, repo: ContentRepository;
let counter = 0;

const makeQuestions = (count: number, withSources: boolean) =>
  Array.from({ length: count }, () => ({
    prompt: `Câu hỏi số ${++counter}`,
    explanation: "Giải thích ngắn",
    difficulty: "basic",
    options: ["A", "B", "C", "D"],
    correct_index: 1,
    source_chunk_ids: withSources ? ["c1"] : [],
  }));

beforeEach(() => {
  counter = 0;
  external.chunks = [];
  external.generate.mockReset();
  external.generate.mockImplementation(async (input: any) =>
    makeQuestions(input.count, Boolean(input.chunks)),
  );
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
          throw new Error("File missing");
        },
        async size() {
          return null;
        },
      },
    },
  );
  repo = new ContentRepository(built.db);
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_EMBEDDING_MODEL", "test-embedding");
  vi.stubEnv("OPENAI_QUESTION_MODEL", "test-question");
});
afterEach(async () => {
  await waitForExamGenerations();
  await built.db.close();
  vi.unstubAllEnvs();
});

async function identity(role: "student" | "admin" = "admin") {
  const user = await built.db.createUser({
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
  return { user, ...(await built.tokens.issue(user)) };
}
async function makeSubject(extra: Record<string, unknown> = {}) {
  return repo.insert("subjects", {
    school_code: "fptu",
    code: "PRF" + randomUUID().slice(0, 4).toUpperCase(),
    name: "Kỹ thuật lập trình C",
    description: null,
    created_at: new Date().toISOString(),
    ...extra,
  });
}
async function makeVersion(subjectId: string, status = "ready") {
  const materialId = await repo.insert("materials", {
    subject_id: subjectId,
    title: "Bài giảng",
    description: null,
    created_at: new Date().toISOString(),
  });
  return repo.insert("material_versions", {
    material_id: materialId,
    version_number: 1,
    status,
    original_path: `originals/${randomUUID()}`,
    created_at: new Date().toISOString(),
  });
}
function setChunks(versionId: string, n = 3) {
  external.chunks = Array.from({ length: n }, (_, i) => ({
    chunk_id: i === 0 ? "c1" : `c${i + 1}`,
    content: "Nội dung slide",
    material_version_id: versionId,
    slide_number: i + 1,
    score: 0.9,
  }));
}
const generate = (token: string, body: Record<string, unknown>) =>
  request(built.app)
    .post("/api/v1/Admin/exams/generate")
    .auth(token, { type: "bearer" })
    .send({
      title: "Đề thử",
      durationMinutes: 30,
      questionCount: 3,
      difficulty: "basic",
      ...body,
    });
const get = (token: string, path: string) =>
  request(built.app).get(`/api/v1/Admin${path}`).auth(token, { type: "bearer" });

describe("POST /Admin/exams/generate", () => {
  it("generates a draft exam from materials", async () => {
    const admin = await identity(),
      subjectId = await makeSubject(),
      versionId = await makeVersion(subjectId);
    setChunks(versionId);
    const res = await generate(admin.token, {
      subjectId,
      materialVersionIds: [versionId, versionId],
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "generating", source: "materials" });
    await waitForExamGenerations();
    const exam = (await built.db.findOne("exams", { id: res.body.examId }))!;
    expect(exam.status).toBe("draft");
    expect(exam.source_version_ids).toEqual([versionId]);
    expect(exam.exam_questions.map((l: any) => l.position)).toEqual([1, 2, 3]);
    const questions = await built.db.find("questions", { exam_id: exam.id });
    expect(questions).toHaveLength(3);
    for (const q of questions) {
      expect(q.question_sources.length).toBeGreaterThan(0);
      expect(q.status).toBe("draft");
    }
    const run = (await built.db.findOne("generation_runs", { exam_id: exam.id }))!;
    expect(run.status).toBe("completed");
    const overview = await get(admin.token, "/overview");
    expect(overview.status).toBe(200);
    expect(overview.body.questions).toBeUndefined();
    expect(overview.body.exams[0]).toMatchObject({
      id: exam.id,
      status: "draft",
      source: "materials",
      question_count: 3,
      checked_count: 0,
      requested_count: 3,
    });
  });

  it("generates self-authored questions when the subject has no ready material", async () => {
    const admin = await identity(),
      subjectId = await makeSubject({ faculty: "CNTT", description: "Nhập môn C" });
    await makeVersion(subjectId, "uploaded");
    const res = await generate(admin.token, { subjectId });
    expect(res.status).toBe(202);
    expect(res.body.source).toBe("ai");
    await waitForExamGenerations();
    const input = external.generate.mock.calls[0]![0];
    expect(input.chunks).toBeUndefined();
    expect(input.subjectContext).toBe("Khoa: CNTT\nMô tả: Nhập môn C");
    const exam = (await built.db.findOne("exams", { id: res.body.examId }))!;
    expect(exam.status).toBe("draft");
    const questions = await built.db.find("questions", { exam_id: exam.id });
    expect(questions).toHaveLength(3);
    for (const q of questions) expect(q.question_sources).toEqual([]);
  });

  it("splits 25 questions into batches and avoids earlier prompts", async () => {
    const admin = await identity(),
      subjectId = await makeSubject();
    const res = await generate(admin.token, { subjectId, questionCount: 25 });
    expect(res.status).toBe(202);
    await waitForExamGenerations();
    const calls = external.generate.mock.calls.map((c) => c[0]);
    expect(calls.map((c: any) => c.count)).toEqual([10, 10, 5]);
    expect(calls[0].avoidPrompts).toEqual([]);
    expect(calls[1].avoidPrompts).toHaveLength(10);
    expect(calls[1].avoidPrompts[0]).toBe("Câu hỏi số 1");
    expect(calls[2].avoidPrompts).toHaveLength(20);
    const exam = (await built.db.findOne("exams", { id: res.body.examId }))!;
    expect(exam.exam_questions).toHaveLength(25);
  });

  it("validates sources and input", async () => {
    const admin = await identity(),
      withMaterial = await makeSubject(),
      versionId = await makeVersion(withMaterial),
      other = await makeSubject(),
      otherVersion = await makeVersion(other),
      pending = await makeSubject(),
      pendingVersion = await makeVersion(pending, "processing");
    const code = async (body: Record<string, unknown>) => {
      const r = await generate(admin.token, body);
      return [r.status, r.body.code];
    };
    expect(await code({ subjectId: withMaterial })).toEqual([400, "SOURCE_REQUIRED"]);
    expect(
      await code({ subjectId: withMaterial, materialVersionIds: [otherVersion] }),
    ).toEqual([400, "INVALID_MATERIAL"]);
    expect(
      await code({ subjectId: withMaterial, materialVersionIds: [randomUUID()] }),
    ).toEqual([400, "INVALID_MATERIAL"]);
    expect(
      await code({ subjectId: pending, materialVersionIds: [pendingVersion] }),
    ).toEqual([400, "INVALID_MATERIAL"]);
    expect((await code({ subjectId: withMaterial, materialVersionIds: [versionId], questionCount: 0 }))[0]).toBe(400);
    expect((await code({ subjectId: withMaterial, materialVersionIds: [versionId], questionCount: 51 }))[0]).toBe(400);
    expect(await code({ subjectId: randomUUID() })).toEqual([404, "NOT_FOUND"]);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await code({ subjectId: withMaterial, materialVersionIds: [versionId] })).toEqual([
      503,
      "AI_UNAVAILABLE",
    ]);
    expect(await built.db.count("exams")).toBe(0);
  });

  it("marks the exam failed when OpenAI throws", async () => {
    const admin = await identity(),
      subjectId = await makeSubject();
    external.generate.mockRejectedValue(new Error("boom from openai"));
    const res = await generate(admin.token, { subjectId });
    await waitForExamGenerations();
    const exam = (await built.db.findOne("exams", { id: res.body.examId }))!;
    expect(exam.status).toBe("failed");
    expect(exam.error_message).toBe("AI chưa soạn được đề. Thử lại sau ít phút.");
    const run = (await built.db.findOne("generation_runs", { exam_id: exam.id }))!;
    expect(run.status).toBe("failed");
    expect(run.error_message).toBe("boom from openai");
    expect(run.completed_at).toBeTruthy();
  });

  it("fails with a context message when too few chunks are retrieved", async () => {
    const admin = await identity(),
      subjectId = await makeSubject(),
      versionId = await makeVersion(subjectId);
    setChunks(versionId, 1);
    const res = await generate(admin.token, { subjectId, materialVersionIds: [versionId] });
    await waitForExamGenerations();
    const exam = (await built.db.findOne("exams", { id: res.body.examId }))!;
    expect(exam.status).toBe("failed");
    expect(exam.error_message).toBe("Tài liệu đã chọn có quá ít nội dung để AI soạn đề.");
    expect(external.generate).not.toHaveBeenCalled();
  });
});

describe("exam overview and detail", () => {
  it("expires stale generating exams", async () => {
    const admin = await identity(),
      subjectId = await makeSubject();
    const old = await repo.insert("exams", {
      subject_id: subjectId,
      title: "Cũ",
      duration_minutes: 30,
      status: "generating",
      created_at: new Date(Date.now() - 16 * 60000).toISOString(),
    });
    const fresh = await repo.insert("exams", {
      subject_id: subjectId,
      title: "Mới",
      duration_minutes: 30,
      status: "generating",
      created_at: new Date().toISOString(),
    });
    const res = await get(admin.token, "/overview");
    const byId = new Map(res.body.exams.map((e: any) => [e.id, e]));
    expect((byId.get(old) as any).status).toBe("failed");
    expect((byId.get(old) as any).error_message).toContain("Quá thời gian");
    expect((byId.get(fresh) as any).status).toBe("generating");
  });

  it("returns ordered detail without rejected questions", async () => {
    const admin = await identity(),
      subjectId = await makeSubject(),
      versionId = await makeVersion(subjectId);
    const q = async (prompt: string, status: string) =>
      repo.insert("questions", {
        subject_id: subjectId,
        prompt,
        explanation: "gt",
        difficulty: "basic",
        status,
        question_options: [3, 1, 0, 2].map((position) => ({
          position,
          content: `opt${position}`,
          is_correct: position === 0,
        })),
        question_sources: [
          { material_version_id: versionId, slide_number: 2, excerpt: "trích" },
        ],
      });
    const q1 = await q("Một", "approved"),
      q2 = await q("Hai", "rejected"),
      q3 = await q("Ba", "draft");
    const examId = await repo.insert("exams", {
      subject_id: subjectId,
      title: "Đề",
      duration_minutes: 20,
      status: "draft",
      source: "materials",
      difficulty: "basic",
      requested_count: 3,
      source_version_ids: [versionId, randomUUID()],
      extra_instructions: "tập trung",
      created_at: new Date().toISOString(),
      exam_questions: [q3, q2, q1].map((question_id, i) => ({
        question_id,
        position: i + 1,
        points: 1,
      })),
    });
    const res = await get(admin.token, `/exams/${examId}`);
    expect(res.status).toBe(200);
    expect(res.body.questions.map((x: any) => x.prompt)).toEqual(["Ba", "Một"]);
    expect(res.body.questions[0].options.map((o: any) => o.position)).toEqual([0, 1, 2, 3]);
    expect(res.body.questions[1].sources[0]).toMatchObject({ slide_number: 2, excerpt: "trích" });
    expect(res.body.exam).toMatchObject({
      question_count: 2,
      checked_count: 1,
      extra_instructions: "tập trung",
    });
    expect(res.body.exam.source_versions).toEqual([
      expect.objectContaining({ id: versionId, title: "Bài giảng", version_number: 1 }),
    ]);
    expect((await get(admin.token, `/exams/${randomUUID()}`)).status).toBe(404);
    expect((await get(admin.token, "/exams/not-a-uuid")).status).toBe(400);
  });

  it("rejects students on the new endpoints", async () => {
    const student = await identity("student");
    expect((await generate(student.token, { subjectId: randomUUID() })).status).toBe(403);
    expect((await get(student.token, `/exams/${randomUUID()}`)).status).toBe(403);
  });
});

describe("publish, delete and locking", () => {
  const send = (method: "post" | "patch" | "delete", token: string, path: string, body?: object) =>
    request(built.app)
      [method](`/api/v1${path}`)
      .auth(token, { type: "bearer" })
      .send(body ?? {});
  async function seedExam(statuses: string[], examStatus = "draft") {
    const subjectId = await makeSubject();
    const ids: string[] = [];
    for (const [i, status] of statuses.entries())
      ids.push(
        await repo.insert("questions", {
          subject_id: subjectId,
          prompt: `Q${i + 1}`,
          explanation: "gt",
          difficulty: "basic",
          status,
          question_options: [0, 1, 2, 3].map((position) => ({
            position,
            content: `o${position}`,
            is_correct: position === 0,
          })),
        }),
      );
    const examId = await repo.insert("exams", {
      subject_id: subjectId,
      title: "Đề",
      duration_minutes: 20,
      status: examStatus,
      created_at: new Date().toISOString(),
      exam_questions: ids.map((question_id, i) => ({ question_id, position: i + 1, points: 1 })),
    });
    for (const id of ids) await built.db.update("questions", { id }, { $set: { exam_id: examId } });
    return { subjectId, ids, examId };
  }

  it("publishes, auto-approves, prunes rejected links and serves students", async () => {
    const admin = await identity(),
      student = await identity("student"),
      { ids, examId } = await seedExam(["approved", "rejected", "draft"]);
    const res = await send("post", admin.token, `/Admin/exams/${examId}/publish`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ examId, status: "published", questionCount: 2, autoApprovedCount: 1 });
    const exam = (await built.db.findOne("exams", { id: examId }))!;
    expect(exam.published_at).toBeTruthy();
    expect(exam.exam_questions.map((l: any) => [l.question_id, l.position])).toEqual([
      [ids[0], 1],
      [ids[2], 2],
    ]);
    const played = await request(built.app)
      .get(`/api/v1/Exams/${examId}`)
      .auth(student.token, { type: "bearer" });
    expect(played.status).toBe(200);
    expect(played.body.exam.questions.map((q: any) => q.prompt)).toEqual(["Q1", "Q3"]);
    expect((await send("post", admin.token, `/Admin/exams/${examId}/publish`)).body.code).toBe("EXAM_NOT_DRAFT");
  });

  it("refuses to publish empty or non-draft exams", async () => {
    const admin = await identity();
    const empty = await seedExam(["rejected", "rejected"]);
    expect((await send("post", admin.token, `/Admin/exams/${empty.examId}/publish`)).body.code).toBe("EXAM_EMPTY");
    for (const status of ["generating", "failed"]) {
      const e = await seedExam(["draft"], status);
      const r = await send("post", admin.token, `/Admin/exams/${e.examId}/publish`);
      expect([r.status, r.body.code]).toEqual([409, "EXAM_NOT_DRAFT"]);
    }
    expect((await send("post", admin.token, `/Admin/exams/${randomUUID()}/publish`)).status).toBe(404);
  });

  it("locks questions of published exams but not drafts", async () => {
    const admin = await identity();
    const pub = await seedExam(["approved"], "published"),
      draft = await seedExam(["draft"]);
    const locked = await send("patch", admin.token, `/Admin/questions/${pub.ids[0]}`, { status: "draft" });
    expect([locked.status, locked.body.code]).toEqual([409, "EXAM_PUBLISHED"]);
    expect((await send("patch", admin.token, `/Admin/questions/${draft.ids[0]}`, { status: "approved" })).status).toBe(200);
  });

  it("keeps a rejected question locked after its exam is published", async () => {
    const admin = await identity(),
      { ids, examId } = await seedExam(["draft", "draft"]);
    const patch = (status: string) => send("patch", admin.token, `/Admin/questions/${ids[1]}`, { status });
    expect((await patch("rejected")).status).toBe(200);
    expect((await send("post", admin.token, `/Admin/exams/${examId}/publish`)).status).toBe(200);
    const undo = await patch("draft");
    expect([undo.status, undo.body.code]).toEqual([409, "EXAM_PUBLISHED"]);
    const detail = await get(admin.token, `/exams/${examId}`);
    expect(detail.body.questions.map((q: any) => q.id)).toEqual([ids[0]]);
  });

  it("removes and restores a question at its original position", async () => {
    const admin = await identity(),
      { ids, examId } = await seedExam(["draft", "draft", "draft"]);
    const patch = (status: string) => send("patch", admin.token, `/Admin/questions/${ids[1]}`, { status });
    expect((await patch("rejected")).status).toBe(200);
    let detail = await get(admin.token, `/exams/${examId}`);
    expect(detail.body.questions.map((q: any) => q.position)).toEqual([1, 3]);
    expect((await patch("draft")).status).toBe(200);
    detail = await get(admin.token, `/exams/${examId}`);
    expect(detail.body.questions.map((q: any) => [q.position, q.prompt])).toEqual([
      [1, "Q1"],
      [2, "Q2"],
      [3, "Q3"],
    ]);
  });

  it("deletes draft and failed exams with their questions only", async () => {
    const admin = await identity();
    const draft = await seedExam(["draft", "draft"]),
      failed = await seedExam([], "failed"),
      generating = await seedExam(["draft"], "generating"),
      published = await seedExam(["approved"], "published");
    const shared = await seedExam(["draft"]);
    // A question owned by the draft exam but also linked from another exam survives.
    await built.db.update("exams", { id: published.examId }, {
      $push: { exam_questions: { question_id: draft.ids[1], position: 2, points: 1 } },
    } as any);
    expect((await send("delete", admin.token, `/Admin/exams/${draft.examId}`)).status).toBe(204);
    expect(await built.db.findOne("exams", { id: draft.examId })).toBeNull();
    expect(await built.db.findOne("questions", { id: draft.ids[0] })).toBeNull();
    expect(await built.db.findOne("questions", { id: draft.ids[1] })).not.toBeNull();
    expect((await send("delete", admin.token, `/Admin/exams/${failed.examId}`)).status).toBe(204);
    for (const e of [generating, published]) {
      const r = await send("delete", admin.token, `/Admin/exams/${e.examId}`);
      expect([r.status, r.body.code]).toEqual([409, "EXAM_LOCKED"]);
    }
    expect((await send("delete", admin.token, `/Admin/exams/${randomUUID()}`)).status).toBe(404);
    expect(await built.db.findOne("questions", { id: shared.ids[0] })).not.toBeNull();
  });

  it("rejects students and removed routes", async () => {
    const student = await identity("student"),
      admin = await identity();
    expect((await send("post", student.token, `/Admin/exams/${randomUUID()}/publish`)).status).toBe(403);
    expect((await send("delete", student.token, `/Admin/exams/${randomUUID()}`)).status).toBe(403);
    expect((await send("post", admin.token, "/Admin/question-generation", {})).status).toBe(404);
    expect((await send("post", admin.token, "/Admin/exams", {})).status).toBe(404);
  });
});
