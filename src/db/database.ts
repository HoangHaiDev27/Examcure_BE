import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OtpPurpose, User, UserRole, UserStatus } from "../domain/types.js";

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
  mssv: string;
  school_id: string;
  role: UserRole;
  status: UserStatus;
  google_subject: string | null;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OtpRow {
  id: string;
  userId: string;
  purpose: OtpPurpose;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  consumedAt: string | null;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    passwordHash: row.password_hash,
    mssv: row.mssv,
    schoolId: row.school_id,
    role: row.role,
    status: row.status,
    googleSubject: row.google_subject,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      const absolute = resolve(path);
      mkdirSync(dirname(absolute), { recursive: true });
      this.db = new DatabaseSync(absolute);
    } else {
      this.db = new DatabaseSync(path);
    }
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        full_name TEXT NOT NULL,
        password_hash TEXT,
        mssv TEXT NOT NULL DEFAULT '',
        school_id TEXT NOT NULL DEFAULT 'fptu',
        role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student', 'admin')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active')),
        google_subject TEXT UNIQUE,
        email_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS otp_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('verify-email', 'reset-password')),
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_otp_user_purpose ON otp_codes(user_id, purpose, created_at DESC);
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash);
    `);
  }

  findUserByEmail(email: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  findUserById(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  findUserByGoogleSubject(subject: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE google_subject = ?").get(subject) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  createUser(input: Omit<User, "createdAt" | "updatedAt">): User {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO users (id, email, full_name, password_hash, mssv, school_id, role, status, google_subject, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.email, input.fullName, input.passwordHash, input.mssv, input.schoolId, input.role, input.status, input.googleSubject, input.emailVerifiedAt, now, now);
    return this.findUserById(input.id)!;
  }

  updatePendingUser(id: string, fullName: string, passwordHash: string, mssv: string, schoolId: string): User {
    this.db.prepare(`UPDATE users SET full_name = ?, password_hash = ?, mssv = ?, school_id = ?, updated_at = ? WHERE id = ?`)
      .run(fullName, passwordHash, mssv, schoolId, new Date().toISOString(), id);
    return this.findUserById(id)!;
  }

  activateUser(id: string): User {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE users SET status = 'active', email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?")
      .run(now, now, id);
    return this.findUserById(id)!;
  }

  connectGoogle(id: string, subject: string, fullName: string): User {
    this.db.prepare(`UPDATE users SET google_subject = ?, full_name = ?, status = 'active', email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`)
      .run(subject, fullName, new Date().toISOString(), new Date().toISOString(), id);
    return this.findUserById(id)!;
  }

  updatePassword(id: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, new Date().toISOString(), id);
  }

  updateProfile(id: string, fullName: string, mssv: string, schoolId: string): User {
    this.db.prepare("UPDATE users SET full_name = ?, mssv = ?, school_id = ?, updated_at = ? WHERE id = ?")
      .run(fullName, mssv, schoolId, new Date().toISOString(), id);
    return this.findUserById(id)!;
  }

  replaceOtp(input: OtpRow): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE otp_codes SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL")
      .run(now, input.userId, input.purpose);
    this.db.prepare(`INSERT INTO otp_codes (id, user_id, purpose, code_hash, expires_at, attempts, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.userId, input.purpose, input.codeHash, input.expiresAt, input.attempts, input.consumedAt, now);
  }

  getLatestOtp(userId: string, purpose: OtpPurpose): OtpRow | null {
    const row = this.db.prepare(`SELECT id, user_id, purpose, code_hash, expires_at, attempts, consumed_at FROM otp_codes WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1`)
      .get(userId, purpose) as { id: string; user_id: string; purpose: OtpPurpose; code_hash: string; expires_at: string; attempts: number; consumed_at: string | null } | undefined;
    return row ? { id: row.id, userId: row.user_id, purpose: row.purpose, codeHash: row.code_hash, expiresAt: row.expires_at, attempts: row.attempts, consumedAt: row.consumed_at } : null;
  }

  incrementOtpAttempts(id: string): void {
    this.db.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  consumeOtp(id: string): void {
    this.db.prepare("UPDATE otp_codes SET consumed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  createRefreshToken(id: string, userId: string, tokenHash: string, expiresAt: string): void {
    this.db.prepare("INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, tokenHash, expiresAt, new Date().toISOString());
  }

  findRefreshToken(tokenHash: string): RefreshTokenRow | null {
    const row = this.db.prepare("SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?")
      .get(tokenHash) as { id: string; user_id: string; expires_at: string; revoked_at: string | null } | undefined;
    return row ? { id: row.id, userId: row.user_id, expiresAt: row.expires_at, revokedAt: row.revoked_at } : null;
  }

  revokeRefreshToken(id: string): void {
    this.db.prepare("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  revokeAllRefreshTokens(userId: string): void {
    this.db.prepare("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?")
      .run(new Date().toISOString(), userId);
  }

  close(): void {
    this.db.close();
  }
}
