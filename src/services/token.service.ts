import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { AppConfig } from "../config.js";
import type { User } from "../domain/types.js";
import type { AppDatabase } from "../db/database.js";
import { AppError } from "../lib/errors.js";
import { generateRefreshToken, hashToken } from "../lib/crypto.js";

export class TokenService {
  private readonly secret: Uint8Array;

  constructor(private readonly db: AppDatabase, private readonly config: AppConfig) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }

  async issue(user: User): Promise<{ token: string; refreshToken: string }> {
    const token = await new SignJWT({ role: user.role, email: user.email })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.id)
      .setIssuer("examcure-api")
      .setAudience("examcure-ui")
      .setIssuedAt()
      .setExpirationTime(`${this.config.JWT_ACCESS_TTL_SEC}s`)
      .sign(this.secret);
    const refreshToken = generateRefreshToken();
    this.db.createRefreshToken(
      randomUUID(),
      user.id,
      hashToken(refreshToken),
      new Date(Date.now() + this.config.JWT_REFRESH_TTL_SEC * 1000).toISOString()
    );
    return { token, refreshToken };
  }

  async verifyAccessToken(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: "examcure-api",
        audience: "examcure-ui"
      });
      if (!payload.sub) throw new Error("Missing subject");
      return payload.sub;
    } catch {
      throw new AppError(401, "Token không hợp lệ hoặc đã hết hạn.", "INVALID_TOKEN");
    }
  }

  async rotate(refreshToken: string): Promise<{ user: User; token: string; refreshToken: string }> {
    const stored = this.db.findRefreshToken(hashToken(refreshToken));
    if (!stored || stored.revokedAt || Date.parse(stored.expiresAt) <= Date.now()) {
      throw new AppError(401, "Refresh token không hợp lệ hoặc đã hết hạn.", "INVALID_REFRESH_TOKEN");
    }
    const user = this.db.findUserById(stored.userId);
    if (!user || user.status !== "active") {
      throw new AppError(401, "Tài khoản không khả dụng.", "ACCOUNT_UNAVAILABLE");
    }
    this.db.revokeRefreshToken(stored.id);
    return { user, ...(await this.issue(user)) };
  }

  revoke(refreshToken: string): void {
    const stored = this.db.findRefreshToken(hashToken(refreshToken));
    if (stored) this.db.revokeRefreshToken(stored.id);
  }
}
