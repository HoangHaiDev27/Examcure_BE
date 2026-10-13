import type { Db, IndexDescription } from "mongodb";

const indexes: Record<string, IndexDescription[]> = {
  users: [
    { key: { email: 1 }, unique: true },
    {
      key: { google_subject: 1 },
      unique: true,
      partialFilterExpression: { google_subject: { $type: "string" } },
    },
    { key: { role: 1, status: 1 } },
    { key: { school_id: 1, status: 1 } },
  ],
  otp_codes: [
    { key: { user_id: 1, purpose: 1, created_at: -1 } },
    { key: { purge_at: 1 }, expireAfterSeconds: 0 },
  ],
  refresh_tokens: [
    { key: { token_hash: 1 }, unique: true },
    { key: { user_id: 1 } },
    { key: { purge_at: 1 }, expireAfterSeconds: 0 },
  ],
  subjects: [{ key: { school_code: 1, code: 1 }, unique: true }],
  materials: [{ key: { subject_id: 1, created_at: -1 } }],
  material_versions: [
    { key: { material_id: 1, version_number: 1 }, unique: true },
    { key: { original_path: 1 }, unique: true },
    { key: { status: 1 } },
  ],
  slides: [{ key: { material_version_id: 1, slide_number: 1 }, unique: true }],
  processing_jobs: [
    { key: { status: 1, job_type: 1, created_at: 1 } },
    { key: { status: 1, locked_at: 1 } },
  ],
  generation_runs: [{ key: { created_at: -1 } }],
  questions: [
    { key: { subject_id: 1, status: 1 } },
    { key: { created_at: -1 } },
  ],
  exams: [{ key: { subject_id: 1, status: 1 } }, { key: { created_at: -1 } }],
  attempts: [
    { key: { user_id: 1, submitted_at: -1 } },
    { key: { user_id: 1, subject_id: 1, submitted_at: -1 } },
    {
      key: { user_id: 1, client_attempt_id: 1 },
      unique: true,
      partialFilterExpression: { client_attempt_id: { $type: "string" } },
    },
    { key: { exam_id: 1 } },
  ],
  audit_logs: [{ key: { created_at: -1 } }],
};
export async function initializeCollections(db: Db): Promise<void> {
  for (const [name, definitions] of Object.entries(indexes))
    await db
      .collection(name)
      .createIndexes([{ key: { id: 1 }, unique: true }, ...definitions]);
  const state = db.collection<{ _id: string; [key: string]: unknown }>(
    "system_state",
  );
  await state.updateOne(
    { _id: "business-lock" },
    { $setOnInsert: { revision: 0 } },
    { upsert: true },
  );
  await state.updateOne(
    { _id: "admin-bootstrap" },
    {
      $setOnInsert: { id: "admin-bootstrap", consumed_at: null, user_id: null },
    },
    { upsert: true },
  );
  const existing = await db.collection("users").findOne({ role: "admin" });
  if (existing)
    await state.updateOne(
      { _id: "admin-bootstrap", consumed_at: null },
      { $set: { consumed_at: new Date().toISOString(), user_id: existing.id } },
    );
}
