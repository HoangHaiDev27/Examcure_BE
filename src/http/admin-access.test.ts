import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

const sdk = vi.hoisted(() => ({ getUser: vi.fn(), single: vi.fn(), rpc: vi.fn() }));
vi.mock("../integrations/supabase.js", () => ({
  getSupabaseAdmin: () => ({
    auth: { getUser: sdk.getUser },
    from: () => {
      const query = {
        select: () => query, eq: () => query, single: sdk.single,
        order: () => query, limit: () => query,
        then: (resolve: (result: { data: never[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    },
    rpc: sdk.rpc,
  }),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const bootstrapToken = "review-bootstrap-token-with-at-least-32-characters";
let built: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ADMIN_BOOTSTRAP_TOKEN", bootstrapToken);
  vi.stubEnv("ADMIN_BOOTSTRAP_EXPIRES_AT", new Date(Date.now() + 60_000).toISOString());
  sdk.getUser.mockImplementation(async (token: string) => token === "session-token"
    ? { data: { user: { id: userId, email: "review@example.invalid" } }, error: null }
    : { data: { user: null }, error: new Error("Invalid token") });
  sdk.single.mockResolvedValue({ data: { role: "student", full_name: "Review" }, error: null });
  sdk.rpc.mockResolvedValue({ data: "created", error: null });
  built = createApp(loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }));
});
afterEach(() => { built.db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function bootstrap(token = bootstrapToken) {
  return request(built.app).post("/api/v1/Admin/bootstrap")
    .set("Authorization", "Bearer session-token").send({ bootstrapToken: token });
}

describe("admin API permissions", () => {
  it("rejects missing sessions and a bootstrap secret presented as an admin bearer token", async () => {
    expect((await request(built.app).get("/api/v1/Admin/overview")).status).toBe(401);
    expect((await request(built.app).get("/api/v1/Admin/overview").set("Authorization", `Bearer ${bootstrapToken}`)).status).toBe(401);
    expect(sdk.rpc).not.toHaveBeenCalled();
  });
  it("does not trust an admin cookie from a student", async () => {
    const response = await request(built.app).get("/api/v1/Admin/overview")
      .set("Authorization", "Bearer session-token").set("Cookie", "examcure_role=admin");
    expect(response.status).toBe(403);
  });
  it("allows an admin and rejects the same session immediately after demotion", async () => {
    sdk.single.mockResolvedValueOnce({ data: { role: "admin", full_name: "Admin" }, error: null });
    expect((await request(built.app).get("/api/v1/Admin/overview").set("Authorization", "Bearer session-token")).status).toBe(200);
    expect((await request(built.app).get("/api/v1/Admin/overview").set("Authorization", "Bearer session-token")).status).toBe(403);
  });
});

describe("initial admin bootstrap", () => {
  it("requires a Supabase user session in addition to the secret", async () => {
    const response = await request(built.app).post("/api/v1/Admin/bootstrap").send({ bootstrapToken });
    expect(response.status).toBe(401);
    expect(sdk.rpc).not.toHaveBeenCalled();
  });
  it.each(["", "not-a-date", "2000-01-01T00:00:00Z", "2099-01-01T00:00:00"])("fails closed for expiry %j", async (expiry) => {
    vi.stubEnv("ADMIN_BOOTSTRAP_EXPIRES_AT", expiry);
    const response = await bootstrap();
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("BOOTSTRAP_DISABLED");
    expect(sdk.rpc).not.toHaveBeenCalled();
  });
  it("is disabled when no server secret is configured", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_TOKEN", "");
    expect((await bootstrap()).body.code).toBe("BOOTSTRAP_DISABLED");
    expect(sdk.rpc).not.toHaveBeenCalled();
  });
  it("rejects incorrect or malformed secrets without calling the grant RPC", async () => {
    expect((await bootstrap("x".repeat(bootstrapToken.length))).body.code).toBe("BOOTSTRAP_INVALID");
    expect((await bootstrap("x".repeat(32))).status).toBe(403);
    expect((await bootstrap("short")).status).toBe(400);
    expect(sdk.rpc).not.toHaveBeenCalled();
  });
  it("grants only the signed-in user's role, ignoring a client-supplied user ID", async () => {
    const response = await request(built.app).post("/api/v1/Admin/bootstrap").set("Authorization", "Bearer session-token")
      .send({ bootstrapToken, userId: "22222222-2222-4222-8222-222222222222" });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ userId, role: "admin" });
    expect(sdk.rpc).toHaveBeenCalledWith("bootstrap_first_admin", { p_user_id: userId });
  });
  it("reports a consumed bootstrap without granting another admin", async () => {
    sdk.rpc.mockResolvedValueOnce({ data: "already_initialized", error: null });
    const response = await bootstrap();
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("BOOTSTRAP_USED");
  });
  it("requires an existing profile before reporting success", async () => {
    sdk.rpc.mockResolvedValueOnce({ data: "profile_not_found", error: null });
    expect((await bootstrap()).status).toBe(404);
  });
  it("does not report success when the grant transaction fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sdk.rpc.mockResolvedValueOnce({ data: null, error: new Error("Database unavailable") });
    expect((await bootstrap()).status).toBe(500);
  });
});
