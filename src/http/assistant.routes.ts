import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { AssistantService } from "../services/assistant.service.js";
import type { TokenService } from "../services/token.service.js";
import { requireAuth } from "./auth.middleware.js";
import { validateBody } from "./validation.js";

const chatSchema = z.object({
  subjectId: z.string().uuid().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(8)
    .refine((m) => m[m.length - 1]?.role === "user", "Last message must come from the user"),
});

export function createAssistantRouter(tokens: TokenService, db: AppDatabase, config: AppConfig): Router {
  const router = Router(),
    authenticated = requireAuth(tokens, db),
    service = new AssistantService(db, config);

  router.get("/usage", authenticated, async (req, res) => {
    res.json(await service.getUsage(req.userId!));
  });
  router.post(
    "/chat",
    authenticated,
    rateLimit({
      windowMs: 60_000,
      limit: 6,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => `assistant:${req.userId}`,
    }),
    validateBody(chatSchema),
    async (req, res) => {
      res.json(await service.chat(req.userId!, req.body));
    },
  );
  return router;
}
