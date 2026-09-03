import type { NextFunction, Request, Response } from "express";
import { getSupabaseAdmin } from "../integrations/supabase.js";
import { AppError } from "../lib/errors.js";

export type SupabaseUserIdentity = {
  id: string;
  email: string | null;
};

declare global {
  namespace Express {
    interface Request {
      supabaseUserIdentity?: SupabaseUserIdentity;
    }
  }
}

/** Require a real Supabase session, without requiring an administrator role. */
export async function requireSupabaseUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const [scheme, token] = req.header("authorization")?.split(" ") ?? [];
    if (scheme !== "Bearer" || !token) {
      throw new AppError(401, "Bạn cần đăng nhập để xem tài liệu.", "AUTH_REQUIRED");
    }
    const { data, error } = await getSupabaseAdmin().auth.getUser(token);
    if (error || !data.user) throw new AppError(401, "Phiên đăng nhập không hợp lệ.", "AUTH_REQUIRED");
    req.supabaseUserIdentity = { id: data.user.id, email: data.user.email ?? null };
    next();
  } catch (error) {
    next(error);
  }
}
