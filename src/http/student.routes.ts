import { Router } from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { ContentRepository } from "../db/content.js";
import type { TokenService } from "../services/token.service.js";
import { requireAuth } from "./auth.middleware.js";

export function createStudentRouter(
  tokens: TokenService,
  db: AppDatabase,
): Router {
  const router = Router(),
    repo = new ContentRepository(db),
    authenticated = requireAuth(tokens, db);
  router.get("/Subjects", authenticated, async (req, res) => {
    const query = z
      .object({
        schoolCode: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .regex(/^[a-zA-Z0-9-]+$/)
          .transform((v) => v.toLowerCase()),
        code: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .transform((v) => v.toUpperCase())
          .optional(),
      })
      .parse(req.query);
    const rows = await repo.listSubjects(
      query.schoolCode,
      req.userId!,
      query.code,
    );
    const firstTerm = (s: { curriculum_terms?: number[] }) =>
      Array.isArray(s.curriculum_terms) && s.curriculum_terms.length
        ? Math.min(...s.curriculum_terms)
        : Infinity;
    rows.sort((a, b) => {
      const ta = firstTerm(a),
        tb = firstTerm(b);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.code).localeCompare(String(b.code));
    });
    res.json({
      subjects: rows.map((s) => ({
        id: s.id,
        schoolCode: s.school_code,
        code: s.display_code ?? s.code,
        name: s.name,
        description: s.description ?? null,
        faculty: s.faculty ?? null,
        terms: s.curriculum_terms ?? [],
        kind: s.kind ?? null,
        durationMin: s.duration_min ?? null,
        questionCount: s.question_count ?? null,
        difficulty: s.difficulty ?? null,
        publishedExamCount: s.published_exam_count,
        lastScore: s.last_score,
      })),
    });
  });
  return router;
}
