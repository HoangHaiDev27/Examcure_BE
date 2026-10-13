import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { waitForExamGenerations } from "../services/exam-generation.service.js";
const external = vi.hoisted(() => ({
  chunks: [] as any[],
  createIndex: vi.fn(),
  updateMany: vi.fn(),
  bulkWrite: vi.fn(),
}));
vi.mock("../integrations/mongodb.js", () => ({
  getVectorCollection: async () => external,
  closeMongoClient: async () => {},
}));
vi.mock("../integrations/openai.js", () => ({
  createEmbeddings: async (inputs: string[]) =>
    inputs.map(() => Array(1536).fill(0)),
  generateQuestions: async () => [
    {
      prompt: "Which structure is FIFO?",
      explanation: "A queue follows first in first out.",
      difficulty: "basic",
      options: ["Queue", "Stack", "Tree", "Graph"],
      correct_index: 0,
      source_chunk_ids: ["source-1"],
    },
  ],
}));
vi.mock("../integrations/vector-search.js", () => ({
  retrieveMaterialChunks: async () => external.chunks,
}));
const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-admin-secret-at-least-thirty-two-characters",
});
let built: ReturnType<typeof createApp>, objects: Map<string, Buffer>;
const secret = "bootstrap-token-at-least-thirty-two-characters";
beforeEach(() => {
  objects = new Map();
  external.chunks = [];
  vi.clearAllMocks();
  built = createApp(
    {
      ...config,
      MONGODB_DATABASE: "examcure_test_" + randomUUID().replaceAll("-", ""),
    },
    {
      otpSender: { async send() {} },
      storage: {
        async put(k, b) {
          objects.set(k, b);
        },
        async get(k) {
          const b = objects.get(k);
          if (!b) throw new Error("File missing");
          return b;
        },
        async size(k) {
          return objects.get(k)?.length ?? null;
        },
      },
    },
  );
  vi.stubEnv("ADMIN_BOOTSTRAP_TOKEN", secret);
  vi.stubEnv("ADMIN_BOOTSTRAP_EXPIRES_AT", "2099-01-01T00:00:00Z");
});
afterEach(async () => {
  await built.db.close();
  vi.unstubAllEnvs();
});
async function identity(role: "student" | "admin" = "student") {
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
const bootstrap = (token: string, body: unknown = { bootstrapToken: secret }) =>
  request(built.app)
    .post("/api/v1/Admin/bootstrap")
    .auth(token, { type: "bearer" })
    .send(body);
async function subject(token: string) {
  const r = await request(built.app)
    .post("/api/v1/Admin/subjects")
    .auth(token, { type: "bearer" })
    .send({ schoolCode: "fptu", code: "CSD201", name: "Data Structures" });
  expect(r.status).toBe(201);
  return r.body.subject.id as string;
}
async function pptx() {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    '<p:sld xmlns:p="p" xmlns:a="a"><a:t>A queue is FIFO. A stack is LIFO.</a:t></p:sld>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}
async function uploaded(token: string, subjectId: string) {
  const file = await pptx(),
    r = await request(built.app)
      .post("/api/v1/Admin/materials")
      .auth(token, { type: "bearer" })
      .send({
        subjectId,
        title: "Lecture",
        fileName: "lecture.pptx",
        mimeType: "application/octet-stream",
        sizeBytes: file.length,
      });
  expect(r.status).toBe(201);
  expect(
    (
      await request(built.app)
        .put("/api/v1" + r.body.uploadPath)
        .auth(token, { type: "bearer" })
        .set("Content-Type", "application/octet-stream")
        .send(file)
    ).status,
  ).toBe(200);
  return { ...r.body, file };
}
describe("database-backed admin access", () => {
  it("requires a live session and does not trust role cookies or setup headers", async () => {
    expect(
      (
        await request(built.app)
          .get("/api/v1/Admin/overview")
          .set("x-admin-bootstrap-token", secret)
      ).status,
    ).toBe(401);
    const student = await identity();
    expect(
      (
        await request(built.app)
          .get("/api/v1/Admin/overview")
          .auth(student.token, { type: "bearer" })
          .set("Cookie", "examcure_role=admin")
      ).status,
    ).toBe(403);
  });
  it("reads promotions and demotions immediately for the same JWT", async () => {
    const user = await identity();
    const call = () =>
      request(built.app)
        .get("/api/v1/Admin/overview")
        .auth(user.token, { type: "bearer" });
    expect((await call()).status).toBe(403);
    await built.db.update(
      "users",
      { id: user.user.id },
      { $set: { role: "admin" } },
    );
    expect((await call()).status).toBe(200);
    await built.db.update(
      "users",
      { id: user.user.id },
      { $set: { role: "student" } },
    );
    expect((await call()).status).toBe(403);
  });
  it.each(["", "not-a-date", "2000-01-01T00:00:00Z", "2099-01-01T00:00:00"])(
    "rejects bootstrap expiry %s",
    async (expiry) => {
      vi.stubEnv("ADMIN_BOOTSTRAP_EXPIRES_AT", expiry);
      const user = await identity();
      expect((await bootstrap(user.token)).body.code).toBe(
        "BOOTSTRAP_DISABLED",
      );
    },
  );
  it("rejects missing/wrong setup secrets", async () => {
    const user = await identity();
    expect(
      (await bootstrap(user.token, { bootstrapToken: "x".repeat(40) })).body
        .code,
    ).toBe("BOOTSTRAP_INVALID");
    expect(
      (await bootstrap(user.token, { bootstrapToken: "short" })).status,
    ).toBe(400);
    vi.stubEnv("ADMIN_BOOTSTRAP_TOKEN", "");
    expect((await bootstrap(user.token)).body.code).toBe("BOOTSTRAP_DISABLED");
  });
  it("grants one signed-in user atomically and keeps bootstrap consumed after later demotion", async () => {
    const a = await identity(),
      b = await identity();
    const responses = await Promise.all([
      bootstrap(a.token, { bootstrapToken: secret, userId: b.user.id }),
      bootstrap(b.token),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await built.db.find("users", { role: "admin" })).length).toBe(1);
    expect(
      (await built.db.find("audit_logs", { action: "admin.bootstrapped" }))
        .length,
    ).toBe(1);
    await built.db.updateMany("users", {}, { $set: { role: "student" } });
    expect((await bootstrap(a.token)).body.code).toBe("BOOTSTRAP_USED");
  });
  it("preserves an existing admin and prevents competing admins from removing each other", async () => {
    const a = await identity("admin"),
      b = await identity("admin"),
      student = await identity();
    expect((await bootstrap(student.token)).status).toBe(409);
    expect(
      (
        await request(built.app)
          .patch(`/api/v1/Admin/users/${a.user.id}/role`)
          .auth(a.token, { type: "bearer" })
          .send({ role: "student" })
      ).body.code,
    ).toBe("SELF_ROLE_CHANGE");
    const results = await Promise.all(
      [
        [a, b],
        [b, a],
      ].map(([actor, target]) =>
        request(built.app)
          .patch(`/api/v1/Admin/users/${target!.user.id}/role`)
          .auth(actor!.token, { type: "bearer" })
          .send({ role: "student" }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect((await built.db.find("users", { role: "admin" })).length).toBe(1);
  });
});
describe("own database and private file storage", () => {
  it("queues worker processing once and returns 202 without indexing inline", async () => {
    const admin = await identity("admin");
    const subjectId = await subject(admin.token);
    const material = await uploaded(admin.token, subjectId);
    const workerApp = createApp(
      { ...config, MATERIAL_PROCESSING_MODE: "worker" },
      {
        db: built.db,
        otpSender: { async send() {} },
        storage: {
          async put(k, b) {
            objects.set(k, b);
          },
          async get(k) {
            return objects.get(k)!;
          },
          async size(k) {
            return objects.get(k)?.length ?? null;
          },
        },
      },
    ).app;
    const path = `/api/v1/Admin/materials/${material.versionId}/complete-upload`;
    expect(
      (
        await request(workerApp)
          .post(path)
          .auth(admin.token, { type: "bearer" })
          .send({})
      ).status,
    ).toBe(202);
    expect(
      (
        await request(workerApp)
          .post(path)
          .auth(admin.token, { type: "bearer" })
          .send({})
      ).status,
    ).toBe(409);
    expect((await built.db.find("processing_jobs")).length).toBe(1);
    expect(external.bulkWrite).not.toHaveBeenCalled();
  });

  it("uploads PPTX, indexes text, generates and reviews questions, then publishes an exam", async () => {
    const admin = await identity("admin"),
      student = await identity(),
      subjectId = await subject(admin.token),
      material = await uploaded(admin.token, subjectId);
    const complete = await request(built.app)
      .post(`/api/v1/Admin/materials/${material.versionId}/complete-upload`)
      .auth(admin.token, { type: "bearer" })
      .send({});
    expect(
      complete.status,
      JSON.stringify(
        await built.db.findOne("material_versions", { id: material.versionId }),
      ),
    ).toBe(200);
    expect(complete.body).toMatchObject({
      status: "ready",
      slideCount: 1,
      chunkCount: 1,
    });
    expect(external.bulkWrite).toHaveBeenCalledTimes(1);
    const list = await request(built.app)
      .get("/api/v1/Materials?schoolCode=fptu&subjectCode=CSD201")
      .auth(student.token, { type: "bearer" });
    expect(list.body.materials[0].version.id).toBe(material.versionId);
    const slides = await request(built.app)
      .get(`/api/v1/Materials/${material.versionId}/slides`)
      .auth(student.token, { type: "bearer" });
    expect(slides.body.slides[0].text_content).toContain("FIFO");
    external.chunks = [1, 2].map((i) => ({
      chunk_id: `source-${i}`,
      content: "A queue follows FIFO.",
      material_version_id: material.versionId,
      slide_number: 1,
      score: 0.9,
    }));
    for (const name of ["OPENAI_API_KEY", "OPENAI_EMBEDDING_MODEL", "OPENAI_QUESTION_MODEL"])
      vi.stubEnv(name, "test");
    const generated = await request(built.app)
      .post("/api/v1/Admin/exams/generate")
      .auth(admin.token, { type: "bearer" })
      .send({
        subjectId,
        title: "Quiz",
        durationMinutes: 30,
        questionCount: 1,
        difficulty: "basic",
        materialVersionIds: [material.versionId],
      });
    expect(generated.status).toBe(202);
    await waitForExamGenerations();
    const question = (await built.db.find("questions"))[0]!;
    expect(
      question.question_options.filter((o: any) => o.is_correct),
    ).toHaveLength(1);
    expect(question.question_sources[0].material_version_id).toBe(
      material.versionId,
    );
    expect(
      (
        await request(built.app)
          .get(`/api/v1/Exams/${generated.body.examId}`)
          .auth(student.token, { type: "bearer" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(built.app)
          .patch(`/api/v1/Admin/questions/${question.id}`)
          .auth(admin.token, { type: "bearer" })
          .send({ status: "approved" })
      ).status,
    ).toBe(200);
    const published = await request(built.app)
      .post(`/api/v1/Admin/exams/${generated.body.examId}/publish`)
      .auth(admin.token, { type: "bearer" })
      .send({});
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      status: "published",
      questionCount: 1,
      autoApprovedCount: 0,
    });
    const played = await request(built.app)
      .get(`/api/v1/Exams/${generated.body.examId}`)
      .auth(student.token, { type: "bearer" });
    expect(played.status).toBe(200);
    expect(played.body.exam.questions).toHaveLength(1);
  });
  it("checks upload size/state, rejects student writes and never exposes uploading files", async () => {
    const admin = await identity("admin"),
      student = await identity(),
      subjectId = await subject(admin.token);
    const prepared = await request(built.app)
      .post("/api/v1/Admin/materials")
      .auth(admin.token, { type: "bearer" })
      .send({
        subjectId,
        title: "Lecture",
        fileName: "lecture.pptx",
        mimeType: "application/octet-stream",
        sizeBytes: 100,
      });
    const path = "/api/v1" + prepared.body.uploadPath;
    expect(
      (
        await request(built.app)
          .put(path)
          .auth(student.token, { type: "bearer" })
          .set("Content-Type", "application/octet-stream")
          .send(Buffer.from("bad"))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(built.app)
          .put(path)
          .auth(admin.token, { type: "bearer" })
          .set("Content-Type", "application/octet-stream")
          .send(Buffer.from("bad"))
      ).body.code,
    ).toBe("INVALID_FILE_SIZE");
    expect(
      (
        await request(built.app)
          .get(`/api/v1/Materials/${prepared.body.versionId}/download`)
          .auth(student.token, { type: "bearer" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(built.app)
          .post(
            `/api/v1/Admin/materials/${prepared.body.versionId}/complete-upload`,
          )
          .auth(admin.token, { type: "bearer" })
          .send({})
      ).status,
    ).toBe(409);
  });
  it("uses a signed original-file scope, checks tampering and revokes links on logout", async () => {
    const admin = await identity("admin"),
      student = await identity(),
      subjectId = await subject(admin.token),
      material = await uploaded(admin.token, subjectId);
    await request(built.app)
      .post(`/api/v1/Admin/materials/${material.versionId}/complete-upload`)
      .auth(admin.token, { type: "bearer" })
      .send({});
    const signed = await request(built.app)
      .get(`/api/v1/Materials/${material.versionId}/download`)
      .auth(student.token, { type: "bearer" });
    expect(signed.status).toBe(200);
    const url = new URL(signed.body.url),
      path = url.pathname + url.search;
    const file = await request(built.app).get(path);
    expect(file.status).toBe(200);
    expect(file.headers["content-disposition"]).toContain("lecture.pptx");
    expect(
      (
        await request(built.app).get(
          path.replace(material.versionId, randomUUID()),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(built.app)
          .get(`/api/v1/Users/me`)
          .auth(url.searchParams.get("token")!, { type: "bearer" })
      ).status,
    ).toBe(401);
    await request(built.app)
      .post("/api/v1/Auth/logout")
      .set("Cookie", `examcure_refresh=${student.refreshToken}`)
      .send({});
    expect((await request(built.app).get(path)).status).toBe(401);
  });
});
