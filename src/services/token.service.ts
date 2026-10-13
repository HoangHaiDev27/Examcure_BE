import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { AppConfig } from "../config.js";
import type { User } from "../domain/types.js";
import type { AppDatabase } from "../db/database.js";
import { AppError } from "../lib/errors.js";
import { generateRefreshToken, hashToken } from "../lib/crypto.js";
export class TokenService {
  private readonly secret: Uint8Array;
  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
  ) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }
  async issue(user: User): Promise<{ token: string; refreshToken: string }> {
    const sid = randomUUID(),
      refreshToken = generateRefreshToken();
    await this.db.createRefreshToken(
      sid,
      user.id,
      hashToken(refreshToken),
      new Date(
        Date.now() + this.config.JWT_REFRESH_TTL_SEC * 1000,
      ).toISOString(),
    );
    const token = await this.signAccess(user.id, sid);
    return { token, refreshToken };
  }
  private signAccess(userId: string, sid: string): Promise<string> {
    return new SignJWT({ sid })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setIssuer("examcure-api")
      .setAudience("examcure-ui")
      .setIssuedAt()
      .setExpirationTime(`${this.config.JWT_ACCESS_TTL_SEC}s`)
      .sign(this.secret);
  }
  async verifyAccessToken(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: "examcure-api",
        audience: "examcure-ui",
        algorithms: ["HS256"],
      });
      if (!payload.sub || typeof payload.sid !== "string")
        throw new Error("Missing session");
      const session = await this.db.findOne("refresh_tokens", {
        id: payload.sid,
        user_id: payload.sub,
      });
      if (
        !session ||
        session.revoked_at ||
        Date.parse(session.expires_at) <= Date.now()
      )
        throw new Error("Revoked session");
      return payload.sub;
    } catch {
      throw new AppError(
        401,
        "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
        "INVALID_TOKEN",
      );
    }
  }
  async rotate(
    refreshToken: string,
  ): Promise<{ user: User; token: string; refreshToken: string }> {
    return this.db.transaction(async () => {
      const stored = await this.db.findRefreshToken(hashToken(refreshToken));
      if (
        !stored ||
        stored.revokedAt ||
        Date.parse(stored.expiresAt) <= Date.now()
      )
        throw new AppError(
          401,
          "Phiên đăng nhập đã hết hạn.",
          "INVALID_REFRESH_TOKEN",
        );
      const user = await this.db.findUserById(stored.userId);
      if (!user || user.status !== "active")
        throw new AppError(
          401,
          "Tài khoản không khả dụng.",
          "ACCOUNT_UNAVAILABLE",
        );
      const replacement = generateRefreshToken();
      const expiresAt = new Date(
        Date.now() + this.config.JWT_REFRESH_TTL_SEC * 1000,
      ).toISOString();
      await this.db.update(
        "refresh_tokens",
        { id: stored.id, revoked_at: null },
        {
          $set: {
            token_hash: hashToken(replacement),
            expires_at: expiresAt,
            purge_at: new Date(Date.parse(expiresAt) + 86400000),
          },
        },
      );
      // Keep the session identity stable: refreshing one tab must not invalidate
      // another tab's unexpired access token. Logout/reset revoke the shared row.
      return {
        user,
        token: await this.signAccess(user.id, stored.id),
        refreshToken: replacement,
      };
    });
  }
  async revoke(refreshToken: string): Promise<void> {
    const stored = await this.db.findRefreshToken(hashToken(refreshToken));
    if (stored) await this.db.revokeRefreshToken(stored.id);
  }
  async signDownload(
    versionId: string,
    userId: string,
    accessToken: string,
  ): Promise<string> {
    // Carry the session ID so logout/recovery also revokes an outstanding link.
    const { payload } = await jwtVerify(accessToken, this.secret, {
      issuer: "examcure-api",
      audience: "examcure-ui",
      algorithms: ["HS256"],
    });
    return new SignJWT({ versionId, sid: payload.sid })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer("examcure-api")
      .setAudience("examcure-file")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(this.secret);
  }
  async verifyDownload(token: string, versionId: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: "examcure-api",
        audience: "examcure-file",
        algorithms: ["HS256"],
      });
      if (
        payload.versionId !== versionId ||
        !payload.sub ||
        typeof payload.sid !== "string"
      )
        throw new Error("Scope mismatch");
      const session = await this.db.findOne("refresh_tokens", {
        id: payload.sid,
        user_id: payload.sub,
        revoked_at: null,
        expires_at: { $gt: new Date().toISOString() },
      });
      const user = await this.db.findUserById(payload.sub);
      if (user?.status !== "active") throw new Error("Account unavailable");
      if (!session) throw new Error("Revoked");
    } catch {
      throw new AppError(
        401,
        "Link tải đã hết hạn hoặc không hợp lệ.",
        "INVALID_DOWNLOAD",
      );
    }
  }
}
