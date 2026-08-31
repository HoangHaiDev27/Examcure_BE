export type UserRole = "student" | "admin";
export type UserStatus = "pending" | "active";
export type OtpPurpose = "verify-email" | "reset-password";

export interface User {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string | null;
  mssv: string;
  schoolId: string;
  role: UserRole;
  status: UserStatus;
  googleSubject: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  mssv: string;
  schoolId: string;
  role: UserRole;
  emailVerifiedAt: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    mssv: user.mssv,
    schoolId: user.schoolId,
    role: user.role,
    emailVerifiedAt: user.emailVerifiedAt
  };
}
