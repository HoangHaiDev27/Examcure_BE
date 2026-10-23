import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, dirname, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createHash } from "node:crypto";
import { AppDatabase } from "../dist/db/database.js";
import { ContentRepository } from "../dist/db/content.js";
import { createStorage } from "../dist/integrations/storage.js";
import { loadConfig } from "../dist/config.js";
const fields = {
  subjects: "id school_code code name description created_by created_at",
  materials: "id subject_id title description created_by created_at updated_at",
  material_versions:
    "id material_id version_number status original_bucket original_path original_filename mime_type size_bytes preview_path slide_count embedding_model error_message created_by created_at processed_at",
  slides:
    "id material_version_id slide_number text_content notes image_path created_at",
  generation_runs:
    "id subject_id requested_by status question_count difficulty material_version_ids extra_instructions model retrieved_chunk_count error_message created_at completed_at",
  questions:
    "id generation_run_id subject_id prompt explanation difficulty status created_by approved_by approved_at created_at updated_at",
  question_options: "id question_id position content is_correct",
  question_sources:
    "id question_id material_version_id slide_number chunk_id excerpt retrieval_score",
  exams:
    "id subject_id title duration_minutes status created_by published_at created_at updated_at",
  exam_questions: "exam_id question_id position points",
  audit_logs: "id actor_id action entity_type entity_id details created_at",
};
const object = z.record(z.string(), z.unknown());
const schema = z.object({
  version: z.literal(1),
  users: z.array(object),
  profiles: z.array(object).default([]),
  files: z
    .array(
      z.object({
        bucket: z.string().min(1),
        path: z.string().min(1),
        file: z.string().min(1),
        contentType: z.string().default("application/octet-stream"),
      }),
    )
    .default([]),
  ...Object.fromEntries(
    Object.keys(fields).map((name) => [name, z.array(object).default([])]),
  ),
});
const safeKey = (bucket, key) => {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(bucket) ||
    isAbsolute(key) ||
    key.includes("\\") ||
    key.split("/").some((part) => !part || part === ".." || part === ".")
  )
    throw new Error("Invalid export storage path");
  return `${bucket}/${key}`;
};
function validateReferences(users, rows) {
  const sets = { users: new Set(users.map((u) => u.id)) };
  for (const [name, data] of Object.entries(rows)) {
    sets[name] = new Set(data.map((r) => r.id));
    if (name !== "exam_questions" && sets[name].size !== data.length)
      throw new Error(`Duplicate IDs in ${name}`);
  }
  const refs = {
    materials: { subject_id: "subjects" },
    material_versions: { material_id: "materials" },
    slides: { material_version_id: "material_versions" },
    generation_runs: { subject_id: "subjects", requested_by: "users" },
    questions: {
      subject_id: "subjects",
      generation_run_id: "generation_runs",
      approved_by: "users",
    },
    question_options: { question_id: "questions" },
    question_sources: {
      question_id: "questions",
      material_version_id: "material_versions",
    },
    exams: { subject_id: "subjects" },
    exam_questions: { exam_id: "exams", question_id: "questions" },
    audit_logs: { actor_id: "users" },
  };
  for (const [name, data] of Object.entries(rows))
    for (const row of data) {
      const references = { ...refs[name] };
      if (Object.hasOwn(row, "created_by")) references.created_by = "users";
      for (const [field, target] of Object.entries(references)) {
        if (
          row[field] == null &&
          [
            "approved_by",
            "generation_run_id",
            "actor_id",
            "created_by",
          ].includes(field)
        )
          continue;
        if (!sets[target].has(row[field]))
          throw new Error(`Missing ${target} reference in ${name}.${field}`);
      }
      if (name === "question_options")
        z.number().int().min(0).max(3).parse(row.position);
      if (name === "material_versions") {
        z.number().int().positive().parse(row.version_number);
        z.number()
          .int()
          .positive()
          .max(20 * 1024 * 1024)
          .parse(row.size_bytes);
        z.enum([
          "uploading",
          "uploaded",
          "processing",
          "ready",
          "failed",
          "archived",
        ]).parse(row.status);
      }
      if (name === "generation_runs")
        for (const id of row.material_version_ids)
          if (!sets.material_versions.has(id))
            throw new Error("Missing generation material version");
    }
  for (const [name, key] of [
    ["question_options", (r) => `${r.question_id}:${r.position}`],
    ["question_sources", (r) => `${r.question_id}:${r.chunk_id}`],
    ["exam_questions", (r) => `${r.exam_id}:${r.position}`],
  ])
    if (new Set(rows[name].map(key)).size !== rows[name].length)
      throw new Error(`Duplicate entries in ${name}`);
  for (const q of rows.questions.filter((q) => q.status === "approved")) {
    const options = rows.question_options.filter((o) => o.question_id === q.id);
    if (
      options.length !== 4 ||
      options.filter((o) => o.is_correct).length !== 1
    )
      throw new Error("Invalid approved question options");
  }
}

export async function importLegacyExport(
  db,
  storage,
  input,
  rootDir,
  { apply = false } = {},
) {
  const manifest = schema.parse(input),
    repository = new ContentRepository(db),
    now = new Date().toISOString(),
    profiles = new Map(manifest.profiles.map((p) => [p.id, p]));
  const users = manifest.users.map((row) => {
    const id = z.string().uuid().parse(row.id),
      email = z.string().email().parse(row.email).toLowerCase(),
      profile = profiles.get(id) || {},
      metadata = row.raw_user_meta_data || row.user_metadata || {};
    const identity = (row.identities || []).find(
        (i) => i.provider === "google",
      ),
      googleSubject =
        identity?.identity_data?.sub || identity?.provider_id || null;
    const verified = row.email_confirmed_at || row.confirmed_at || null,
      password = row.encrypted_password || row.password_hash || null;
    if (
      password &&
      !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(password) &&
      !/^scrypt\$/.test(password)
    )
      throw new Error(
        "Unsupported password hash; prepare password reset before importing",
      );
    return {
      id,
      email,
      fullName: String(
        profile.full_name ||
          metadata.full_name ||
          metadata.name ||
          email.split("@")[0],
      ),
      mssv: String(profile.mssv || metadata.mssv || ""),
      schoolId: String(profile.school_id || metadata.school_id || "fptu"),
      role: z.enum(["student", "admin"]).parse(profile.role || "student"),
      status: verified ? "active" : "pending",
      passwordHash: password,
      googleSubject,
      emailVerifiedAt: verified,
    };
  });
  if (
    new Set(users.map((u) => u.id)).size !== users.length ||
    new Set(users.map((u) => u.email)).size !== users.length
  )
    throw new Error("Duplicate exported users");
  const rows = {};
  for (const [table, list] of Object.entries(fields))
    rows[table] = manifest[table].map((source) => {
      const row = {};
      for (const key of list.split(" "))
        if (source[key] !== undefined) row[key] = source[key];
      if (
        table === "audit_logs" &&
        !z.string().uuid().safeParse(row.id).success
      ) {
        const legacyId = row.id,
          digest = createHash("sha256")
            .update(`examcure:audit:${legacyId}`)
            .digest("hex");
        row.id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        row.details = {
          ...(typeof source.details === "string"
            ? JSON.parse(source.details)
            : source.details),
          legacyId,
        };
      }
      if (table !== "exam_questions") z.string().uuid().parse(row.id);
      if (list.includes("created_at")) row.created_at ||= now;
      if (list.includes("updated_at")) row.updated_at ||= now;
      if (table === "question_options")
        row.is_correct = Boolean(
          z
            .union([z.boolean(), z.literal(0), z.literal(1)])
            .parse(row.is_correct),
        );
      if (table === "generation_runs")
        row.material_version_ids = z
          .array(z.string().uuid())
          .parse(
            typeof source.material_version_ids === "string"
              ? JSON.parse(source.material_version_ids)
              : source.material_version_ids || [],
          );
      if (table === "audit_logs")
        row.details = object.parse(
          typeof row.details === "string"
            ? JSON.parse(row.details)
            : row.details || {},
        );
      if (table === "material_versions") {
        row.original_path = safeKey(
          String(row.original_bucket),
          String(row.original_path),
        );
        if (row.preview_path)
          row.preview_path = safeKey(
            "material-previews",
            String(row.preview_path),
          );
      }
      if (table === "slides" && row.image_path)
        row.image_path = safeKey("slide-images", String(row.image_path));
      return row;
    });
  const files = new Map();
  for (const item of manifest.files) {
    const key = safeKey(item.bucket, item.path),
      base = resolve(rootDir),
      source = resolve(base, item.file);
    if (isAbsolute(item.file) || !source.startsWith(base + sep))
      throw new Error("Export file must be inside the export directory");
    if (files.has(key)) throw new Error("Duplicate export object");
    const actual = await realpath(source);
    if (!actual.startsWith((await realpath(base)) + sep))
      throw new Error("Export file escapes its directory");
    files.set(key, {
      source: actual,
      size: (await stat(actual)).size,
      contentType: item.contentType,
    });
  }
  for (const version of rows.material_versions) {
    const exported = files.get(version.original_path);
    if (
      !exported ||
      exported.size !== Number(version.size_bytes) ||
      exported.size > 20 * 1024 * 1024
    )
      throw new Error(
        "Every original must be exported with the declared byte size",
      );
  }
  validateReferences(users, rows);
  const requireEmpty = async () => {
    for (const collection of [
      "users",
      "subjects",
      "materials",
      "material_versions",
      "slides",
      "processing_jobs",
      "generation_runs",
      "questions",
      "exams",
      "audit_logs",
    ])
      if (await db.count(collection))
        throw new Error("Import requires an empty target database");
  };
  await requireEmpty();
  const counts = {
    users: users.length,
    files: files.size,
    ...Object.fromEntries(
      Object.entries(rows).map(([table, data]) => [table, data.length]),
    ),
  };
  if (!apply) return { applied: false, counts };
  for (const [key, file] of files) {
    const buffer = await readFile(file.source);
    if (buffer.length !== file.size)
      throw new Error("Export file changed during import");
    if ((await storage.size(key)) !== null) {
      if (!(await storage.get(key)).equals(buffer))
        throw new Error("Import would overwrite a different storage object");
    } else await storage.put(key, buffer, file.contentType);
  }
  await db.transaction(async () => {
    await requireEmpty();
    for (const user of users) {
      await db.createUser(user);
      const source = manifest.users.find((row) => row.id === user.id);
      if (source.created_at)
        await db.update(
          "users",
          { id: user.id },
          {
            $set: {
              created_at: source.created_at,
              updated_at: source.updated_at || source.created_at,
            },
          },
        );
    }
    for (const [collection, data] of Object.entries(rows)) {
      if (
        ["question_options", "question_sources", "exam_questions"].includes(
          collection,
        )
      )
        continue;
      for (const row of data) {
        if (collection === "questions") {
          row.question_options = rows.question_options
            .filter((o) => o.question_id === row.id)
            .sort((a, b) => a.position - b.position);
          row.question_sources = rows.question_sources.filter(
            (o) => o.question_id === row.id,
          );
        }
        if (collection === "exams")
          row.exam_questions = rows.exam_questions
            .filter((q) => q.exam_id === row.id)
            .sort((a, b) => a.position - b.position);
        await repository.insert(collection, row);
      }
    }
    const admin = users.find((u) => u.role === "admin");
    if (admin)
      await db.update(
        "system_state",
        { _id: "admin-bootstrap" },
        { $set: { consumed_at: now, user_id: admin.id } },
      );
  });
  return { applied: true, counts };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const file = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!file)
    throw new Error(
      "Usage: npm run db:import -- ./private-export/manifest.json [--apply]",
    );
  const config = loadConfig(process.env, "maintenance"),
    db = new AppDatabase(config.MONGODB_URI, config.MONGODB_DATABASE);
  try {
    await db.ready;
    const location = resolve(file),
      manifest = JSON.parse(await readFile(location, "utf8"));
    console.log(
      JSON.stringify(
        await importLegacyExport(
          db,
          createStorage(config, db),
          manifest,
          dirname(location),
          { apply: process.argv.includes("--apply") },
        ),
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}
