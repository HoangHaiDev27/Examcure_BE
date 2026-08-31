import type { NextFunction, Request, Response } from "express";
import type { AppDatabase } from "../db/database.js";
import { AppError } from "../lib/errors.js";
import type { TokenService } from "../services/token.service.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(tokens: TokenService, db: AppDatabase) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const [scheme, value] = req.header("authorization")?.split(" ") ?? [];
      if (scheme !== "Bearer" || !value) {
        throw new AppError(401, "Bạn cần đăng nhập.", "AUTH_REQUIRED");
      }
      const userId = await tokens.verifyAccessToken(value);
      if (!db.findUserById(userId)) throw new AppError(401, "Tài khoản không tồn tại.", "AUTH_REQUIRED");
      req.userId = userId;
      next();
    } catch (error) {
      next(error);
    }
  };
}
