export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "ExamCure API", version: "1.0.0", description: "Authentication and user API for ExamCure." },
  servers: [{ url: "http://localhost:5010/api/v1" }],
  tags: [{ name: "Auth" }, { name: "Users" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      Error: { type: "object", properties: { message: { type: "string" }, code: { type: "string" } } },
      AuthResponse: { type: "object", required: ["id", "email", "fullName", "role", "token", "refreshToken"], properties: {
        id: { type: "string", format: "uuid" }, email: { type: "string", format: "email" }, fullName: { type: "string" },
        mssv: { type: "string" }, schoolId: { type: "string" }, role: { type: "string" }, token: { type: "string" }, refreshToken: { type: "string" }
      } }
    }
  },
  paths: {
    "/Auth/register": { post: { tags: ["Auth"], summary: "Register and send verification OTP", responses: { "201": { description: "Created" }, "409": { description: "Email exists" } } } },
    "/Auth/verify-otp": { post: { tags: ["Auth"], summary: "Verify email and issue tokens", responses: { "200": { description: "Authenticated" } } } },
    "/Auth/login": { post: { tags: ["Auth"], summary: "Login with email and password", responses: { "200": { description: "Authenticated" } } } },
    "/Auth/google-login": { post: { tags: ["Auth"], summary: "Login with a Google OAuth access token", responses: { "200": { description: "Authenticated" } } } },
    "/Auth/refresh": { post: { tags: ["Auth"], summary: "Rotate a refresh token", responses: { "200": { description: "New token pair" } } } },
    "/Auth/logout": { post: { tags: ["Auth"], summary: "Revoke a refresh token", responses: { "204": { description: "Logged out" } } } },
    "/Auth/resend-otp": { post: { tags: ["Auth"], summary: "Resend email verification OTP", responses: { "200": { description: "Accepted" } } } },
    "/Auth/forgot-password": { post: { tags: ["Auth"], summary: "Request password reset OTP", responses: { "200": { description: "Accepted" } } } },
    "/Auth/reset-password": { post: { tags: ["Auth"], summary: "Reset password with OTP", responses: { "200": { description: "Reset" } } } },
    "/Users/me": {
      get: { tags: ["Users"], security: [{ bearerAuth: [] }], summary: "Get current user", responses: { "200": { description: "User" } } },
      patch: { tags: ["Users"], security: [{ bearerAuth: [] }], summary: "Update current user", responses: { "200": { description: "Updated user" } } }
    }
  }
} as const;
