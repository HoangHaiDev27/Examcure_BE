import { randomBytes, createHash } from "node:crypto";
import { Router } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { AppConfig } from "../config.js";
import type { AuthService } from "../services/auth.service.js";
import { AppError } from "../lib/errors.js";
import { REFRESH_COOKIE, refreshCookieOptions } from "./session.js";
const STATE_COOKIE = "examcure_oauth";
export function createGoogleRouter(
  auth: AuthService,
  config: AppConfig,
): Router {
  const router = Router(),
    secret = new TextEncoder().encode(config.JWT_SECRET);
  const cookie = {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/v1/Auth/google",
    maxAge: 600000,
  };
  const configured = () => {
    if (
      !config.GOOGLE_CLIENT_ID ||
      !config.GOOGLE_CLIENT_SECRET ||
      !config.GOOGLE_REDIRECT_URI
    )
      throw new AppError(
        503,
        "Đăng nhập Google chưa được cấu hình.",
        "GOOGLE_NOT_CONFIGURED",
      );
  };
  router.get("/start", async (req, res, next) => {
    try {
      configured();
      if (
        typeof req.query.returnTo !== "string" ||
        req.query.returnTo.length > 2048
      )
        throw new AppError(
          400,
          "Thiếu địa chỉ callback.",
          "INVALID_RETURN_URL",
        );
      const returnTo = new URL(req.query.returnTo);
      if (
        !config.CORS_ORIGIN.split(",")
          .map((v) => v.trim())
          .includes(returnTo.origin) ||
        returnTo.pathname !== "/auth/callback" ||
        returnTo.hash
      )
        throw new AppError(
          400,
          "Địa chỉ callback không hợp lệ.",
          "INVALID_RETURN_URL",
        );
      const state = randomBytes(32).toString("base64url"),
        verifier = randomBytes(48).toString("base64url");
      const signed = await new SignJWT({
        state,
        verifier,
        returnTo: returnTo.toString(),
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("examcure-api")
        .setAudience("examcure-oauth")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(secret);
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID!,
        redirect_uri: config.GOOGLE_REDIRECT_URI!,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      res.cookie(STATE_COOKIE, signed, cookie).redirect(url.toString());
    } catch (error) {
      next(error);
    }
  });
  router.get("/callback", async (req, res, next) => {
    let returnTo: string | undefined;
    try {
      configured();
      const { payload } = await jwtVerify(
        req.cookies?.[STATE_COOKIE] || "",
        secret,
        {
          issuer: "examcure-api",
          audience: "examcure-oauth",
          algorithms: ["HS256"],
        },
      );
      const { maxAge, ...clearCookie } = cookie;
      void maxAge;
      res.clearCookie(STATE_COOKIE, clearCookie);
      if (
        typeof payload.state !== "string" ||
        req.query.state !== payload.state ||
        typeof payload.verifier !== "string" ||
        typeof payload.returnTo !== "string"
      )
        throw new AppError(
          400,
          "Phiên đăng nhập Google không hợp lệ.",
          "INVALID_OAUTH_STATE",
        );
      returnTo = payload.returnTo;
      if (req.query.error || typeof req.query.code !== "string")
        throw new Error("Google authorization declined");
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.GOOGLE_CLIENT_ID!,
          client_secret: config.GOOGLE_CLIENT_SECRET!,
          redirect_uri: config.GOOGLE_REDIRECT_URI!,
          grant_type: "authorization_code",
          code_verifier: payload.verifier,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = (await response.json()) as { access_token?: string };
      if (!response.ok || !data.access_token)
        throw new Error("Google code exchange failed");
      const result = await auth.googleLogin(data.access_token);
      res
        .cookie(
          REFRESH_COOKIE,
          result.refreshToken,
          refreshCookieOptions(config),
        )
        .redirect(returnTo);
    } catch (error) {
      if (returnTo) {
        const url = new URL(returnTo);
        url.searchParams.set("error", "google_login_failed");
        res.redirect(url.toString());
      } else
        next(
          error instanceof AppError
            ? error
            : new AppError(
                400,
                "Phiên đăng nhập Google không hợp lệ.",
                "INVALID_OAUTH_STATE",
              ),
        );
    }
  });
  return router;
}
