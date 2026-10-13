import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { toPublicUser, type OtpPurpose, type User } from "../domain/types.js";
import {
  generateOtp,
  hashOtp,
  hashPassword,
  verifyPassword,
} from "../lib/crypto.js";
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
    private readonly config: AppConfig,
  ) {}

  private async authResponse(user: User): Promise<AuthResponse> {
    return { ...toPublicUser(user), ...(await this.tokens.issue(user)) };
  }

  private async issueOtp(user: User, purpose: OtpPurpose): Promise<string> {
    const otp = generateOtp();
    await this.db.replaceOtp({
      id: randomUUID(),
      userId: user.id,
      purpose,
      codeHash: hashOtp(this.config.JWT_SECRET, user.id, purpose, otp),
      expiresAt: new Date(
        Date.now() + this.config.OTP_TTL_MIN * 60_000,
      ).toISOString(),
      attempts: 0,
      consumedAt: null,
    });
    await this.otpSender.send(user.email, otp, purpose);
    return otp;
  }

  private async verifyOtpValue(
    user: User,
    purpose: OtpPurpose,
    code: string,
  ): Promise<AppError | null> {
    const record = await this.db.getLatestOtp(user.id, purpose);
    if (!record || record.consumedAt) {
      return new AppError(
        400,
        "Mã OTP không tồn tại hoặc đã được sử dụng.",
        "OTP_NOT_FOUND",
      );
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      return new AppError(400, "Mã OTP đã hết hạn.", "OTP_EXPIRED");
    }
    if (record.attempts >= this.config.OTP_MAX_ATTEMPTS) {
      return new AppError(
        429,
        "Bạn đã nhập sai quá số lần cho phép. Hãy yêu cầu mã mới.",
        "OTP_LOCKED",
      );
    }
    if (
      record.codeHash !==
      hashOtp(this.config.JWT_SECRET, user.id, purpose, code)
    ) {
      await this.db.incrementOtpAttempts(record.id);
      return new AppError(400, "Mã OTP không hợp lệ.", "INVALID_OTP");
    }
    await this.db.consumeOtp(record.id);
    return null;
  }

  async register(input: {
    email: string;
    password: string;
    fullName: string;
    mssv: string;
    schoolId: string;
  }) {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const user = await this.db.transaction(async () => {
      const existing = await this.db.findUserByEmail(email);
      if (existing?.status === "active")
        throw new AppError(409, "Email đã được sử dụng.", "EMAIL_EXISTS");
      return existing
        ? this.db.updatePendingUser(
            existing.id,
            input.fullName.trim(),
            passwordHash,
            input.mssv.trim(),
            input.schoolId,
          )
        : this.db.createUser({
            id: randomUUID(),
            email,
            fullName: input.fullName.trim(),
            passwordHash,
            mssv: input.mssv.trim(),
            schoolId: input.schoolId,
            role: "student",
            status: "pending",
            googleSubject: null,
            emailVerifiedAt: null,
          });
    });
    const otp = await this.issueOtp(user, "verify-email");
    return {
      success: true,
      message: "Đăng ký thành công. Vui lòng kiểm tra mã OTP.",
      ...(this.config.NODE_ENV !== "production" && this.config.DEV_EXPOSE_OTP
        ? { otp }
        : {}),
    };
  }

  async resendVerification(emailValue: string) {
    const user = await this.db.findUserByEmail(emailValue.trim().toLowerCase());
    if (!user || user.status === "active") {
      return {
        success: true,
        message: "Nếu tài khoản đang chờ xác thực, mã mới đã được gửi.",
      };
    }
    const otp = await this.issueOtp(user, "verify-email");
    return {
      success: true,
      message: "Mã xác thực mới đã được gửi.",
      ...(this.config.NODE_ENV !== "production" && this.config.DEV_EXPOSE_OTP
        ? { otp }
        : {}),
    };
  }

  async verifyEmail(emailValue: string, code: string): Promise<AuthResponse> {
    const result = await this.db.transaction(async () => {
      const user = await this.db.findUserByEmail(
        emailValue.trim().toLowerCase(),
      );
      if (!user)
        return new AppError(
          400,
          "Email hoặc mã OTP không hợp lệ.",
          "INVALID_OTP",
        );
      if (user.status === "active")
        return new AppError(
          409,
          "Tài khoản đã được xác thực.",
          "ALREADY_VERIFIED",
        );
      const error = await this.verifyOtpValue(user, "verify-email", code);
      if (error) return error;
      return this.authResponse(await this.db.activateUser(user.id));
    });
    // Failed attempts must commit, rather than being undone by a rollback.
    if (result instanceof AppError) throw result;
    return result;
  }

  async login(emailValue: string, password: string): Promise<AuthResponse> {
    const user = await this.db.findUserByEmail(emailValue.trim().toLowerCase());
    if (
      !user?.passwordHash ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      throw new AppError(
        401,
        "Email hoặc mật khẩu không đúng.",
        "INVALID_CREDENTIALS",
      );
    }
    if (user.status !== "active") {
      throw new AppError(
        403,
        "Tài khoản chưa được xác thực.",
        "EMAIL_NOT_VERIFIED",
      );
    }
    return this.db.transaction(async () => {
      const current = await this.db.findUserById(user.id);
      if (
        !current ||
        current.status !== "active" ||
        current.passwordHash !== user.passwordHash
      )
        throw new AppError(
          401,
          "Thông tin đăng nhập đã thay đổi. Vui lòng thử lại.",
          "INVALID_CREDENTIALS",
        );
      return this.authResponse(current);
    });
  }

  async googleLogin(accessToken: string): Promise<AuthResponse> {
    const profile = await this.googleVerifier(accessToken);
    return this.db.transaction(async () => {
      let user =
        (await this.db.findUserByGoogleSubject(profile.subject)) ??
        (await this.db.findUserByEmail(profile.email));
      if (user) {
        if (user.googleSubject && user.googleSubject !== profile.subject)
          throw new AppError(
            409,
            "Email đã liên kết với tài khoản Google khác.",
            "GOOGLE_ACCOUNT_CONFLICT",
          );
        user = await this.db.connectGoogle(
          user.id,
          profile.subject,
          profile.fullName,
        );
      } else {
        user = await this.db.createUser({
          id: randomUUID(),
          email: profile.email,
          fullName: profile.fullName,
          passwordHash: null,
          mssv: "",
          schoolId: "fptu",
          role: "student",
          status: "active",
          googleSubject: profile.subject,
          emailVerifiedAt: new Date().toISOString(),
        });
      }
      return this.authResponse(user);
    });
  }

  async forgotPassword(emailValue: string) {
    const user = await this.db.findUserByEmail(emailValue.trim().toLowerCase());
    let otp: string | undefined;
    if (user?.status === "active")
      otp = await this.issueOtp(user, "reset-password");
    return {
      success: true,
      message: "Nếu email tồn tại, mã đặt lại mật khẩu đã được gửi.",
      ...(otp &&
      this.config.NODE_ENV !== "production" &&
      this.config.DEV_EXPOSE_OTP
        ? { otp }
        : {}),
    };
  }

  async resetPassword(emailValue: string, code: string, newPassword: string) {
    const passwordHash = await hashPassword(newPassword);
    const result = await this.db.transaction(async () => {
      const user = await this.db.findUserByEmail(
        emailValue.trim().toLowerCase(),
      );
      if (!user)
        return new AppError(
          400,
          "Email hoặc mã OTP không hợp lệ.",
          "INVALID_OTP",
        );
      const error = await this.verifyOtpValue(user, "reset-password", code);
      if (error) return error;
      await this.db.updatePassword(user.id, passwordHash);
      await this.db.revokeAllRefreshTokens(user.id);
      return { success: true, message: "Đặt lại mật khẩu thành công." };
    });
    if (result instanceof AppError) throw result;
    return result;
  }
}
