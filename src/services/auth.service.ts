import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { toPublicUser, type OtpPurpose, type User } from "../domain/types.js";
import { generateOtp, hashOtp, hashPassword, verifyPassword } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import type { GoogleVerifier } from "./google.service.js";
import type { OtpSender } from "./otp-sender.js";
import { TokenService } from "./token.service.js";

export interface AuthResponse {
  id: string;
  fullName: string;
  email: string;
  mssv: string;
  schoolId: string;
  role: string;
  token: string;
  refreshToken: string;
}

export class AuthService {
  constructor(
    private readonly db: AppDatabase,
    private readonly tokens: TokenService,
    private readonly otpSender: OtpSender,
    private readonly googleVerifier: GoogleVerifier,
    private readonly config: AppConfig
  ) {}

  private async authResponse(user: User): Promise<AuthResponse> {
    return { ...toPublicUser(user), ...(await this.tokens.issue(user)) };
  }

  private async issueOtp(user: User, purpose: OtpPurpose): Promise<string> {
    const otp = generateOtp();
    this.db.replaceOtp({
      id: randomUUID(),
      userId: user.id,
      purpose,
      codeHash: hashOtp(this.config.JWT_SECRET, user.id, purpose, otp),
      expiresAt: new Date(Date.now() + this.config.OTP_TTL_MIN * 60_000).toISOString(),
      attempts: 0,
      consumedAt: null
    });
    await this.otpSender.send(user.email, otp, purpose);
    return otp;
  }

  private verifyOtpValue(user: User, purpose: OtpPurpose, code: string): void {
    const record = this.db.getLatestOtp(user.id, purpose);
    if (!record || record.consumedAt) {
      throw new AppError(400, "Mã OTP không tồn tại hoặc đã được sử dụng.", "OTP_NOT_FOUND");
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new AppError(400, "Mã OTP đã hết hạn.", "OTP_EXPIRED");
    }
    if (record.attempts >= this.config.OTP_MAX_ATTEMPTS) {
      throw new AppError(429, "Bạn đã nhập sai quá số lần cho phép. Hãy yêu cầu mã mới.", "OTP_LOCKED");
    }
    if (record.codeHash !== hashOtp(this.config.JWT_SECRET, user.id, purpose, code)) {
      this.db.incrementOtpAttempts(record.id);
      throw new AppError(400, "Mã OTP không hợp lệ.", "INVALID_OTP");
    }
    this.db.consumeOtp(record.id);
  }

  async register(input: { email: string; password: string; fullName: string; mssv: string; schoolId: string }) {
    const email = input.email.trim().toLowerCase();
    const existing = this.db.findUserByEmail(email);
    if (existing?.status === "active") {
      throw new AppError(409, "Email đã được sử dụng.", "EMAIL_EXISTS");
    }
    const passwordHash = await hashPassword(input.password);
    const user = existing
      ? this.db.updatePendingUser(existing.id, input.fullName.trim(), passwordHash, input.mssv.trim(), input.schoolId)
      : this.db.createUser({
          id: randomUUID(), email, fullName: input.fullName.trim(), passwordHash,
          mssv: input.mssv.trim(), schoolId: input.schoolId, role: "student", status: "pending",
          googleSubject: null, emailVerifiedAt: null
        });
    const otp = await this.issueOtp(user, "verify-email");
    return {
      success: true,
      message: "Đăng ký thành công. Vui lòng kiểm tra mã OTP.",
      ...(this.config.NODE_ENV !== "production" && this.config.DEV_EXPOSE_OTP ? { otp } : {})
    };
  }

  async resendVerification(emailValue: string) {
    const user = this.db.findUserByEmail(emailValue.trim().toLowerCase());
    if (!user || user.status === "active") {
      return { success: true, message: "Nếu tài khoản đang chờ xác thực, mã mới đã được gửi." };
    }
    const otp = await this.issueOtp(user, "verify-email");
    return {
      success: true,
      message: "Mã xác thực mới đã được gửi.",
      ...(this.config.NODE_ENV !== "production" && this.config.DEV_EXPOSE_OTP ? { otp } : {})
    };
  }

  async verifyEmail(emailValue: string, code: string): Promise<AuthResponse> {
    const user = this.db.findUserByEmail(emailValue.trim().toLowerCase());
    if (!user) throw new AppError(400, "Email hoặc mã OTP không hợp lệ.", "INVALID_OTP");
    if (user.status === "active") throw new AppError(409, "Tài khoản đã được xác thực.", "ALREADY_VERIFIED");
    this.verifyOtpValue(user, "verify-email", code);
    return this.authResponse(this.db.activateUser(user.id));
  }

  async login(emailValue: string, password: string): Promise<AuthResponse> {
    const user = this.db.findUserByEmail(emailValue.trim().toLowerCase());
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw new AppError(401, "Email hoặc mật khẩu không đúng.", "INVALID_CREDENTIALS");
    }
    if (user.status !== "active") {
      throw new AppError(403, "Tài khoản chưa được xác thực.", "EMAIL_NOT_VERIFIED");
    }
    return this.authResponse(user);
  }

  async googleLogin(accessToken: string): Promise<AuthResponse> {
    const profile = await this.googleVerifier(accessToken);
    let user = this.db.findUserByGoogleSubject(profile.subject) ?? this.db.findUserByEmail(profile.email);
    if (user) {
      user = this.db.connectGoogle(user.id, profile.subject, profile.fullName);
    } else {
      user = this.db.createUser({
        id: randomUUID(), email: profile.email, fullName: profile.fullName, passwordHash: null,
        mssv: "", schoolId: "fptu", role: "student", status: "active",
        googleSubject: profile.subject, emailVerifiedAt: new Date().toISOString()
      });
    }
    return this.authResponse(user);
  }

  async forgotPassword(emailValue: string) {
    const user = this.db.findUserByEmail(emailValue.trim().toLowerCase());
    let otp: string | undefined;
    if (user?.status === "active") otp = await this.issueOtp(user, "reset-password");
    return {
      success: true,
      message: "Nếu email tồn tại, mã đặt lại mật khẩu đã được gửi.",
      ...(otp && this.config.NODE_ENV !== "production" && this.config.DEV_EXPOSE_OTP ? { otp } : {})
    };
  }

  async resetPassword(emailValue: string, code: string, newPassword: string) {
    const user = this.db.findUserByEmail(emailValue.trim().toLowerCase());
    if (!user) throw new AppError(400, "Email hoặc mã OTP không hợp lệ.", "INVALID_OTP");
    this.verifyOtpValue(user, "reset-password", code);
    this.db.updatePassword(user.id, await hashPassword(newPassword));
    this.db.revokeAllRefreshTokens(user.id);
    return { success: true, message: "Đặt lại mật khẩu thành công." };
  }
}
