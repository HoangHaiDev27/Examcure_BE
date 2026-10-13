import { z } from "zod";
const booleanFromEnv = z.enum(["true", "false"]).transform((v) => v === "true");
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(5010),
  MONGODB_URI: z
    .string()
    .min(1)
    .default(
      "mongodb://127.0.0.1:27017/?replicaSet=examcure-rs&directConnection=true",
    ),
  MONGODB_DATABASE: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("examcure"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:5010/api/v1"),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  JWT_SECRET: z
    .string()
    .min(32)
    .default("examcure-development-secret-change-me"),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SEC: z.coerce.number().int().positive().default(2592000),
  OTP_TTL_MIN: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  DEV_EXPOSE_OTP: booleanFromEnv.default(true),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.union([z.string().url(), z.literal("")]).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanFromEnv.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("ExamCure <no-reply@examcure.local>"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_PATH: z.string().default("./data/files"),
  S3_ENDPOINT: z.union([z.string().url(), z.literal("")]).optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanFromEnv.default(false),
  MATERIAL_PROCESSING_MODE: z.enum(["inline", "worker"]).default("inline"),
});
export type AppConfig = z.infer<typeof schema>;
export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  purpose: "api" | "maintenance" = "api",
): AppConfig {
  const config = schema.parse(source);
  const origins = config.CORS_ORIGIN.split(",").map((v) => v.trim());
  if (
    origins.some((origin) => {
      try {
        return new URL(origin).origin !== origin;
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      "CORS_ORIGIN must contain exact origins separated by commas",
    );
  if (!/^mongodb(\+srv)?:\/\//.test(config.MONGODB_URI))
    throw new Error("MONGODB_URI must be a MongoDB connection string");
  if (
    config.STORAGE_DRIVER === "s3" &&
    (!config.S3_BUCKET ||
      !config.S3_ACCESS_KEY_ID ||
      !config.S3_SECRET_ACCESS_KEY)
  )
    throw new Error("S3_BUCKET and S3 credentials are required");
  const google = [
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI,
  ].filter(Boolean);
  if (google.length !== 0 && google.length !== 3)
    throw new Error("Configure all three Google OAuth variables together");
  if (config.NODE_ENV === "production") {
    if (
      purpose === "api" &&
      (config.JWT_SECRET === "examcure-development-secret-change-me" ||
        config.JWT_SECRET.includes("replace-this"))
    )
      throw new Error("JWT_SECRET must be changed in production");
    if (!source.MONGODB_URI || /YOUR_|USER:PASSWORD/.test(config.MONGODB_URI))
      throw new Error("MONGODB_URI is required in production");
    if (config.STORAGE_DRIVER !== "s3")
      throw new Error("Production requires private S3 storage");
    if (purpose === "api" && !config.SMTP_HOST)
      throw new Error("SMTP_HOST is required in production");
    if (
      purpose === "api" &&
      (!config.API_PUBLIC_URL.startsWith("https://") ||
        origins.some((v) => !v.startsWith("https://")))
    )
      throw new Error("Production API and frontend origins require HTTPS");
    config.DEV_EXPOSE_OTP = false;
  }
  return config;
}
