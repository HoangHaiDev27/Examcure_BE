import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const productionEnv = {
  NODE_ENV: "production",
  JWT_SECRET: "k9Xw2pQ7vLm4Zt8RbN3sYc6HdJ1fGa5U0e",
  MONGODB_URI: "mongodb+srv://u:p@h.example.net/",
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  API_PUBLIC_URL: "https://api.example.com/api/v1",
  CORS_ORIGIN: "https://app.example.com"
} as NodeJS.ProcessEnv;

describe("loadConfig OTP_DELIVERY", () => {
  it("allows log delivery without SMTP in production and keeps DEV_EXPOSE_OTP off", () => {
    const config = loadConfig({
      ...productionEnv,
      OTP_DELIVERY: "log",
      DEV_EXPOSE_OTP: "true"
    });
    expect(config.OTP_DELIVERY).toBe("log");
    expect(config.DEV_EXPOSE_OTP).toBe(false);
  });

  it("requires SMTP_HOST in production by default", () => {
    expect(() => loadConfig({ ...productionEnv })).toThrow(
      "SMTP_HOST is required in production"
    );
  });

  it("loads with smtp delivery and SMTP_HOST", () => {
    const config = loadConfig({
      ...productionEnv,
      OTP_DELIVERY: "smtp",
      SMTP_HOST: "smtp.example.com"
    });
    expect(config.OTP_DELIVERY).toBe("smtp");
  });

  it("rejects an invalid OTP_DELIVERY value", () => {
    expect(() => loadConfig({ ...productionEnv, OTP_DELIVERY: "email" })).toThrow(
      /OTP_DELIVERY/
    );
  });
});

describe("loadConfig STORAGE_DRIVER", () => {
  const smtp = { OTP_DELIVERY: "log" };
  it("allows mongo storage in production without S3 credentials", () => {
    const config = loadConfig({
      ...productionEnv,
      ...smtp,
      STORAGE_DRIVER: "mongo",
      S3_BUCKET: "",
      S3_ACCESS_KEY_ID: "",
      S3_SECRET_ACCESS_KEY: ""
    });
    expect(config.STORAGE_DRIVER).toBe("mongo");
  });

  it("rejects local storage in production", () => {
    expect(() =>
      loadConfig({ ...productionEnv, ...smtp, STORAGE_DRIVER: "local" })
    ).toThrow("Production requires S3 or MongoDB file storage");
  });
});

describe("loadConfig ASSISTANT_DAILY_LIMIT", () => {
  it("defaults to 20 and validates the range", () => {
    const env = { ...productionEnv, OTP_DELIVERY: "log" };
    expect(loadConfig(env).ASSISTANT_DAILY_LIMIT).toBe(20);
    expect(loadConfig({ ...env, ASSISTANT_DAILY_LIMIT: "50" }).ASSISTANT_DAILY_LIMIT).toBe(50);
    for (const bad of ["0", "1001", "x"])
      expect(() => loadConfig({ ...env, ASSISTANT_DAILY_LIMIT: bad })).toThrow();
  });
});
