import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getSupabaseAdmin } from "../integrations/supabase.js";
import { AppError } from "../lib/errors.js";

export type AdminIdentity = {
  id: string;
  email: string | null;
  name: string;
  bootstrap: boolean;
};

declare global {
  namespace Express {
    interface Request {
      adminIdentity?: AdminIdentity;
    }
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function requireSupabaseAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const [scheme, token] = req.header("authorization")?.split(" ") ?? [];
    if (scheme !== "Bearer" || !token) {
      throw new AppError(401, "Bạn cần đăng nhập để tiếp tục.", "AUTH_REQUIRED");
    }
    const bootstrap = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim();
    if (bootstrap && bootstrap.length >= 32 && sameSecret(token, bootstrap)) {
      req.adminIdentity = { id: "00000000-0000-0000-0000-000000000000", email: null, name: "Bootstrap admin", bootstrap: true };
      next();
      return;
    }
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) throw new AppError(401, "Phiên đăng nhập không hợp lệ.", "AUTH_REQUIRED");
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role, full_name")
      .eq("id", data.user.id)
      .single();
    if (profileError || profile?.role !== "admin") {
      throw new AppError(403, "Tài khoản không có quyền quản trị.", "FORBIDDEN");
    }
    req.adminIdentity = {
      id: data.user.id,
      email: data.user.email ?? null,
      name: profile.full_name || data.user.email || "Admin",
      bootstrap: false,
    };
    next();
  } catch (error) {
    next(error);
  }
}
