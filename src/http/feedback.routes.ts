import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { ContentRepository } from "../db/content.js";
import type { AppDatabase } from "../db/database.js";
import type { TokenService } from "../services/token.service.js";
import { requireAuth } from "./auth.middleware.js";
import { validateBody } from "./validation.js";

export const feedbackSchema = z.object({
  category: z.enum(["bug", "content", "suggestion", "other"]),
  message: z.string().trim().min(1).max(2000),
  page: z
    .string()
    .trim()
    .max(200)
    .refine((value) => value.startsWith("/"))
    .optional(),
});

export function createFeedbackRouter(tokens: TokenService, db: AppDatabase): Router {
  const router = Router(),
    repo = new ContentRepository(db);
  // Mounted after authentication, so the limiter is keyed by the signed-in user.
  const limiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.userId ?? req.ip ?? "anonymous",
    validate: { keyGeneratorIpFallback: false },
  });
  router.post("/", requireAuth(tokens, db), limiter, validateBody(feedbackSchema), async (req, res) => {
    const body = req.body as z.infer<typeof feedbackSchema>;
    const id = await repo.createFeedback(req.userId!, body);
    res.status(201).json({ id });
  });
  return router;
}
