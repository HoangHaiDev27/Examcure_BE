import type { NextFunction, Request, Response } from "express";
import type { AppDatabase } from "../db/database.js";
import type { User } from "../domain/types.js";
import { AppError } from "../lib/errors.js";
import type { TokenService } from "../services/token.service.js";
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      authUser?: User;
      adminIdentity?: {
        id: string;
        email: string | null;
        name: string;
        bootstrap: boolean;
      };
    }
  }
}
export function requireAuth(tokens: TokenService, db: AppDatabase) {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const [scheme, value] = req.header("authorization")?.split(" ") ?? [];
      if (scheme !== "Bearer" || !value)
        throw new AppError(401, "Bạn cần đăng nhập.", "AUTH_REQUIRED");
      const id = await tokens.verifyAccessToken(value),
        user = await db.findUserById(id);
      if (!user || user.status !== "active")
        throw new AppError(401, "Tài khoản không khả dụng.", "AUTH_REQUIRED");
      req.userId = id;
      req.authUser = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}
export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const user = req.authUser;
  if (!user || user.role !== "admin") {
    next(new AppError(403, "Tài khoản không có quyền quản trị.", "FORBIDDEN"));
    return;
  }
  req.adminIdentity = {
    id: user.id,
    email: user.email,
    name: user.fullName,
    bootstrap: false,
  };
  next();
}
