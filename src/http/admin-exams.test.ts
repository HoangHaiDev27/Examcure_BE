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
