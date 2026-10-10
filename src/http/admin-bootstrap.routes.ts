import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { getSupabaseAdmin } from "../integrations/supabase.js";
import { AppError } from "../lib/errors.js";
import { requireSupabaseUser } from "./supabase-user.middleware.js";
import { validateBody } from "./validation.js";

const bootstrapSchema = z.object({ bootstrapToken: z.string().trim().min(32).max(512) });

export function createAdminBootstrapRouter(): Router {
  const router = Router();
  router.post("/bootstrap", requireSupabaseUser, validateBody(bootstrapSchema), async (req, res, next) => {
    try {
      const configured = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim();
      const expiresAt = process.env.ADMIN_BOOTSTRAP_EXPIRES_AT?.trim();
      const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
      if (!configured || configured.length < 32 || configured.length > 512 ||
          !expiresAt || !/(Z|[+-]\d{2}:\d{2})$/.test(expiresAt) ||
          !Number.isFinite(expiry) || expiry <= Date.now()) {
        throw new AppError(403, "Khởi tạo quản trị chưa được bật hoặc đã hết hạn.", "BOOTSTRAP_DISABLED");
      }
      const actual = Buffer.from((req.body as z.infer<typeof bootstrapSchema>).bootstrapToken);
      const expected = Buffer.from(configured);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new AppError(403, "Mã khởi tạo không hợp lệ.", "BOOTSTRAP_INVALID");
      }
      const identity = req.supabaseUserIdentity;
      if (!identity) throw new AppError(401, "Bạn cần đăng nhập để tiếp tục.", "AUTH_REQUIRED");
      // Serialize and consume bootstrap state with the role grant in one RPC.
      const { data, error } = await getSupabaseAdmin().rpc("bootstrap_first_admin", { p_user_id: identity.id });
      if (error) throw error;
      if (data === "already_initialized") {
        throw new AppError(409, "Hệ thống đã khởi tạo admin. Hãy nhờ admin hiện có cấp quyền.", "BOOTSTRAP_USED");
      }
      if (data === "profile_not_found") throw new AppError(404, "Không tìm thấy hồ sơ tài khoản.", "NOT_FOUND");
      if (data !== "created") throw new Error("Unexpected admin bootstrap result");
      res.status(201).json({ userId: identity.id, role: "admin" });
    } catch (error) { next(error); }
  });
  return router;
}
