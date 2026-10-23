import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { AppDatabase } from "./db/database.js";
import { hashPassword } from "./lib/crypto.js";
const config = loadConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.TEST_MONGODB_URI!,
  JWT_SECRET: "test-secret-that-is-at-least-thirty-two-characters",
  DEV_EXPOSE_OTP: "true",
});
const databases: AppDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
  vi.unstubAllGlobals();
});
function setup(overrides: Partial<AppConfig> = {}) {
  const built = createApp(
    {
      ...config,
      MONGODB_DATABASE: "examcure_test_" + randomUUID().replaceAll("-", ""),
      ...overrides,
    },
    {
      otpSender: { async send() {} },
      googleVerifier: async () => ({
        subject: "google-123",
        email: "google@example.com",
        fullName: "Google User",
      }),
    },
  );
  databases.push(built.db);
  return built;
}
async function session(
  built: ReturnType<typeof setup>,
  role: "student" | "admin" = "student",
  email = "student@example.com",
) {
  const user = await built.db.createUser({
    id: randomUUID(),
    email,
    fullName: "Student",
    passwordHash: null,
    mssv: "",
    schoolId: "fptu",
    role,
    status: "active",
    googleSubject: null,
    emailVerifiedAt: new Date().toISOString(),
  });
  const tokens = await built.tokens.issue(user);
  return { user, ...tokens, cookie: `examcure_refresh=${tokens.refreshToken}` };
}
async function legacyPending(built: ReturnType<typeof setup>, email: string, password: string) {
  return built.db.createUser({
    id: randomUUID(),
    email,
    fullName: "Legacy User",
    passwordHash: await hashPassword(password),
    mssv: "",
    schoolId: "fptu",
    role: "student",
    status: "pending",
    googleSubject: null,
    emailVerifiedAt: null,
  });
}
const cookies = (response: request.Response) =>
  (response.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

describe("ExamcureBe authentication", () => {
  it("requires independent production database, secrets, storage and mail", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow("JWT_SECRET");
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        JWT_SECRET: "production-secret-with-at-least-thirty-two-characters",
      }),
    ).toThrow("MONGODB_URI");
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        JWT_SECRET: "production-secret-with-at-least-thirty-two-characters",
        MONGODB_URI: "mongodb://localhost/examcure",
      }),
    ).toThrow("S3");
  });
  it("reports configuration without credentials", async () => {
    const { app } = setup(),
      response = await request(app).get("/api/v1/System/status");
    expect(response.status).toBe(200);
    expect(response.body.services).toMatchObject({
      database: true,
      storage: true,
      googleAuth: false,
      pptxTextExtraction: true,
      docxTextExtraction: true,
    });
    expect(JSON.stringify(response.body)).not.toContain(config.JWT_SECRET);
  });
  it("registers, signs in immediately with a private refresh cookie and sends no OTP", async () => {
    const built = setup(),
      { app } = built;
    const registered = await request(app).post("/api/v1/Auth/register").send({
      email: "student@example.com",
      password: "secret123",
      fullName: "Nguyễn Minh An",
      mssv: "SE123",
      schoolId: "hust",
    });
    expect(registered.status).toBe(201);
    expect(registered.body).not.toHaveProperty("otp");
    expect(registered.body).not.toHaveProperty("refreshToken");
    expect(registered.body).toMatchObject({ email: "student@example.com", role: "student" });
    expect(registered.body.token).toEqual(expect.any(String));
    expect(registered.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(registered.headers["set-cookie"][0]).toContain("Path=/api/v1/Auth");
    const user = (await built.db.findUserByEmail("student@example.com"))!;
    expect(user.status).toBe("active");
    expect(user.emailVerifiedAt).toBeNull();
    expect(await built.db.getLatestOtp(user.id, "verify-email")).toBeNull();
    const me = await request(app)
      .get("/api/v1/Users/me")
      .auth(registered.body.token, { type: "bearer" });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      fullName: "Nguyễn Minh An",
      schoolId: "hust",
      role: "student",
    });
    expect(me.body).not.toHaveProperty("passwordHash");
    expect(
      (
        await request(app)
          .post("/api/v1/Auth/refresh")
          .set("Cookie", cookies(registered))
          .send({})
      ).status,
    ).toBe(200);
  });
  it("rejects registering an active email and takes over a legacy pending account", async () => {
    const built = setup(),
      { app } = built;
    const body = { email: "dup@example.com", password: "secret123", fullName: "First User" };
    expect((await request(app).post("/api/v1/Auth/register").send(body)).status).toBe(201);
    expect((await request(app).post("/api/v1/Auth/register").send(body)).status).toBe(409);
    await legacyPending(built, "old@example.com", "old-secret");
    const taken = await request(app)
      .post("/api/v1/Auth/register")
      .send({ email: "old@example.com", password: "new-secret1", fullName: "New Owner" });
    expect(taken.status).toBe(201);
    const user = (await built.db.findUserByEmail("old@example.com"))!;
    expect(user).toMatchObject({ status: "active", fullName: "New Owner", emailVerifiedAt: null });
    const login = (password: string) =>
      request(app).post("/api/v1/Auth/login").send({ email: "old@example.com", password });
    expect((await login("new-secret1")).status).toBe(200);
    expect((await login("old-secret")).status).toBe(401);
  });
  it("activates a legacy pending account on login with the right password", async () => {
    const built = setup(),
      { app } = built;
    await legacyPending(built, "pending@example.com", "secret123");
    const login = (password: string) =>
      request(app).post("/api/v1/Auth/login").send({ email: "pending@example.com", password });
    expect((await login("wrong-secret")).status).toBe(401);
    expect((await built.db.findUserByEmail("pending@example.com"))!.status).toBe("pending");
    const ok = await login("secret123");
    expect(ok.status).toBe(200);
    expect(ok.body.token).toEqual(expect.any(String));
    const user = (await built.db.findUserByEmail("pending@example.com"))!;
    expect(user.status).toBe("active");
    expect(user.emailVerifiedAt).toBeNull();
  });
  it("rotates cookie sessions atomically and rejects replay without invalidating other tabs", async () => {
    const built = setup(),
      initial = await session(built);
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(built.app)
          .post("/api/v1/Auth/refresh")
          .set("Cookie", initial.cookie)
          .send({}),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    const rotated = responses.find((r) => r.status === 200)!;
    expect(rotated.body).not.toHaveProperty("refreshToken");
    expect(cookies(rotated)).not.toBe(initial.cookie);
    expect(
      (
        await request(built.app)
          .get("/api/v1/Users/me")
          .auth(initial.token, { type: "bearer" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(built.app)
          .get("/api/v1/Users/me")
          .auth(rotated.body.token, { type: "bearer" })
      ).status,
    ).toBe(200);
  });
  it("does not accept refresh credentials in JSON, and rejects a foreign origin", async () => {
    const built = setup(),
      initial = await session(built);
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/refresh")
          .send({ refreshToken: initial.refreshToken })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/refresh")
          .set("Cookie", initial.cookie)
          .set("Origin", "https://evil.example")
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/logout")
          .set("Cookie", initial.cookie)
          .set("Sec-Fetch-Site", "cross-site")
          .send({})
      ).status,
    ).toBe(403);
  });
  it("logout revokes both access and refresh tokens immediately", async () => {
    const built = setup(),
      initial = await session(built);
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/logout")
          .set("Cookie", initial.cookie)
          .send({})
      ).status,
    ).toBe(204);
    expect(
      (
        await request(built.app)
          .get("/api/v1/Users/me")
          .auth(initial.token, { type: "bearer" })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/refresh")
          .set("Cookie", initial.cookie)
          .send({})
      ).status,
    ).toBe(401);
  });
  it("persists wrong OTP attempts and allows only one successful verification", async () => {
    const built = setup(),
      { app } = built;
    await legacyPending(built, "otp@example.com", "secret123");
    const registered = { body: await built.auth.resendVerification("otp@example.com") };
    const wrong = registered.body.otp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(app)
            .post("/api/v1/Auth/verify-otp")
            .send({ email: "otp@example.com", code: wrong })
        ).status,
      ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/v1/Auth/verify-otp")
          .send({ email: "otp@example.com", code: registered.body.otp })
      ).status,
    ).toBe(429);
    const resend = await request(app)
      .post("/api/v1/Auth/resend-otp")
      .send({ email: "otp@example.com" });
    const verified = await Promise.all(
      [1, 2].map(() =>
        request(app)
          .post("/api/v1/Auth/verify-otp")
          .send({ email: "otp@example.com", code: resend.body.otp }),
      ),
    );
    expect(verified.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it("reset password consumes OTP and revokes all existing sessions", async () => {
    const built = setup(),
      { app } = built;
    const verified = await request(app).post("/api/v1/Auth/register").send({
      email: "reset@example.com",
      password: "old-secret",
      fullName: "Reset User",
    });
    expect((await built.db.findUserByEmail("reset@example.com"))!.emailVerifiedAt).toBeNull();
    const forgot = await request(app)
      .post("/api/v1/Auth/forgot-password")
      .send({ email: "reset@example.com" });
    expect(
      (
        await request(app).post("/api/v1/Auth/reset-password").send({
          email: "reset@example.com",
          code: forgot.body.otp,
          newPassword: "new-secret",
        })
      ).status,
    ).toBe(200);
    expect((await built.db.findUserByEmail("reset@example.com"))!.emailVerifiedAt).toBeTruthy();
    expect(
      (
        await request(app)
          .get("/api/v1/Users/me")
          .auth(verified.body.token, { type: "bearer" })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/v1/Auth/refresh")
          .set("Cookie", cookies(verified))
          .send({})
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app).post("/api/v1/Auth/reset-password").send({
          email: "reset@example.com",
          code: forgot.body.otp,
          newPassword: "other-secret",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/v1/Auth/login")
          .send({ email: "reset@example.com", password: "new-secret" })
      ).status,
    ).toBe(200);
  });
  it("updates profile but cannot accept a client-supplied admin role", async () => {
    const built = setup(),
      initial = await session(built);
    const response = await request(built.app)
      .patch("/api/v1/Users/me")
      .auth(initial.token, { type: "bearer" })
      .send({
        fullName: "Updated User",
        mssv: "SE123",
        schoolId: "hust",
        role: "admin",
      });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      fullName: "Updated User",
      role: "student",
    });
  });
  it("uses OAuth state and PKCE, returns a cookie and never includes tokens in the redirect", async () => {
    const built = setup({
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:3000/api/v1/Auth/google/callback",
    });
    const start = await request(built.app)
      .get("/api/v1/Auth/google/start")
      .query({
        returnTo: "http://localhost:3000/auth/callback?next=/dashboard",
      });
    expect(start.status).toBe(302);
    const google = new URL(start.headers.location);
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    const callbackCookie = cookies(start),
      state = google.searchParams.get("state")!;
    const invalid = await request(built.app)
      .get("/api/v1/Auth/google/callback")
      .set("Cookie", callbackCookie)
      .query({ state: "wrong", code: "code" });
    expect(invalid.status).toBe(400);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ access_token: "google-access" })),
    );
    const callback = await request(built.app)
      .get("/api/v1/Auth/google/callback")
      .set("Cookie", callbackCookie)
      .query({ state, code: "code" });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(
      "http://localhost:3000/auth/callback?next=/dashboard",
    );
    expect(callback.headers.location).not.toContain("token");
    expect(
      callback.headers["set-cookie"].some((c: string) =>
        c.startsWith("examcure_refresh="),
      ),
    ).toBe(true);
    expect(
      (
        await request(built.app)
          .get("/api/v1/Auth/google/start")
          .query({ returnTo: "https://evil.example/auth/callback" })
      ).status,
    ).toBe(400);
  });
  it("Google linking to an unverified password account drops the password and signs out its sessions", async () => {
    const built = setup();
    const registered = await request(built.app).post("/api/v1/Auth/register").send({
      email: "google@example.com",
      password: "attacker-secret",
      fullName: "Pretender",
    });
    expect(registered.status).toBe(201);
    await built.auth.googleLogin("google-access");
    const user = (await built.db.findUserByEmail("google@example.com"))!;
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerifiedAt).toBeTruthy();
    expect(user.status).toBe("active");
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/login")
          .send({ email: "google@example.com", password: "attacker-secret" })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/refresh")
          .set("Cookie", cookies(registered))
          .send({})
      ).status,
    ).toBe(401);
    expect(
      (
        await request(built.app)
          .get("/api/v1/Users/me")
          .auth(registered.body.token, { type: "bearer" })
      ).status,
    ).toBe(401);
  });
  it("Google linking to an already verified account keeps its password and sessions", async () => {
    const built = setup();
    const owner = await session(built, "student", "google@example.com");
    await built.db.updatePassword(owner.user.id, await hashPassword("owner-secret"));
    await built.auth.googleLogin("google-access");
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/login")
          .send({ email: "google@example.com", password: "owner-secret" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(built.app)
          .post("/api/v1/Auth/refresh")
          .set("Cookie", owner.cookie)
          .send({})
      ).status,
    ).toBe(200);
  });
});
