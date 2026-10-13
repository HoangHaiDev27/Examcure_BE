import nodemailer from "nodemailer";
import type { AppConfig } from "../config.js";
import type { OtpPurpose } from "../domain/types.js";

export interface OtpSender {
  send(email: string, otp: string, purpose: OtpPurpose): Promise<void>;
}

export function createOtpSender(config: AppConfig): OtpSender {
  if (config.OTP_DELIVERY === "log" || !config.SMTP_HOST) {
    if (config.OTP_DELIVERY === "log" && config.NODE_ENV === "production") {
      console.warn(
        "[ExamCure OTP] OTP_DELIVERY=log: OTP codes are written to the server log and email delivery is disabled (temporary; set OTP_DELIVERY=smtp with SMTP_* to restore)."
      );
    }
    return {
      async send(email, otp, purpose) {
        console.info(`[ExamCure OTP] ${email} ${purpose}: ${otp}`);
      }
    };
  }
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER && config.SMTP_PASS
      ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
      : undefined
  });
  return {
    async send(email, otp, purpose) {
      const isVerification = purpose === "verify-email";
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: email,
        subject: isVerification ? "Mã xác thực ExamCure" : "Mã đặt lại mật khẩu ExamCure",
        text: `Mã của bạn là ${otp}. Mã sẽ hết hạn sau ${config.OTP_TTL_MIN} phút.`
      });
    }
  };
}
