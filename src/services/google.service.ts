import type { AppConfig } from "../config.js";
import { AppError } from "../lib/errors.js";

export interface GoogleProfile {
  subject: string;
  email: string;
  fullName: string;
}

export type GoogleVerifier = (accessToken: string) => Promise<GoogleProfile>;

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

interface GoogleTokenInfo {
  aud?: string;
  expires_in?: string;
}

export function createGoogleVerifier(config: Pick<AppConfig, "GOOGLE_CLIENT_ID">): GoogleVerifier {
  return async (accessToken) => {
    const [userInfoResponse, tokenInfoResponse] = await Promise.all([
      fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000)
      }),
      config.GOOGLE_CLIENT_ID
        ? fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`, {
            signal: AbortSignal.timeout(8_000)
          })
        : Promise.resolve(null)
    ]);
    if (!userInfoResponse.ok || (tokenInfoResponse && !tokenInfoResponse.ok)) {
      throw new AppError(401, "Google access token không hợp lệ.", "INVALID_GOOGLE_TOKEN");
    }
    const profile = (await userInfoResponse.json()) as GoogleUserInfo;
    if (tokenInfoResponse) {
      const tokenInfo = (await tokenInfoResponse.json()) as GoogleTokenInfo;
      if (tokenInfo.aud !== config.GOOGLE_CLIENT_ID || Number(tokenInfo.expires_in ?? 0) <= 0) {
        throw new AppError(401, "Google access token không thuộc ứng dụng ExamCure.", "INVALID_GOOGLE_AUDIENCE");
      }
    }
    if (!profile.sub || !profile.email || !profile.email_verified) {
      throw new AppError(401, "Tài khoản Google chưa xác thực email.", "GOOGLE_EMAIL_NOT_VERIFIED");
    }
    return {
      subject: profile.sub,
      email: profile.email.toLowerCase(),
      fullName: profile.name?.trim() || profile.email.split("@")[0]!
    };
  };
}
