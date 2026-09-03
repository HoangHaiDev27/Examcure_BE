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
import { createAdminRouter } from "./admin.routes.js";
import { createMaterialsRouter } from "./materials.routes.js";

const email = z.string().trim().email().max(254);
const password = z.string().min(6).max(128);
const otp = z.string().regex(/^\d{6}$/);
const authLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });

export function createApiRouter(
  auth: AuthService,
  tokens: TokenService,
  db: AppDatabase,
  legacyAuthEnabled = true,
): Router {
  const router = Router();

  router.get("/System/status", (_req, res) => res.json({ services: integrationStatus() }));
  router.use("/Admin", adminLimiter, createAdminRouter());
  router.use("/Materials", createMaterialsRouter());
  if (!legacyAuthEnabled) return router;

  const authenticated = requireAuth(tokens, db);

  router.use("/Auth", authLimiter);
  router.post("/Auth/register", validateBody(z.object({
    email, password, fullName: z.string().trim().min(2).max(100),
    mssv: z.string().trim().max(30).default(""), schoolId: z.string().trim().min(1).max(50).default("fptu")
  })), async (req, res, next) => { try { res.status(201).json(await auth.register(req.body)); } catch (e) { next(e); } });

  router.post("/Auth/verify-otp", validateBody(z.object({ email, code: otp })), async (req, res, next) => {
    try { res.json(await auth.verifyEmail(req.body.email, req.body.code)); } catch (e) { next(e); }
  });
  router.post("/Auth/resend-otp", validateBody(z.object({ email })), async (req, res, next) => {
    try { res.json(await auth.resendVerification(req.body.email)); } catch (e) { next(e); }
  });
  router.post("/Auth/login", validateBody(z.object({ email, password: z.string().min(1).max(128) })), async (req, res, next) => {
    try { res.json(await auth.login(req.body.email, req.body.password)); } catch (e) { next(e); }
  });
  router.post("/Auth/google-login", validateBody(z.object({ idToken: z.string().min(1).max(4096) })), async (req, res, next) => {
    try { res.json(await auth.googleLogin(req.body.idToken)); } catch (e) { next(e); }
  });
  router.post("/Auth/refresh", validateBody(z.object({ refreshToken: z.string().min(20) })), async (req, res, next) => {
    try {
      const result = await tokens.rotate(req.body.refreshToken);
      res.json({ ...toPublicUser(result.user), token: result.token, refreshToken: result.refreshToken });
    } catch (e) { next(e); }
  });
  router.post("/Auth/logout", validateBody(z.object({ refreshToken: z.string().min(20) })), (req, res) => {
    tokens.revoke(req.body.refreshToken); res.status(204).send();
  });
  router.post("/Auth/forgot-password", validateBody(z.object({ email })), async (req, res, next) => {
    try { res.json(await auth.forgotPassword(req.body.email)); } catch (e) { next(e); }
  });
  router.post("/Auth/reset-password", validateBody(z.object({ email, code: otp, newPassword: password })), async (req, res, next) => {
    try { res.json(await auth.resetPassword(req.body.email, req.body.code, req.body.newPassword)); } catch (e) { next(e); }
  });

  router.get("/Users/me", authenticated, (req, res) => {
    res.json(toPublicUser(db.findUserById(req.userId!)!));
  });
  router.patch("/Users/me", authenticated, validateBody(z.object({
    fullName: z.string().trim().min(2).max(100), mssv: z.string().trim().max(30), schoolId: z.string().trim().min(1).max(50)
  })), (req, res) => {
    res.json(toPublicUser(db.updateProfile(req.userId!, req.body.fullName, req.body.mssv, req.body.schoolId)));
  });

  return router;
}
