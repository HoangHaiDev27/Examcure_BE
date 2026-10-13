import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ContentRepository } from "../db/content.js";

const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-materials-secret-at-least-thirty-two-characters",
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
async function token() {
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
const get = (t: string, qs: string) =>
  request(built.app).get("/api/v1/Materials?" + qs).auth(t, { type: "bearer" });
async function subject(school: string, code: string, extra = {}) {
  return repo.insert("subjects", {
    school_code: school,
    code,
    name: "Name " + code,
    description: null,
    created_by: null,
    created_at: new Date().toISOString(),
    ...extra,
  });
}
async function material(
  subjectId: string,
  title: string,
  createdAt: string,
  versions: Array<[number, string]>,
) {
  const id = await repo.insert("materials", {
    subject_id: subjectId,
    title,
    description: null,
    created_at: createdAt,
    updated_at: createdAt,
  });
  for (const [n, status] of versions)
    await repo.insert("material_versions", {
      material_id: id,
      version_number: n,
      status,
      original_path: `originals/${randomUUID()}`,
      original_filename: `${title}-v${n}.pptx`,
      mime_type: "application/vnd.test",
      size_bytes: 10,
      slide_count: n,
      created_at: createdAt,
    });
  return id;
}

describe("GET /Materials", () => {
  it("requires auth", async () => {
    expect(
      (await request(built.app).get("/api/v1/Materials?schoolCode=fptu")).status,
    ).toBe(401);
  });

  it("lists the latest ready version per material school-wide", async () => {
    const t = await token(),
      a = await subject("fptu", "PRF192", { display_code: "PRF192" }),
      b = await subject("fptu", "ENG302C", { display_code: "ENG302c" }),
      other = await subject("hcmus", "ZZZ101");
    const m1 = await material(a, "old", "2026-01-01T00:00:00.000Z", [
      [1, "ready"],
      [2, "ready"],
      [3, "processing"],
    ]);
    const m2 = await material(b, "new", "2026-02-01T00:00:00.000Z", [[1, "ready"]]);
    await material(a, "failed-only", "2026-03-01T00:00:00.000Z", [[1, "failed"]]);
    await material(a, "processing-only", "2026-03-02T00:00:00.000Z", [
      [1, "processing"],
    ]);
    await material(other, "foreign", "2026-04-01T00:00:00.000Z", [[1, "ready"]]);

    const r = await get(t, "schoolCode=FPTU");
    expect(r.status).toBe(200);
    expect(r.body.materials.map((m: any) => m.id)).toEqual([m2, m1]);
    expect(r.body.materials[0]).toMatchObject({
      title: "new",
      subjectId: b,
      subjectCode: "ENG302c",
      subjectName: "Name ENG302C",
      version: { version_number: 1, mime_type: "application/vnd.test" },
    });
    expect(r.body.materials[1].version.version_number).toBe(2);
    expect(r.body.truncated).toBe(false);
    expect((await get(t, "schoolCode=nope")).body).toEqual({ materials: [], truncated: false });
  });

  it("flags truncation at 200", async () => {
    const t = await token(),
      a = await subject("fptu", "PRF192");
    const col = (built.db as any).client.db((built.db as any).databaseName);
    const mats = Array.from({ length: 201 }, (_, i) => {
      const id = randomUUID(), at = new Date(2026, 0, 1, 0, 0, i).toISOString();
      return { id, at };
    });
    await built.db.find("subjects", {});
    await col.collection("materials").insertMany(
      mats.map((m) => ({ _id: m.id as any, id: m.id, subject_id: a, title: "m", description: null, created_at: m.at, updated_at: m.at })),
    );
    await col.collection("material_versions").insertMany(
      mats.map((m) => ({ _id: randomUUID() as any, id: randomUUID(), material_id: m.id, version_number: 1, status: "ready", original_path: "o/" + randomUUID(), original_filename: "f.pptx", mime_type: "x", size_bytes: 1, slide_count: 1, created_at: m.at })),
    );
    const r = await get(t, "schoolCode=fptu");
    expect(r.body.materials).toHaveLength(200);
    expect(r.body.truncated).toBe(true);
  }, 60000);

  it("keeps per-subject behaviour: every ready version", async () => {
    const t = await token(),
      a = await subject("fptu", "PRF192");
    await material(a, "old", "2026-01-01T00:00:00.000Z", [
      [1, "ready"],
      [2, "ready"],
      [3, "failed"],
    ]);
    const r = await get(t, "schoolCode=fptu&subjectCode=prf192");
    expect(r.status).toBe(200);
    expect(r.body.materials.map((m: any) => m.version.version_number).sort()).toEqual([
      1, 2,
    ]);
    expect(r.body.materials[0]).not.toHaveProperty("subjectCode");
    expect(r.body.materials[0].version).not.toHaveProperty("mime_type");
  });
});

describe("/openapi.json", () => {
  it("documents the student routes", async () => {
    const r = await request(built.app).get("/openapi.json");
    expect(r.status).toBe(200);
    for (const p of [
      "/Subjects",
      "/Subjects/{subjectId}/exams",
      "/Exams/{examId}",
      "/Exams/{examId}/attempts",
      "/Attempts/{attemptId}",
      "/Me/dashboard",
      "/Me/attempts",
      "/Me/wrong-answers",
      "/Materials",
      "/Materials/{versionId}/slides",
      "/Materials/{versionId}/download",
    ])
      expect(r.body.paths[p], p).toBeDefined();
    expect(r.body.tags.map((x: any) => x.name)).toEqual(
      expect.arrayContaining(["Subjects", "Exams", "Attempts", "Me", "Materials"]),
    );
  });
});
