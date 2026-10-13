import type { CookieOptions, Response } from "express";
import type { AppConfig } from "../config.js";
import type { AuthResponse } from "../services/auth.service.js";
export const REFRESH_COOKIE = "examcure_refresh";
export function refreshCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: config.COOKIE_SAME_SITE,
    path: "/api/v1/Auth",
    maxAge: config.JWT_REFRESH_TTL_SEC * 1000,
  };
}
export function sendAuth(
  res: Response,
  result: AuthResponse,
  config: AppConfig,
): void {
  const { refreshToken, ...body } = result;
  res
    .cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(config))
    .set("Cache-Control", "no-store")
    .json(body);
}
export function clearSession(res: Response, config: AppConfig): void {
  const { maxAge, ...options } = refreshCookieOptions(config);
  void maxAge;
  res.clearCookie(REFRESH_COOKIE, options);
}
