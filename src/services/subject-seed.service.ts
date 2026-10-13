import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ContentRepository } from "../db/content.js";
import type { AppDatabase } from "../db/database.js";

export const subjectSeedSchema = z.object({
  schoolCode: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9-]+$/),
  subjects: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(50),
        name: z.string().trim().min(1).max(200),
        faculty: z.string().trim().min(1).max(200),
        kind: z.enum(["code", "math", "econ", "theory", "english"]),
        durationMin: z.number().int().positive(),
        questionCount: z.number().int().positive(),
        difficulty: z.enum(["basic", "medium", "advanced"]),
        curriculumTerms: z.array(z.number().int().positive()).min(1),
      }),
    )
    .min(1),
});
export type SubjectSeedResult = {
  inserted: number;
  updated: number;
  unchanged: number;
};

export async function seedSubjects(
  db: AppDatabase,
  input: unknown,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<SubjectSeedResult> {
  const data = subjectSeedSchema.parse(input),
    schoolCode = data.schoolCode.toLowerCase(),
    keys = data.subjects.map((s) => s.code.toUpperCase());
  if (new Set(keys).size !== keys.length)
    throw new Error("Seed contains duplicate subject codes");
  const repo = new ContentRepository(db);
  // Dry runs use plain reads only: no transaction, so the global business lock is never touched.
  const run = async () => {
    const result: SubjectSeedResult = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
    };
    // Match case-insensitively: load the school's subjects once and compare upper-cased codes.
    const existing = new Map(
      (await db.find("subjects", { school_code: schoolCode })).map((row) => [
        String(row.code).toUpperCase(),
        row,
      ]),
    );
    for (const s of data.subjects) {
      const code = s.code.toUpperCase(),
        meta = {
          display_code: s.code,
          faculty: s.faculty,
          curriculum_terms: [...new Set(s.curriculumTerms)].sort(
            (a, b) => a - b,
          ),
          kind: s.kind,
          duration_min: s.durationMin,
          question_count: s.questionCount,
          difficulty: s.difficulty,
        };
      const row = existing.get(code);
      if (!row) {
        result.inserted++;
        if (!dryRun)
          await repo.insert("subjects", {
            id: randomUUID(),
            school_code: schoolCode,
            code,
            name: s.name,
            description: null,
            created_by: null,
            created_at: new Date().toISOString(),
            ...meta,
          });
        continue;
      }
      const missing = Object.fromEntries(
        Object.entries(meta).filter(([key]) => row[key] == null),
      );
      if (!Object.keys(missing).length) {
        result.unchanged++;
        continue;
      }
      result.updated++;
      if (!dryRun)
        await db.update("subjects", { id: row.id }, { $set: missing });
    }
    if (!dryRun)
      await repo.insert("audit_logs", {
        actor_id: null,
        action: "subjects.seeded",
        entity_type: "school",
        entity_id: schoolCode,
        details: { ...result },
        created_at: new Date().toISOString(),
      });
    return result;
  };
  return dryRun ? run() : db.transaction(run);
}
