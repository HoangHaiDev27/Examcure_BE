import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "bcryptjs";
import { AppDatabase } from "../dist/db/database.js";
import { ContentRepository } from "../dist/db/content.js";
import { TokenService } from "../dist/services/token.service.js";
import { verifyPassword } from "../dist/lib/crypto.js";
import { loadConfig } from "../dist/config.js";
import { createApp } from "../dist/app.js";
import { importLegacyExport } from "../scripts/import-legacy-export.mjs";
import { startMongoFixture } from "../scripts/mongo-test-fixture.mjs";
import request from "supertest";
const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI,
  JWT_SECRET: "database-test-secret-at-least-thirty-two-characters",
});
const user = (id = randomUUID(), role = "student") => ({
  id,
  email: id + "@example.com",
  fullName: "User",
  passwordHash: null,
  mssv: "",
  schoolId: "fptu",
  role,
  status: "active",
  googleSubject: null,
  emailVerifiedAt: new Date().toISOString(),
});
const storage = () => {
  const files = new Map();
  return {
    async put(k, b) {
      files.set(k, b);
    },
    async get(k) {
      return files.get(k);
    },
    async size(k) {
      return files.get(k)?.length ?? null;
    },
  };
};

test("startup rejects standalone MongoDB before creating application collections", async () => {
  const fixture = await startMongoFixture({ replicaSet: false });
  const db = new AppDatabase(fixture.uri, "examcure_test_standalone");
  try {
    await assert.rejects(db.ready, /replica set/);
    assert.deepEqual(
      await db.client.db(db.databaseName).listCollections().toArray(),
      [],
    );
  } finally {
    await db.close();
    await fixture.stop();
  }
});

test("MongoDB enforces identity indexes and stores expiry as BSON Date", async () => {
  const db = new AppDatabase(
    config.MONGODB_URI,
    "examcure_test_" + randomUUID().replaceAll("-", ""),
  );
  try {
    const a = await db.createUser({
      ...user(),
      email: "MixedCase@example.com",
      googleSubject: "google-subject",
    });
    await assert.rejects(
      db.createUser({ ...user(), email: "MIXEDCASE@EXAMPLE.COM" }),
      { code: 11000 },
    );
    await assert.rejects(
      db.createUser({ ...user(), googleSubject: "google-subject" }),
      { code: 11000 },
    );
    await db.createUser(user());
    await db.createUser(user()); // A null Google subject must not conflict.
    assert.equal((await db.findUserByEmail("MIXEDCASE@EXAMPLE.COM")).id, a.id);
    const token = await new TokenService(db, config).issue(a);
    const session = await db.findOne("refresh_tokens", { user_id: a.id });
    assert.ok(session.purge_at instanceof Date);
    await db.update(
      "refresh_tokens",
      { id: session.id },
      { $set: { expires_at: new Date(Date.now() - 1000).toISOString() } },
    );
    await assert.rejects(
      new TokenService(db, config).verifyAccessToken(token.token),
      { code: "INVALID_TOKEN" },
    );
    await db.replaceOtp({
      id: randomUUID(),
      userId: a.id,
      purpose: "verify-email",
      codeHash: "first",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      attempts: 0,
      consumedAt: null,
    });
    await db.replaceOtp({
      id: randomUUID(),
      userId: a.id,
      purpose: "verify-email",
      codeHash: "second",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      attempts: 0,
      consumedAt: null,
    });
    assert.equal(
      (await db.getLatestOtp(a.id, "verify-email")).codeHash,
      "second",
    );
    assert.equal(await db.count("otp_codes", { consumed_at: null }), 1);
  } finally {
    await db.close();
  }
});

test("competing MongoDB workers claim once and recover expired leases", async () => {
  const name = "examcure_test_" + randomUUID().replaceAll("-", "");
  const db = new AppDatabase(config.MONGODB_URI, name),
    second = new AppDatabase(config.MONGODB_URI, name);
  try {
    const repo = new ContentRepository(db),
      other = new ContentRepository(second);
    const actor = await db.createUser(user(undefined, "admin"));
    const subject = await repo.createSubject(actor.id, {
      schoolCode: "fptu",
      code: "CSD201",
      name: "DS",
    });
    const material = await repo.createMaterial(actor.id, {
      subjectId: subject.id,
      title: "DS",
      fileName: "ds.pptx",
      mimeType: "application/octet-stream",
      sizeBytes: 5,
    });
    const id = await repo.insert("processing_jobs", {
      job_type: "material_ingestion",
      payload: { material_version_id: material.versionId },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const claimed = await Promise.all([
      repo.claimJob("one"),
      other.claimJob("two"),
    ]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const initial = claimed.find(Boolean);
    assert.equal(initial.attempts, 1);
    assert.deepEqual(initial.payload, {
      material_version_id: material.versionId,
    });
    await db.update(
      "processing_jobs",
      { id },
      { $set: { locked_at: new Date(Date.now() - 31 * 60000).toISOString() } },
    );
    const recovered = await other.claimJob("two");
    assert.equal(recovered.attempts, 2);
    assert.notEqual(recovered.locked_by, initial.locked_by);
    const staleWriter = await db.update(
      "processing_jobs",
      { id, locked_by: initial.locked_by },
      { $set: { status: "completed" } },
    );
    assert.equal(staleWriter.matchedCount, 0);
    await db.update(
      "processing_jobs",
      { id },
      {
        $set: {
          attempts: 3,
          locked_at: new Date(Date.now() - 31 * 60000).toISOString(),
        },
      },
    );
    assert.equal(await repo.claimJob("one"), null);
    assert.equal(
      (await db.findOne("processing_jobs", { id })).status,
      "failed",
    );
    assert.equal((await repo.version(material.versionId)).status, "failed");
  } finally {
    await Promise.all([db.close(), second.close()]);
  }
});

test("legacy export preserves IDs, bcrypt passwords, admin role and private original files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "examcure-import-test-")),
    db = new AppDatabase(
      config.MONGODB_URI,
      "examcure_test_" + randomUUID().replaceAll("-", ""),
    ),
    files = storage();
  try {
    const id = randomUUID(),
      subjectId = randomUUID(),
      materialId = randomUUID(),
      versionId = randomUUID(),
      runId = randomUUID(),
      questionId = randomUUID(),
      examId = randomUUID(),
      buffer = Buffer.from("exported-original"),
      password = await hash("existing-password", 4);
    await writeFile(path.join(directory, "lecture.pptx"), buffer);
    const manifest = {
      version: 1,
      users: [
        {
          id,
          email: "user@example.com",
          encrypted_password: password,
          email_confirmed_at: new Date().toISOString(),
        },
      ],
      profiles: [
        { id, full_name: "Existing Admin", role: "admin", school_id: "hust" },
      ],
      subjects: [
        {
          id: subjectId,
          school_code: "hust",
          code: "DS",
          name: "Data Structures",
          created_by: id,
        },
      ],
      materials: [
        {
          id: materialId,
          subject_id: subjectId,
          title: "Lecture",
          created_by: id,
        },
      ],
      material_versions: [
        {
          id: versionId,
          material_id: materialId,
          version_number: 1,
          status: "ready",
          original_bucket: "material-originals",
          original_path: "lecture.pptx",
          original_filename: "lecture.pptx",
          mime_type: "application/octet-stream",
          size_bytes: buffer.length,
          created_by: id,
        },
      ],
      generation_runs: [
        {
          id: runId,
          subject_id: subjectId,
          requested_by: id,
          status: "completed",
          question_count: 1,
          difficulty: "basic",
          material_version_ids: [versionId],
        },
      ],
      questions: [
        {
          id: questionId,
          generation_run_id: runId,
          subject_id: subjectId,
          prompt: "Which is FIFO?",
          explanation: "Queue is FIFO.",
          difficulty: "basic",
          status: "approved",
          created_by: id,
          approved_by: id,
        },
      ],
      question_options: [0, 1, 2, 3].map((position) => ({
        id: randomUUID(),
        question_id: questionId,
        position,
        content: String(position),
        is_correct: position === 0 ? 1 : 0,
      })),
      question_sources: [
        {
          id: randomUUID(),
          question_id: questionId,
          material_version_id: versionId,
          slide_number: 1,
          chunk_id: "legacy-chunk",
          excerpt: "Queue",
          retrieval_score: 0.9,
        },
      ],
      exams: [
        {
          id: examId,
          subject_id: subjectId,
          title: "Legacy Quiz",
          duration_minutes: 30,
          status: "published",
          created_by: id,
        },
      ],
      exam_questions: [
        { exam_id: examId, question_id: questionId, position: 1, points: 1 },
      ],
      audit_logs: [
        {
          id: 27,
          actor_id: id,
          action: "legacy.action",
          entity_type: "user",
          entity_id: id,
          details: { kept: true },
        },
      ],
      files: [
        {
          bucket: "material-originals",
          path: "lecture.pptx",
          file: "lecture.pptx",
        },
      ],
    };
    assert.equal(
      (await importLegacyExport(db, files, manifest, directory)).applied,
      false,
    );
    assert.equal(await db.findUserById(id), null);
    const invalid = structuredClone(manifest);
    invalid.question_sources[0].material_version_id = randomUUID();
    await assert.rejects(
      importLegacyExport(db, files, invalid, directory),
      /Missing material_versions reference/,
    );
    assert.equal(
      (
        await importLegacyExport(db, files, manifest, directory, {
          apply: true,
        })
      ).applied,
      true,
    );
    const account = await db.findUserById(id);
    assert.equal(account.fullName, "Existing Admin");
    assert.equal(account.role, "admin");
    assert.equal((await db.findOne("audit_logs", {})).details.legacyId, 27);
    const question = await db.findOne("questions", { id: questionId });
    assert.equal(question.question_options.length, 4);
    assert.equal(question.question_options[0].is_correct, true);
    assert.equal(question.question_options[1].is_correct, false);
    assert.equal(question.question_sources[0].material_version_id, versionId);
    assert.equal(
      (await db.findOne("exams", { id: examId })).exam_questions[0].question_id,
      questionId,
    );
    assert.deepEqual(
      (await db.findOne("generation_runs", { id: runId })).material_version_ids,
      [versionId],
    );
    assert.equal(await db.count("question_options"), 0); // Children are embedded, not separate collections.
    assert.equal(
      await verifyPassword("existing-password", account.passwordHash),
      true,
    );
    assert.equal(
      await verifyPassword("wrong-password", account.passwordHash),
      false,
    );
    assert.deepEqual(
      await files.get("material-originals/lecture.pptx"),
      buffer,
    );
    assert.ok(
      (await db.findOne("system_state", { _id: "admin-bootstrap" }))
        .consumed_at,
    );
    await assert.rejects(
      importLegacyExport(db, files, manifest, directory, { apply: true }),
      /empty target/,
    );
  } finally {
    await db.close();
    const resolved = path.resolve(directory);
    assert.ok(
      resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
        path.basename(resolved).startsWith("examcure-import-test-"),
    );
    await rm(resolved, { recursive: true, force: true });
  }
});

test("MongoDB rolls back multi-document content changes and serializes refresh replay", async () => {
  const db = new AppDatabase(
    config.MONGODB_URI,
    "examcure_test_" + randomUUID().replaceAll("-", ""),
  );
  try {
    const account = await db.createUser(user()),
      tokens = new TokenService(db, config),
      initial = await tokens.issue(account);
    const results = await Promise.allSettled([
      tokens.rotate(initial.refreshToken),
      tokens.rotate(initial.refreshToken),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    await assert.rejects(
      db.transaction(async () => {
        await db.update(
          "users",
          { id: account.id },
          { $set: { role: "admin" } },
        );
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal((await db.findUserById(account.id)).role, "student");
  } finally {
    await db.close();
  }
});

test(
  "MongoDB independently hosts auth, bootstrap, embedded content and concurrent transactions",
  { timeout: 60000 },
  async () => {
    let db, second;
    try {
      const name = "examcure_test_" + randomUUID().replaceAll("-", "");
      db = new AppDatabase(config.MONGODB_URI, name);
      second = new AppDatabase(config.MONGODB_URI, name);
      await Promise.all([db.ready, second.ready]);
      const built = createApp(config, {
          db,
          storage: storage(),
          otpSender: { async send() {} },
        }),
        other = createApp(config, {
          db: second,
          storage: storage(),
          otpSender: { async send() {} },
        });
      const a = await db.createUser(user()),
        b = await db.createUser(user()),
        ta = await built.tokens.issue(a),
        tb = await other.tokens.issue(b);
      process.env.ADMIN_BOOTSTRAP_TOKEN =
        "isolated-bootstrap-secret-at-least-thirty-two-characters";
      process.env.ADMIN_BOOTSTRAP_EXPIRES_AT = "2099-01-01T00:00:00Z";
      const responses = await Promise.all(
        [
          [built, ta],
          [other, tb],
        ].map(([app, session]) =>
          request(app.app)
            .post("/api/v1/Admin/bootstrap")
            .auth(session.token, { type: "bearer" })
            .send({ bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN }),
        ),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
      assert.equal((await db.find("users", { role: "admin" })).length, 1);
      const admin = (await db.findUserById(a.id)).role === "admin" ? a : b,
        adminToken = admin.id === a.id ? ta.token : tb.token;
      const saved = await request(built.app)
        .post("/api/v1/Admin/subjects")
        .auth(adminToken, { type: "bearer" })
        .send({ schoolCode: "fptu", code: "CSD201", name: "Data Structures" });
      assert.equal(saved.status, 201);
      const repo = new ContentRepository(db),
        subjectId = saved.body.subject.id;
      const body = {
        subjectId,
        title: "Lecture",
        fileName: "lecture.pptx",
        mimeType: "application/octet-stream",
        sizeBytes: 5,
      };
      const first = await repo.createMaterial(admin.id, body);
      const versions = await Promise.all([
        repo.createMaterial(admin.id, {
          ...body,
          materialId: first.materialId,
        }),
        new ContentRepository(second).createMaterial(admin.id, {
          ...body,
          materialId: first.materialId,
        }),
      ]);
      assert.deepEqual(versions.map((v) => v.versionNumber).sort(), [2, 3]);
      const runId = await repo.insert("generation_runs", {
        subject_id: subjectId,
        requested_by: admin.id,
        status: "generating",
        question_count: 1,
        difficulty: "basic",
        material_version_ids: [first.versionId],
        created_at: new Date().toISOString(),
      });
      await repo.saveGenerated(runId, admin.id, subjectId, [
        {
          prompt: "Which is FIFO?",
          explanation: "Queue is FIFO.",
          difficulty: "basic",
          options: [0, 1, 2, 3].map((position) => ({
            position,
            content: String(position),
            is_correct: position === 0,
          })),
          sources: [
            {
              material_version_id: first.versionId,
              slide_number: 1,
              chunk_id: "chunk1",
              excerpt: "Queue",
              retrieval_score: 0.9,
            },
          ],
        },
      ]);
      const question = (await db.find("questions"))[0];
      await repo.reviewQuestion(admin.id, question.id, { status: "approved" });
      const exam = await repo.createExam(admin.id, {
        subjectId,
        title: "Quiz",
        durationMinutes: 30,
        questionIds: [question.id],
        publish: true,
      });
      assert.equal(exam.status, "published");
      assert.equal(
        (await repo.overview()).questions[0].question_options[0].is_correct,
        true,
      );
      const session = await built.tokens.issue(a),
        rotations = await Promise.allSettled([
          built.tokens.rotate(session.refreshToken),
          other.tokens.rotate(session.refreshToken),
        ]);
      assert.equal(rotations.filter((r) => r.status === "fulfilled").length, 1);
      await assert.rejects(
        db.transaction(async () => {
          await db.update(
            "subjects",
            { id: subjectId },
            { $set: { name: "rolled back" } },
          );
          throw new Error("rollback");
        }),
        /rollback/,
      );
      assert.equal(
        (await db.findOne("subjects", { id: subjectId })).name,
        "Data Structures",
      );
      assert.equal(
        (await db.findOne("questions", { id: question.id })).question_sources
          .length,
        1,
      );
      assert.equal(
        (await db.findOne("exams", { id: exam.examId })).exam_questions.length,
        1,
      );
      assert.ok(
        Array.isArray(
          (await db.findOne("generation_runs", { id: runId }))
            .material_version_ids,
        ),
      );
    } finally {
      delete process.env.ADMIN_BOOTSTRAP_TOKEN;
      delete process.env.ADMIN_BOOTSTRAP_EXPIRES_AT;
      await Promise.all([db?.close(), second?.close()]);
    }
  },
);
