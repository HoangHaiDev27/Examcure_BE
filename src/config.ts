import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5010),
  DATABASE_PATH: z.string().min(1).default("./data/examcure.sqlite"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  JWT_SECRET: z.string().min(32).default("examcure-development-secret-change-me"),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SEC: z.coerce.number().int().positive().default(2_592_000),
  OTP_TTL_MIN: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  DEV_EXPOSE_OTP: booleanFromEnv.default(true),
  GOOGLE_CLIENT_ID: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanFromEnv.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("ExamCure <no-reply@examcure.local>")
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = schema.parse(source);
  if (config.NODE_ENV === "production") {
    if (config.JWT_SECRET === "examcure-development-secret-change-me") {
      throw new Error("JWT_SECRET must be changed in production");
    }
    if (!config.SMTP_HOST) {
      throw new Error("SMTP_HOST is required in production");
    }
  }
  return config;
}
