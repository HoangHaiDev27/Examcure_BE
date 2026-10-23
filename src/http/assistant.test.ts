import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

const mocks = vi.hoisted(() => ({ answer: vi.fn(), retrieve: vi.fn() }));
vi.mock("../integrations/openai.js", async (original) => ({
  ...(await original<typeof import("../integrations/openai.js")>()),
  answerStudyQuestion: mocks.answer,
}));
vi.mock("../integrations/vector-search.js", () => ({ retrieveMaterialChunks: mocks.retrieve }));

const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-assistant-secret-at-least-thirty-two-characters",
  ASSISTANT_DAILY_LIMIT: "3",
});
let built: ReturnType<typeof createApp>;
const msg = (content = "Con trỏ là gì?") => [{ role: "user", content }];

beforeEach(() => {
  mocks.answer.mockReset();
  mocks.retrieve.mockReset();
  mocks.answer.mockResolvedValue({ answer: "Câu trả lời.", grounded: false, source_chunk_ids: [] });
  mocks.retrieve.mockResolvedValue([]);
  built = createApp(
    { ...config, MONGODB_DATABASE: "examcure_test_" + randomUUID().replaceAll("-", "") },
    {
      otpSender: { async send() {} },
      storage: { async put() {}, async get() { throw new Error("none"); }, async size() { return null; } },
    },
  );
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_EMBEDDING_MODEL", "test-embedding");
  vi.stubEnv("OPENAI_QUESTION_MODEL", "test-question");
});
afterEach(async () => {
  await built.db.close();
  vi.unstubAllEnvs();
});

async function user() {
  const u = await built.db.createUser({
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
  return (await built.tokens.issue(u)).token;
}
const chat = (token: string, body: unknown) =>
  request(built.app).post("/api/v1/Assistant/chat").auth(token, { type: "bearer" }).send(body as object);
const usage = async (token: string) =>
  (await request(built.app).get("/api/v1/Assistant/usage").auth(token, { type: "bearer" })).body;

async function makeSubject() {
  const id = randomUUID();
  await built.db.insert("subjects", {
    id,
    school_code: "fptu",
    code: "PRF" + id.slice(0, 6).toUpperCase(),
    display_code: "PRF192",
    name: "Prog",
    created_at: new Date().toISOString(),
  });
  return id;
}
async function makeVersion(subjectId: string, status = "ready", filename = "bai1.pptx", title = "Bài 1") {
  const materialId = randomUUID(),
    versionId = randomUUID();
  await built.db.insert("materials", { id: materialId, subject_id: subjectId, title, created_at: new Date().toISOString() });
  await built.db.insert("material_versions", {
    id: versionId,
    material_id: materialId,
    version_number: 1,
    status,
    original_filename: filename,
    original_path: `t/${versionId}`,
    slide_count: 3,
  });
  return versionId;
}
const chunk = (versionId: string, id: string, slide: number, content = "Nội dung chunk") => ({
  chunk_id: id,
  material_id: "m",
  material_version_id: versionId,
  subject_id: "s",
  slide_number: slide,
  content,
  score: 0.9,
});

describe("auth and validation never consume quota", () => {
  it("requires authentication", async () => {
    expect((await request(built.app).post("/api/v1/Assistant/chat").send({ messages: msg() })).status).toBe(401);
    expect((await request(built.app).get("/api/v1/Assistant/usage")).status).toBe(401);
  });
  it("rejects invalid bodies with 400 and keeps quota", async () => {
    const t = await user();
    const bad = [
      { messages: [{ role: "assistant", content: "x" }] },
      { messages: Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" })).concat([{ role: "user", content: "y" }]) },
      { messages: msg("x".repeat(2001)) },
      { messages: [] },
      { messages: msg(), subjectId: "nope" },
    ];
    for (const body of bad) expect((await chat(t, body)).status).toBe(400);
    expect(mocks.answer).not.toHaveBeenCalled();
    expect((await usage(t)).used).toBe(0);
  });
  it("returns 503 when not configured and 404 for unknown subject, without consuming quota", async () => {
    const t = await user();
    vi.stubEnv("OPENAI_API_KEY", "");
    const off = await chat(t, { messages: msg() });
    expect(off.status).toBe(503);
    expect(off.body.code).toBe("AI_UNAVAILABLE");
    expect((await usage(t)).available).toBe(false);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const missing = await chat(t, { messages: msg(), subjectId: randomUUID() });
    expect(missing.status).toBe(404);
    expect((await usage(t))).toMatchObject({ available: true, used: 0, remainingToday: 3, limit: 3 });
  });
});

describe("general mode", () => {
  it("answers without retrieval and decrements the quota", async () => {
    const t = await user();
    const r = await chat(t, { messages: msg() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ answer: "Câu trả lời.", grounded: false, sources: [], subject: null, remainingToday: 2 });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(await usage(t)).toMatchObject({ used: 1, remainingToday: 2 });
  });
});

describe("subject mode", () => {
  it("retrieves only ready versions and keeps only real, deduped sources", async () => {
    const t = await user(),
      s = await makeSubject(),
      ready = await makeVersion(s, "ready", "bai1.docx", "Giáo trình"),
      other = await makeSubject();
    await makeVersion(s, "failed");
    await makeVersion(other, "ready");
    mocks.retrieve.mockResolvedValue([chunk(ready, "c1", 2, "  Con trỏ   lưu địa chỉ  "), chunk(ready, "c2", 2), chunk(ready, "c3", 5)]);
    mocks.answer.mockResolvedValue({ answer: "Trả lời", grounded: true, source_chunk_ids: ["c1", "bogus", "c2", "c3"] });
    const r = await chat(t, { subjectId: s, messages: msg() });
    expect(r.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve.mock.calls[0]![0]).toMatchObject({ subjectId: s, materialVersionIds: [ready], limit: 8, query: "Con trỏ là gì?" });
    expect(r.body.grounded).toBe(true);
    expect(r.body.subject).toEqual({ id: s, schoolCode: "fptu", code: "PRF192", name: "Prog" });
    expect(r.body.sources).toEqual([
      { versionId: ready, materialTitle: "Giáo trình", originalFilename: "bai1.docx", slideNumber: 2, excerpt: "Con trỏ lưu địa chỉ" },
      { versionId: ready, materialTitle: "Giáo trình", originalFilename: "bai1.docx", slideNumber: 5, excerpt: "Nội dung chunk" },
    ]);
    const given = mocks.answer.mock.calls[0]![0];
    expect(given.chunks[0]).toMatchObject({ chunkId: "c1", unit: "phần", documentTitle: "Giáo trình" });
  });
  it("returns no sources when the model says not grounded or cites nothing real", async () => {
    const t = await user(),
      s = await makeSubject(),
      v = await makeVersion(s);
    mocks.retrieve.mockResolvedValue([chunk(v, "c1", 1)]);
    mocks.answer.mockResolvedValue({ answer: "Kiến thức chung", grounded: false, source_chunk_ids: ["c1"] });
    expect((await chat(t, { subjectId: s, messages: msg() })).body).toMatchObject({ grounded: false, sources: [] });
    mocks.answer.mockResolvedValue({ answer: "A", grounded: true, source_chunk_ids: ["bogus"] });
    expect((await chat(t, { subjectId: s, messages: msg() })).body).toMatchObject({ grounded: false, sources: [] });
  });
  it("skips retrieval when the subject has no ready material", async () => {
    const t = await user(),
      s = await makeSubject();
    const r = await chat(t, { subjectId: s, messages: msg() });
    expect(r.status).toBe(200);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(r.body.grounded).toBe(false);
    expect(r.body.subject).not.toBeNull();
  });
});

describe("failures and limits", () => {
  it("refunds the quota and hides upstream details on failure", async () => {
    const t = await user();
    mocks.answer.mockRejectedValueOnce(new Error("OpenAI API 500: secret upstream text"));
    const r = await chat(t, { messages: msg("tin nhắn bí mật") });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("ASSISTANT_UPSTREAM_FAILED");
    expect(JSON.stringify(r.body)).not.toContain("secret upstream");
    expect((await usage(t)).used).toBe(0);
    const s = await makeSubject();
    await makeVersion(s);
    mocks.retrieve.mockRejectedValueOnce(new Error("vector down"));
    expect((await chat(t, { subjectId: s, messages: msg() })).status).toBe(502);
    expect((await usage(t)).used).toBe(0);
  });
  it("returns 429 when the daily quota is used up, without calling OpenAI", async () => {
    const t = await user();
    for (let i = 0; i < 3; i++) expect((await chat(t, { messages: msg() })).status).toBe(200);
    mocks.answer.mockClear();
    const r = await chat(t, { messages: msg() });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("ASSISTANT_QUOTA_EXCEEDED");
    expect(r.body.message).toContain("3 câu hỏi");
    expect(r.body.details).toEqual({ remainingToday: 0 });
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(await usage(t)).toMatchObject({ used: 3, remainingToday: 0 });
  });
  it("rate limits to 6 requests per minute per user", async () => {
    const t = await user();
    // 400s are cheap and do not touch quota but still count toward the rate limit.
    for (let i = 0; i < 6; i++) expect((await chat(t, { messages: [] })).status).toBe(400);
    expect((await chat(t, { messages: [] })).status).toBe(429);
    expect((await chat(await user(), { messages: [] })).status).toBe(400);
  });
});
