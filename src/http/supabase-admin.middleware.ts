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
