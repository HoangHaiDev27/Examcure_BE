import cookieParser from "cookie-parser";
import { ZodError } from "zod";
import { createStorage, type FileStorage } from "./integrations/storage.js";
import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { createApiRouter } from "./http/routes.js";
import { AppError } from "./lib/errors.js";
import { openApiDocument } from "./openapi.js";
import { AuthService } from "./services/auth.service.js";
import {
  createGoogleVerifier,
  type GoogleVerifier,
} from "./services/google.service.js";
import { createOtpSender, type OtpSender } from "./services/otp-sender.js";
import { TokenService } from "./services/token.service.js";

export interface AppDependencies {
  db?: AppDatabase;
  storage?: FileStorage;
  otpSender?: OtpSender;
  googleVerifier?: GoogleVerifier;
}

export function createApp(
  config: AppConfig,
  dependencies: AppDependencies = {},
) {
  const db =
    dependencies.db ??
    new AppDatabase(config.MONGODB_URI, config.MONGODB_DATABASE);
  const tokens = new TokenService(db, config);
  const auth = new AuthService(
    db,
    tokens,
    dependencies.otpSender ?? createOtpSender(config),
    dependencies.googleVerifier ?? createGoogleVerifier(config),
    config,
  );
  const app = express();
  const origins = config.CORS_ORIGIN.split(",").map((value) => value.trim());

  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use(cookieParser());
  app.use(async (_req, _res, next) => {
    try {
      await db.ready;
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", service: "examcure-be" }),
  );
  app.get("/api/v1/health", (_req, res) =>
    res.json({ status: "ok", service: "examcure-be" }),
  );
  app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  app.use(
    "/api/v1",
    createApiRouter(
      auth,
      tokens,
      db,
      config,
      dependencies.storage ?? createStorage(config, db),
    ),
  );

  app.use((_req, _res, next) =>
    next(new AppError(404, "Không tìm thấy endpoint.", "NOT_FOUND")),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof AppError) {
        res.status(error.status).json({
          message: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
        return;
      }
      if (error instanceof ZodError) {
        res
          .status(400)
          .json({ message: "Dữ liệu không hợp lệ.", code: "VALIDATION_ERROR" });
        return;
      }
      const fault = error as { status?: number; code?: string | number };
      if (fault.status === 413) {
        res.status(413).json({
          message: "File hoặc dữ liệu quá lớn.",
          code: "PAYLOAD_TOO_LARGE",
        });
        return;
      }
      if (fault.status === 400) {
        res
          .status(400)
          .json({ message: "Dữ liệu không hợp lệ.", code: "VALIDATION_ERROR" });
        return;
      }
      if (fault.code === 11000) {
        res
          .status(409)
          .json({ message: "Dữ liệu đã tồn tại.", code: "CONFLICT" });
        return;
      }
      console.error(
        error instanceof Error ? error.message : "Unexpected server error",
      );
      res
        .status(500)
        .json({ message: "Đã xảy ra lỗi máy chủ.", code: "INTERNAL_ERROR" });
    },
  );

  return { app, db, tokens, auth };
}
