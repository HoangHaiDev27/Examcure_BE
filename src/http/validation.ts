import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import { AppError } from "../lib/errors.js";

export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError(400, "Dữ liệu gửi lên không hợp lệ.", "VALIDATION_ERROR", result.error.flatten()));
      return;
    }
    req.body = result.data;
    next();
  };
}
