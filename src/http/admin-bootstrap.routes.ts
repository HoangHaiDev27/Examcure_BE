import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import type { TokenService } from "../services/token.service.js";
import { AppError } from "../lib/errors.js";
import { requireAuth } from "./auth.middleware.js";
import { validateBody } from "./validation.js";

const bootstrapSchema = z.object({
  bootstrapToken: z.string().trim().min(32).max(512),
});

export function createAdminBootstrapRouter(
  tokens: TokenService,
  db: AppDatabase,
): Router {
  const router = Router();
  router.post(
    "/bootstrap",
    requireAuth(tokens, db),
    validateBody(bootstrapSchema),
    async (req, res, next) => {
      try {
        const configured = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim();
        const expiresAt = process.env.ADMIN_BOOTSTRAP_EXPIRES_AT?.trim();
        const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
        if (
          !configured ||
          configured.length < 32 ||
          configured.length > 512 ||
          !expiresAt ||
          !/(Z|[+-]\d{2}:\d{2})$/.test(expiresAt) ||
          !Number.isFinite(expiry) ||
          expiry <= Date.now()
        ) {
          throw new AppError(
            403,
            "Khởi tạo quản trị chưa được bật hoặc đã hết hạn.",
            "BOOTSTRAP_DISABLED",
          );
        }
        const actual = Buffer.from(
          (req.body as z.infer<typeof bootstrapSchema>).bootstrapToken,
        );
        const expected = Buffer.from(configured);
        if (
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        ) {
          throw new AppError(
            403,
            "Mã khởi tạo không hợp lệ.",
            "BOOTSTRAP_INVALID",
          );
        }
        const identity = req.authUser;
        if (!identity)
          throw new AppError(
            401,
            "Bạn cần đăng nhập để tiếp tục.",
            "AUTH_REQUIRED",
          );
        await db.transaction(async () => {
          const state = await db.findOne("system_state", {
            _id: "admin-bootstrap",
          });
          const existing = await db.findOne("users", { role: "admin" });
          if (state?.consumed_at || existing)
            throw new AppError(
              409,
              "Hệ thống đã khởi tạo admin.",
              "BOOTSTRAP_USED",
            );
          const now = new Date().toISOString();
          const result = await db.update(
            "users",
            { id: identity.id, status: "active" },
            { $set: { role: "admin", updated_at: now } },
          );
          if (!result.matchedCount)
            throw new AppError(
              401,
              "Tài khoản không khả dụng.",
              "ACCOUNT_UNAVAILABLE",
            );
          await db.update(
            "system_state",
            { _id: "admin-bootstrap" },
            { $set: { consumed_at: now, user_id: identity.id } },
          );
          await db.insert("audit_logs", {
            id: crypto.randomUUID(),
            actor_id: identity.id,
            action: "admin.bootstrapped",
            entity_type: "user",
            entity_id: identity.id,
            details: {},
            created_at: now,
          });
        });
        res.status(201).json({ userId: identity.id, role: "admin" });
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
