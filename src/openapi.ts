export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "ExamCure API", version: "1.1.0", description: "Authentication, content ingestion and AI exam API for ExamCure." },
  servers: [{ url: "http://localhost:5010/api/v1" }],
  tags: [{ name: "System" }, { name: "Auth" }, { name: "Users" }, { name: "Admin" }],
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
    "/Admin/bootstrap": { post: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Grant the signed-in user the first admin role with an unexpired one-time setup secret", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["bootstrapToken"], properties: { bootstrapToken: { type: "string", minLength: 32, maxLength: 512 } } } } } }, responses: { "201": { description: "First admin created" }, "401": { description: "Supabase session required" }, "403": { description: "Setup disabled, expired or secret invalid" }, "409": { description: "Admin setup already completed" } } } },
    "/System/status": { get: { tags: ["System"], summary: "Read integration configuration status", responses: { "200": { description: "Configuration flags" } } } },
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
    },
    "/Admin/overview": { get: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Load the admin content overview", responses: { "200": { description: "Overview" }, "401": { description: "Authentication required" }, "403": { description: "Admin role required" } } } },
    "/Admin/users": { get: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "List all accounts with their role", responses: { "200": { description: "Users" } } } },
    "/Admin/users/{userId}/role": { patch: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Promote or demote an account between student and admin", parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Role updated" }, "400": { description: "Self role change or last admin" }, "404": { description: "Account not found" } } } },
    "/Admin/subjects": { post: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Create or update a subject", responses: { "201": { description: "Subject saved" } } } },
    "/Admin/materials": { post: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Create a material version and signed upload URL", responses: { "201": { description: "Signed upload details" } } } },
    "/Admin/materials/{versionId}/complete-upload": { post: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Verify upload and synchronously index PPTX text", parameters: [{ name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Text indexed and material ready" }, "422": { description: "PPTX extraction or indexing failed" } } } },
    "/Materials": { get: { tags: ["Materials"], security: [{ bearerAuth: [] }], summary: "List ready course materials for a school subject", responses: { "200": { description: "Ready material versions" } } } },
    "/Materials/{versionId}/slides": { get: { tags: ["Materials"], security: [{ bearerAuth: [] }], summary: "Read extracted PPTX slide text and notes", parameters: [{ name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Extracted slide content" } } } },
    "/Materials/{versionId}/download": { get: { tags: ["Materials"], security: [{ bearerAuth: [] }], summary: "Create a short-lived original PPTX download URL", parameters: [{ name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Signed download URL" } } } },
    "/Admin/question-generation": { post: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Retrieve source chunks and generate draft questions", responses: { "201": { description: "Questions generated" } } } },
    "/Admin/questions/{questionId}": { patch: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Edit or review a generated question", parameters: [{ name: "questionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Question updated" } } } },
    "/Admin/exams": { post: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Create an exam from approved questions", responses: { "201": { description: "Exam created" } } } }
  }
} as const;
