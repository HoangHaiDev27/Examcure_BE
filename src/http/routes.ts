import type { AppConfig } from "../config.js";
import type { FileStorage } from "../integrations/storage.js";
import { createGoogleRouter } from "./google.routes.js";
import { sendAuth, clearSession, REFRESH_COOKIE } from "./session.js";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { toPublicUser } from "../domain/types.js";
import type { AuthService } from "../services/auth.service.js";
import type { TokenService } from "../services/token.service.js";
import { requireAuth } from "./auth.middleware.js";
import { validateBody } from "./validation.js";
import { integrationStatus } from "../integrations/env.js";
import { createFeedbackRouter } from "./feedback.routes.js";
import { createAdminRouter } from "./admin.routes.js";
import { createAdminBootstrapRouter } from "./admin-bootstrap.routes.js";
import { createMaterialsRouter } from "./materials.routes.js";
import { createStudentRouter } from "./student.routes.js";
import { createAssistantRouter } from "./assistant.routes.js";

const email = z.string().trim().email().max(254);
const password = z.string().min(6).max(128);
const otp = z.string().regex(/^\d{6}$/);
const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

export function createApiRouter(
  auth: AuthService,
  tokens: TokenService,
  db: AppDatabase,
  config: AppConfig,
  storage: FileStorage,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });

  router.get("/System/status", (_req, res) =>
    res.json({
      services: {
        ...integrationStatus(),
        database: true,
        databaseEngine: "mongodb",
        mongodb: true,
        storage: true,
        googleAuth: Boolean(
          config.GOOGLE_CLIENT_ID &&
            config.GOOGLE_CLIENT_SECRET &&
            config.GOOGLE_REDIRECT_URI,
        ),
      },
    }),
  );
  router.use(
    "/Admin",
    adminLimiter,
    createAdminBootstrapRouter(tokens, db),
    createAdminRouter(tokens, db, storage, config),
  );
  router.use("/Feedback", createFeedbackRouter(tokens, db));
  router.use("/Materials", createMaterialsRouter(tokens, db, storage, config));

  router.use(createStudentRouter(tokens, db));
  router.use("/Assistant", createAssistantRouter(tokens, db, config));

  const authenticated = requireAuth(tokens, db);

  router.use(
    "/Auth",
    rateLimit({
      windowMs: 60000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  router.use("/Auth", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const origin = req.header("origin");
    if (
      req.method !== "GET" &&
      ((origin &&
        !config.CORS_ORIGIN.split(",")
          .map((v) => v.trim())
          .includes(origin)) ||
        (!origin && req.header("sec-fetch-site") === "cross-site"))
    ) {
      res
        .status(403)
        .json({ message: "Origin không được phép.", code: "INVALID_ORIGIN" });
      return;
    }
    next();
  });
  router.use("/Auth/google", createGoogleRouter(auth, config));
  router.post(
    "/Auth/register",
    validateBody(
      z.object({
        email,
        password,
        fullName: z.string().trim().min(2).max(100),
        mssv: z.string().trim().max(30).default(""),
        schoolId: z.string().trim().min(1).max(50).default("fptu"),
      }),
    ),
    async (req, res, next) => {
      try {
        sendAuth(res.status(201), await auth.register(req.body), config);
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/Auth/verify-otp",
    validateBody(z.object({ email, code: otp })),
    async (req, res, next) => {
      try {
        sendAuth(
          res,
          await auth.verifyEmail(req.body.email, req.body.code),
          config,
        );
      } catch (e) {
        next(e);
      }
    },
  );
  router.post(
    "/Auth/resend-otp",
    validateBody(z.object({ email })),
    async (req, res, next) => {
      try {
        res.json(await auth.resendVerification(req.body.email));
      } catch (e) {
        next(e);
      }
    },
  );
  router.post(
    "/Auth/login",
    validateBody(z.object({ email, password: z.string().min(1).max(128) })),
    async (req, res, next) => {
      try {
        sendAuth(
          res,
          await auth.login(req.body.email, req.body.password),
          config,
        );
      } catch (e) {
        next(e);
      }
    },
  );
  router.post("/Auth/refresh", async (req, res, next) => {
    try {
      const cookie = req.cookies?.[REFRESH_COOKIE];
      if (typeof cookie !== "string") {
        res
          .status(401)
          .json({ message: "Bạn cần đăng nhập.", code: "AUTH_REQUIRED" });
        return;
      }
      const result = await tokens.rotate(cookie);
      sendAuth(
        res,
        {
          ...toPublicUser(result.user),
          token: result.token,
          refreshToken: result.refreshToken,
        },
        config,
      );
    } catch (error) {
      next(error);
    }
  });
  router.post("/Auth/logout", async (req, res, next) => {
    try {
      const cookie = req.cookies?.[REFRESH_COOKIE];
      if (typeof cookie === "string") await tokens.revoke(cookie);
      clearSession(res, config);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });
  router.post(
    "/Auth/forgot-password",
    validateBody(z.object({ email })),
    async (req, res, next) => {
      try {
        res.json(await auth.forgotPassword(req.body.email));
      } catch (e) {
        next(e);
      }
    },
  );
  router.post(
    "/Auth/reset-password",
    validateBody(z.object({ email, code: otp, newPassword: password })),
    async (req, res, next) => {
      try {
        const result = await auth.resetPassword(
          req.body.email,
          req.body.code,
          req.body.newPassword,
        );
        clearSession(res, config);
        res.json(result);
      } catch (e) {
        next(e);
      }
    },
  );

  router.get("/Users/me", authenticated, (req, res) => {
    res.json(toPublicUser(req.authUser!));
  });
  router.patch(
    "/Users/me",
    authenticated,
    validateBody(
      z.object({
        fullName: z.string().trim().min(2).max(100),
        mssv: z.string().trim().max(30),
        schoolId: z.string().trim().min(1).max(50),
      }),
    ),
    async (req, res) => {
      res.json(
        toPublicUser(
          await db.updateProfile(
            req.userId!,
            req.body.fullName,
            req.body.mssv,
            req.body.schoolId,
          ),
        ),
      );
    },
  );

  return router;
}
