import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AppDatabase } from "./db/database.js";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_PATH: ":memory:",
  JWT_SECRET: "test-secret-that-is-at-least-thirty-two-characters",
  DEV_EXPOSE_OTP: "true"
});

let currentDb: AppDatabase | undefined;
afterEach(() => {
  currentDb?.close();
  currentDb = undefined;
});

function setup() {
  const built = createApp(config, {
    otpSender: { async send() {} },
    googleVerifier: async () => ({ subject: "google-123", email: "google@example.com", fullName: "Google User" })
  });
  currentDb = built.db;
  return built.app;
}

describe("ExamCure API", () => {
  it("registers, verifies OTP and returns the current user", async () => {
    const app = setup();
    const registration = await request(app).post("/api/v1/Auth/register").send({
      email: "student@example.com", password: "secret123", fullName: "Nguyễn Minh An", mssv: "SE123", schoolId: "fptu"
    });
    expect(registration.status).toBe(201);
    expect(registration.body.otp).toMatch(/^\d{6}$/);

    const pendingLogin = await request(app).post("/api/v1/Auth/login").send({ email: "student@example.com", password: "secret123" });
    expect(pendingLogin.status).toBe(403);

    const verification = await request(app).post("/api/v1/Auth/verify-otp").send({
      email: "student@example.com", code: registration.body.otp
    });
    expect(verification.status).toBe(200);
    expect(verification.body).toMatchObject({ email: "student@example.com", schoolId: "fptu", role: "student" });

    const me = await request(app).get("/api/v1/Users/me").set("Authorization", `Bearer ${verification.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body).not.toHaveProperty("passwordHash");
    expect(me.body.fullName).toBe("Nguyễn Minh An");
  });

  it("rotates refresh tokens and rejects the old token", async () => {
    const app = setup();
    const google = await request(app).post("/api/v1/Auth/google-login").send({ idToken: "google-access-token" });
    expect(google.status).toBe(200);

    const rotated = await request(app).post("/api/v1/Auth/refresh").send({ refreshToken: google.body.refreshToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(google.body.refreshToken);

    const replay = await request(app).post("/api/v1/Auth/refresh").send({ refreshToken: google.body.refreshToken });
    expect(replay.status).toBe(401);
  });

  it("resets a password and revokes existing refresh tokens", async () => {
    const app = setup();
    const registration = await request(app).post("/api/v1/Auth/register").send({
      email: "reset@example.com", password: "old-secret", fullName: "Reset User", schoolId: "hust"
    });
    const verified = await request(app).post("/api/v1/Auth/verify-otp").send({ email: "reset@example.com", code: registration.body.otp });
    const forgot = await request(app).post("/api/v1/Auth/forgot-password").send({ email: "reset@example.com" });
    const reset = await request(app).post("/api/v1/Auth/reset-password").send({
      email: "reset@example.com", code: forgot.body.otp, newPassword: "new-secret"
    });
    expect(reset.status).toBe(200);

    const oldRefresh = await request(app).post("/api/v1/Auth/refresh").send({ refreshToken: verified.body.refreshToken });
    expect(oldRefresh.status).toBe(401);
    const login = await request(app).post("/api/v1/Auth/login").send({ email: "reset@example.com", password: "new-secret" });
    expect(login.status).toBe(200);
  });
});
