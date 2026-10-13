import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

vi.mock("../integrations/mongodb.js", () => ({
  getVectorCollection: async () => ({}),
  closeMongoClient: async () => {},
}));

const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-feedback-secret-at-least-thirty-two-characters",
});
let built: ReturnType<typeof createApp>;

beforeEach(() => {
  built = createApp(
    { ...config, MONGODB_DATABASE: "examcure_test_" + randomUUID().replaceAll("-", "") },
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
});
afterEach(async () => {
  await built.db.close();
});

async function identity(role: "student" | "admin" = "student", fullName = "User") {
  const user = await built.db.createUser({
    id: randomUUID(),
    email: randomUUID() + "@example.com",
    fullName,
    passwordHash: null,
    mssv: "SE123",
    schoolId: "fptu",
    role,
    status: "active",
    googleSubject: null,
    emailVerifiedAt: new Date().toISOString(),
  });
  return { user, ...(await built.tokens.issue(user)) };
}
const send = (token: string | null, body: unknown) => {
  const r = request(built.app).post("/api/v1/Feedback");
  return (token ? r.auth(token, { type: "bearer" }) : r).send(body as object);
};
const adminGet = (token: string, path: string) =>
  request(built.app).get(`/api/v1/Admin${path}`).auth(token, { type: "bearer" });
const adminPatch = (token: string, path: string, body: object) =>
  request(built.app).patch(`/api/v1/Admin${path}`).auth(token, { type: "bearer" }).send(body);
const valid = { category: "bug", message: "Nút nộp bài không bấm được", page: "/exam/fptu/csd201" };

describe("POST /Feedback", () => {
  it("stores feedback for the signed-in user", async () => {
    const student = await identity();
    const res = await send(student.token, valid);
    expect(res.status).toBe(201);
    const row = (await built.db.findOne("feedback", { id: res.body.id }))!;
    expect(row).toMatchObject({ user_id: student.user.id, status: "new", category: "bug", page: "/exam/fptu/csd201", resolved_by: null });
    const noPage = await send(student.token, { category: "other", message: "  ok  " });
    expect(noPage.status).toBe(201);
    expect(await built.db.findOne("feedback", { id: noPage.body.id })).toMatchObject({ page: null, message: "ok" });
  });
  it("validates the body and requires a session", async () => {
    const student = await identity();
    expect((await send(student.token, { ...valid, page: "exam/1" })).status).toBe(400);
    expect((await send(student.token, { ...valid, message: "   " })).status).toBe(400);
    expect((await send(student.token, { ...valid, message: "x".repeat(2001) })).status).toBe(400);
    expect((await send(student.token, { ...valid, category: "spam" })).status).toBe(400);
    expect((await send(null, valid)).status).toBe(401);
    expect(await built.db.count("feedback")).toBe(0);
  });
  it("rate limits to 10 per window per user", async () => {
    const a = await identity(),
      b = await identity();
    for (let i = 0; i < 10; i++) expect((await send(a.token, valid)).status).toBe(201);
    expect((await send(a.token, valid)).status).toBe(429);
    expect((await send(b.token, valid)).status).toBe(201);
  });
});

describe("admin feedback", () => {
  it("lists newest first with filters and user join, students are forbidden", async () => {
    const admin = await identity("admin", "Admin One"),
      student = await identity("student", "Sinh Viên");
    const first = (await send(student.token, { ...valid, message: "first" })).body.id;
    await new Promise((r) => setTimeout(r, 5));
    const second = (await send(student.token, { ...valid, message: "second" })).body.id;
    await adminPatch(admin.token, `/feedback/${first}`, { status: "resolved" });
    const all = await adminGet(admin.token, "/feedback");
    expect(all.status).toBe(200);
    expect(all.body.feedback.map((f: any) => f.id)).toEqual([second, first]);
    expect(all.body.feedback[0]).toMatchObject({
      message: "second",
      status: "new",
      resolvedBy: null,
      resolvedAt: null,
      user: { id: student.user.id, fullName: "Sinh Viên", email: student.user.email, mssv: "SE123", schoolId: "fptu" },
    });
    expect(all.body.feedback[1].resolvedBy).toEqual({ id: admin.user.id, fullName: "Admin One" });
    expect((await adminGet(admin.token, "/feedback?status=new")).body.feedback.map((f: any) => f.id)).toEqual([second]);
    expect((await adminGet(admin.token, "/feedback?status=resolved")).body.feedback.map((f: any) => f.id)).toEqual([first]);
    expect((await adminGet(admin.token, "/feedback?status=bogus")).status).toBe(400);
    expect((await adminGet(student.token, "/feedback")).status).toBe(403);
    await built.db.deleteMany("users", { id: student.user.id });
    expect((await adminGet(admin.token, "/feedback")).body.feedback[0].user).toBeNull();
  });
  it("resolves and reopens with audit, validates ids, forbids students", async () => {
    const admin = await identity("admin"),
      student = await identity();
    const id = (await send(student.token, valid)).body.id;
    const done = await adminPatch(admin.token, `/feedback/${id}`, { status: "resolved" });
    expect([done.status, done.body]).toEqual([200, { id, status: "resolved" }]);
    expect(await built.db.findOne("feedback", { id })).toMatchObject({ status: "resolved", resolved_by: admin.user.id });
    expect((await built.db.findOne("feedback", { id }))!.resolved_at).toBeTruthy();
    const reopened = await adminPatch(admin.token, `/feedback/${id}`, { status: "new" });
    expect(reopened.status).toBe(200);
    expect(await built.db.findOne("feedback", { id })).toMatchObject({ status: "new", resolved_by: null, resolved_at: null });
    const actions = (await built.db.find("audit_logs", { entity_id: id }, { created_at: 1 })).map((a) => a.action);
    expect(actions).toEqual(["feedback.resolved", "feedback.reopened"]);
    expect((await adminPatch(admin.token, `/feedback/${randomUUID()}`, { status: "resolved" })).status).toBe(404);
    expect((await adminPatch(admin.token, "/feedback/not-a-uuid", { status: "resolved" })).status).toBe(400);
    expect((await adminPatch(student.token, `/feedback/${id}`, { status: "resolved" })).status).toBe(403);
  });
  it("reports feedbackNewCount in the overview", async () => {
    const admin = await identity("admin"),
      student = await identity();
    expect((await adminGet(admin.token, "/overview")).body.feedbackNewCount).toBe(0);
    const a = (await send(student.token, valid)).body.id;
    await send(student.token, valid);
    expect((await adminGet(admin.token, "/overview")).body.feedbackNewCount).toBe(2);
    await adminPatch(admin.token, `/feedback/${a}`, { status: "resolved" });
    expect((await adminGet(admin.token, "/overview")).body.feedbackNewCount).toBe(1);
  });
});
