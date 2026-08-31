import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { createApiRouter } from "./http/routes.js";
import { AppError } from "./lib/errors.js";
import { openApiDocument } from "./openapi.js";
import { AuthService } from "./services/auth.service.js";
import { createGoogleVerifier, type GoogleVerifier } from "./services/google.service.js";
import { createOtpSender, type OtpSender } from "./services/otp-sender.js";
import { TokenService } from "./services/token.service.js";

export interface AppDependencies {
  db?: AppDatabase;
  otpSender?: OtpSender;
  googleVerifier?: GoogleVerifier;
}

export function createApp(config: AppConfig, dependencies: AppDependencies = {}) {
  const db = dependencies.db ?? new AppDatabase(config.DATABASE_PATH);
  const tokens = new TokenService(db, config);
  const auth = new AuthService(
    db,
    tokens,
    dependencies.otpSender ?? createOtpSender(config),
    dependencies.googleVerifier ?? createGoogleVerifier(config),
    config
  );
  const app = express();
  const origins = config.CORS_ORIGIN.split(",").map((value) => value.trim());

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "examcure-be" }));
  app.get("/api/v1/health", (_req, res) => res.json({ status: "ok", service: "examcure-be" }));
  app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  app.use("/api/v1", createApiRouter(auth, tokens, db));

  app.use((_req, _res, next) => next(new AppError(404, "Không tìm thấy endpoint.", "NOT_FOUND")));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
      return;
    }
    console.error(error);
    res.status(500).json({ message: "Đã xảy ra lỗi máy chủ.", code: "INTERNAL_ERROR" });
  });

  return { app, db };
}
