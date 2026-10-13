const errorRef = { $ref: "#/components/schemas/Error" };
const errors = (...codes: string[]) =>
  Object.fromEntries(
    codes.map((c) => [
      c,
      {
        description: "Error",
        content: { "application/json": { schema: errorRef } },
      },
    ]),
  );
const ok = (description: string, schema: object) => ({
  description,
  content: { "application/json": { schema } },
});
const pathUuid = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});
const limitQuery = {
  name: "limit",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
};
const nullable = (type: string) => ({ type: [type, "null"] });
const examSummary = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    subject_id: { type: "string", format: "uuid" },
    title: { type: "string" },
    status: { type: "string", enum: ["generating", "draft", "failed", "published"] },
    source: { type: "string", enum: ["materials", "ai"] },
    difficulty: nullable("string"),
    duration_minutes: { type: "integer" },
    requested_count: { type: "integer" },
    question_count: { type: "integer" },
    checked_count: { type: "integer" },
    error_message: nullable("string"),
    created_at: { type: "string" },
    published_at: nullable("string"),
  },
};
const option = {
  type: "object",
  properties: {
    position: { type: "integer", minimum: 0, maximum: 3 },
    content: { type: "string" },
  },
};
const subjectRef = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    schoolCode: { type: "string" },
    code: { type: "string" },
    name: { type: "string" },
  },
};
const attemptItem = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    examId: { type: "string", format: "uuid" },
    examTitle: nullable("string"),
    subjectId: { type: "string", format: "uuid" },
    schoolCode: nullable("string"),
    subjectCode: nullable("string"),
    subjectName: nullable("string"),
    score: { type: "number" },
    correctCount: { type: "integer" },
    totalCount: { type: "integer" },
    submittedAt: { type: "string", format: "date-time" },
  },
};
const auth = [{ bearerAuth: [] }];

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "ExamCure API",
    version: "1.1.0",
    description:
      "Authentication, content ingestion and AI exam API for ExamCure.",
  },
  servers: [{ url: "http://localhost:5010/api/v1" }],
  tags: [
    { name: "System" },
    { name: "Auth" },
    { name: "Users" },
    { name: "Admin" },
    { name: "Subjects" },
    { name: "Exams" },
    { name: "Attempts" },
    { name: "Me" },
    { name: "Materials" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      Error: {
        type: "object",
        properties: { message: { type: "string" }, code: { type: "string" } },
      },
      AuthResponse: {
        type: "object",
        required: ["id", "email", "fullName", "role", "token"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          fullName: { type: "string" },
          mssv: { type: "string" },
          schoolId: { type: "string" },
          role: { type: "string" },
          token: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/Admin/bootstrap": {
      post: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary:
          "Grant the signed-in user the first admin role with an unexpired one-time setup secret",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["bootstrapToken"],
                properties: {
                  bootstrapToken: {
                    type: "string",
                    minLength: 32,
                    maxLength: 512,
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "First admin created" },
          "401": { description: "ExamcureBe session required" },
          "403": { description: "Setup disabled, expired or secret invalid" },
          "409": { description: "Admin setup already completed" },
        },
      },
    },
    "/System/status": {
      get: {
        tags: ["System"],
        summary: "Read integration configuration status",
        responses: { "200": { description: "Configuration flags" } },
      },
    },
    "/Auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register and send verification OTP",
        responses: {
          "201": { description: "Created" },
          "409": { description: "Email exists" },
        },
      },
    },
    "/Auth/verify-otp": {
      post: {
        tags: ["Auth"],
        summary: "Verify email and issue tokens",
        responses: { "200": { description: "Authenticated" } },
      },
    },
    "/Auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login with email and password",
        responses: { "200": { description: "Authenticated" } },
      },
    },
    "/Auth/google/start": {
      get: {
        tags: ["Auth"],
        summary: "Start Google authorization-code OAuth with state and PKCE",
        responses: { "302": { description: "Redirect to Google" } },
      },
    },
    "/Auth/google/callback": {
      get: {
        tags: ["Auth"],
        summary:
          "Validate state, set HttpOnly session cookie and redirect to frontend",
        responses: {
          "302": {
            description: "Redirect to frontend callback; no token in URL",
          },
        },
      },
    },
    "/Auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Rotate the HttpOnly refresh cookie",
        responses: {
          "200": {
            description: "New access token and rotated HttpOnly cookie",
          },
        },
      },
    },
    "/Auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Revoke the HttpOnly refresh cookie",
        responses: { "204": { description: "Logged out" } },
      },
    },
    "/Auth/resend-otp": {
      post: {
        tags: ["Auth"],
        summary: "Resend email verification OTP",
        responses: { "200": { description: "Accepted" } },
      },
    },
    "/Auth/forgot-password": {
      post: {
        tags: ["Auth"],
        summary: "Request password reset OTP",
        responses: { "200": { description: "Accepted" } },
      },
    },
    "/Auth/reset-password": {
      post: {
        tags: ["Auth"],
        summary: "Reset password with OTP",
        responses: { "200": { description: "Reset" } },
      },
    },
    "/Users/me": {
      get: {
        tags: ["Users"],
        security: [{ bearerAuth: [] }],
        summary: "Get current user",
        responses: { "200": { description: "User" } },
      },
      patch: {
        tags: ["Users"],
        security: [{ bearerAuth: [] }],
        summary: "Update current user",
        responses: { "200": { description: "Updated user" } },
      },
    },
    "/Admin/overview": {
      get: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Load the admin content overview",
        responses: {
          "200": ok("Overview", {
            type: "object",
            properties: {
              admin: { type: "object" },
              subjects: { type: "array", items: { type: "object" } },
              materials: { type: "array", items: { type: "object" } },
              exams: { type: "array", items: examSummary },
            },
          }),
          "401": { description: "Authentication required" },
          "403": { description: "Admin role required" },
        },
      },
    },
    "/Admin/users": {
      get: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "List all accounts with their role",
        responses: { "200": { description: "Users" } },
      },
    },
    "/Admin/users/{userId}/role": {
      patch: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Promote or demote an account between student and admin",
        parameters: [
          {
            name: "userId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": { description: "Role updated" },
          "400": { description: "Self role change or last admin" },
          "404": { description: "Account not found" },
        },
      },
    },
    "/Admin/subjects": {
      post: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Create or update a subject",
        responses: { "201": { description: "Subject saved" } },
      },
    },
    "/Admin/materials": {
      post: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Prepare a material version for authenticated binary upload",
        responses: {
          "201": { description: "Material/version IDs and uploadPath" },
        },
      },
    },
    "/Admin/materials/{versionId}/file": {
      put: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Upload private original PPTX bytes (20 MB max)",
        responses: {
          "200": { description: "Uploaded" },
          "400": { description: "Size/type mismatch" },
          "409": { description: "Already uploaded" },
        },
      },
    },
    "/Admin/materials/{versionId}/complete-upload": {
      post: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Verify upload and synchronously index PPTX text",
        parameters: [
          {
            name: "versionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": { description: "Text indexed and material ready" },
          "422": { description: "PPTX extraction or indexing failed" },
        },
      },
    },
    "/Materials": {
      get: {
        tags: ["Materials"],
        security: [{ bearerAuth: [] }],
        summary:
          "List ready materials. With subjectCode: every ready version of that subject. Without it: the latest ready version of each material in the school (max 200)",
        parameters: [
          {
            name: "schoolCode",
            in: "query",
            required: true,
            schema: { type: "string", maxLength: 50 },
          },
          {
            name: "subjectCode",
            in: "query",
            required: false,
            schema: { type: "string", maxLength: 50 },
          },
        ],
        responses: {
          "200": ok("Ready material versions", {
            type: "object",
            properties: {
              truncated: {
                type: "boolean",
                description: "School-wide list only: true when capped at 200",
              },
              materials: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    title: { type: "string" },
                    description: nullable("string"),
                    createdAt: { type: "string" },
                    subjectId: { type: "string", format: "uuid" },
                    subjectCode: { type: "string" },
                    subjectName: { type: "string" },
                    version: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        version_number: { type: "integer" },
                        original_filename: { type: "string" },
                        mime_type: { type: "string" },
                        size_bytes: { type: "integer" },
                        slide_count: { type: "integer" },
                        processed_at: nullable("string"),
                      },
                    },
                  },
                },
              },
            },
          }),
          ...errors("400", "401"),
        },
      },
    },
    "/Subjects": {
      get: {
        tags: ["Subjects"],
        security: auth,
        summary: "List subjects of a school with the caller's last score",
        parameters: [
          {
            name: "schoolCode",
            in: "query",
            required: true,
            schema: { type: "string", pattern: "^[a-zA-Z0-9-]+$", maxLength: 50 },
          },
          { name: "code", in: "query", schema: { type: "string", maxLength: 50 } },
        ],
        responses: {
          "200": ok("Subjects sorted by first curriculum term then code", {
            type: "object",
            properties: {
              subjects: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ...subjectRef.properties,
                    description: nullable("string"),
                    faculty: nullable("string"),
                    terms: { type: "array", items: { type: "integer" } },
                    kind: nullable("string"),
                    durationMin: nullable("integer"),
                    questionCount: nullable("integer"),
                    difficulty: nullable("string"),
                    publishedExamCount: { type: "integer" },
                    lastScore: nullable("number"),
                  },
                },
              },
            },
          }),
          ...errors("400", "401"),
        },
      },
    },
    "/Subjects/{subjectId}/exams": {
      get: {
        tags: ["Subjects"],
        security: auth,
        summary: "List published exams of a subject",
        parameters: [pathUuid("subjectId")],
        responses: {
          "200": ok("Published exams, newest first", {
            type: "object",
            properties: {
              exams: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    title: { type: "string" },
                    durationMinutes: { type: "integer" },
                    questionCount: { type: "integer" },
                    publishedAt: nullable("string"),
                    lastScore: nullable("number"),
                  },
                },
              },
            },
          }),
          ...errors("400", "401", "404"),
        },
      },
    },
    "/Exams/{examId}": {
      get: {
        tags: ["Exams"],
        security: auth,
        summary: "Fetch a published exam to take. Answers are never included",
        parameters: [pathUuid("examId")],
        responses: {
          "200": ok("Exam with questions", {
            type: "object",
            properties: {
              exam: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  title: { type: "string" },
                  durationMinutes: { type: "integer" },
                  questionCount: { type: "integer" },
                  subject: subjectRef,
                  questions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        prompt: { type: "string" },
                        options: { type: "array", items: option },
                      },
                    },
                  },
                },
              },
            },
          }),
          ...errors("400", "401", "404", "409"),
        },
      },
    },
    "/Exams/{examId}/attempts": {
      post: {
        tags: ["Exams"],
        security: auth,
        summary: "Submit answers; the server grades and stores the attempt",
        parameters: [pathUuid("examId")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["answers", "spentSec"],
                properties: {
                  answers: {
                    type: "array",
                    maxItems: 200,
                    items: {
                      type: "object",
                      required: ["questionId", "selectedPosition"],
                      properties: {
                        questionId: { type: "string", format: "uuid" },
                        selectedPosition: {
                          type: ["integer", "null"],
                          minimum: 0,
                          maximum: 3,
                        },
                      },
                    },
                  },
                  spentSec: { type: "integer", minimum: 0, maximum: 86400 },
                  clientAttemptId: {
                    type: "string",
                    format: "uuid",
                    description:
                      "Idempotency key; resubmitting it returns the existing attempt with 200",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": ok("Existing attempt for this clientAttemptId", {
            type: "object",
            properties: {
              attemptId: { type: "string", format: "uuid" },
              score: { type: "number" },
              correctCount: { type: "integer" },
              totalCount: { type: "integer" },
            },
          }),
          "201": ok("Attempt graded", {
            type: "object",
            properties: {
              attemptId: { type: "string", format: "uuid" },
              score: { type: "number" },
              correctCount: { type: "integer" },
              totalCount: { type: "integer" },
            },
          }),
          ...errors("400", "401", "404", "409", "429"),
        },
      },
    },
    "/Attempts/{attemptId}": {
      get: {
        tags: ["Attempts"],
        security: auth,
        summary: "Read the caller's own graded attempt",
        parameters: [pathUuid("attemptId")],
        responses: {
          "200": ok("Attempt review", {
            type: "object",
            properties: {
              attempt: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  score: { type: "number" },
                  correctCount: { type: "integer" },
                  totalCount: { type: "integer" },
                  spentSec: { type: "integer" },
                  submittedAt: { type: "string", format: "date-time" },
                  exam: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      title: nullable("string"),
                      durationMinutes: nullable("integer"),
                    },
                  },
                  subject: subjectRef,
                  questions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        prompt: nullable("string"),
                        options: { type: "array", items: option },
                        selectedPosition: nullable("integer"),
                        correctPosition: nullable("integer"),
                        isCorrect: { type: "boolean" },
                        explanation: nullable("string"),
                      },
                    },
                  },
                },
              },
            },
          }),
          ...errors("400", "401", "404"),
        },
      },
    },
    "/Me/dashboard": {
      get: {
        tags: ["Me"],
        security: auth,
        summary: "Dashboard statistics for the caller",
        responses: {
          "200": ok("Dashboard", {
            type: "object",
            properties: {
              stats: {
                type: "object",
                properties: {
                  totalAttempts: { type: "integer" },
                  averageScore: nullable("number"),
                  attemptsThisWeek: { type: "integer" },
                  subjectsInProgress: { type: "integer" },
                  rankPercentile: nullable("integer"),
                },
              },
              trend: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    score: { type: "number" },
                    submittedAt: { type: "string", format: "date-time" },
                  },
                },
              },
              recentAttempts: { type: "array", items: attemptItem },
              weakestSubject: {
                type: ["object", "null"],
                properties: {
                  subjectId: { type: "string", format: "uuid" },
                  code: { type: "string" },
                  name: { type: "string" },
                  averageScore: { type: "number" },
                },
              },
            },
          }),
          ...errors("401"),
        },
      },
    },
    "/Me/attempts": {
      get: {
        tags: ["Me"],
        security: auth,
        summary: "Paginated attempt history of the caller",
        parameters: [
          limitQuery,
          {
            name: "before",
            in: "query",
            description: "Exclusive ISO cursor",
            schema: { type: "string", format: "date-time" },
          },
        ],
        responses: {
          "200": ok("Attempts, newest first", {
            type: "object",
            properties: {
              attempts: { type: "array", items: attemptItem },
              nextBefore: nullable("string"),
            },
          }),
          ...errors("400", "401"),
        },
      },
    },
    "/Me/wrong-answers": {
      get: {
        tags: ["Me"],
        security: auth,
        summary: "Questions whose latest answer by the caller was wrong",
        parameters: [limitQuery],
        responses: {
          "200": ok("Wrong answers", {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    questionId: { type: "string", format: "uuid" },
                    subjectId: { type: "string", format: "uuid" },
                    subjectCode: nullable("string"),
                    subjectName: nullable("string"),
                    prompt: { type: "string" },
                    yourAnswer: nullable("string"),
                    correctAnswer: nullable("string"),
                    explanation: nullable("string"),
                    submittedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          }),
          ...errors("400", "401"),
        },
      },
    },
    "/Materials/{versionId}/slides": {
      get: {
        tags: ["Materials"],
        security: [{ bearerAuth: [] }],
        summary: "Read extracted PPTX slide text and notes",
        parameters: [
          {
            name: "versionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": ok("Extracted slide content", {
            type: "object",
            properties: {
              material: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  schoolCode: { type: "string" },
                  subjectCode: { type: "string" },
                },
              },
              version: { type: "object" },
              slides: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    slide_number: { type: "integer" },
                    text_content: { type: "string" },
                    notes: nullable("string"),
                  },
                },
              },
            },
          }),
          ...errors("400", "401", "404"),
        },
      },
    },
    "/Materials/{versionId}/download": {
      get: {
        tags: ["Materials"],
        security: [{ bearerAuth: [] }],
        summary: "Create a short-lived original PPTX download URL",
        parameters: [
          {
            name: "versionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": ok("Signed download URL", {
            type: "object",
            properties: {
              url: { type: "string" },
              filename: { type: "string" },
              expiresInSeconds: { type: "integer" },
            },
          }),
          ...errors("400", "401", "404"),
        },
      },
    },
    "/Admin/questions/{questionId}": {
      patch: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Edit or review a generated question (locked once its exam is published)",
        parameters: [pathUuid("questionId")],
        responses: {
          "200": { description: "Question updated" },
          ...errors("400", "401", "403", "404", "409"),
        },
      },
    },
    "/Admin/exams/generate": {
      post: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Start generating a draft exam with AI in the background",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subjectId", "title", "durationMinutes", "questionCount", "difficulty"],
                properties: {
                  subjectId: { type: "string", format: "uuid" },
                  title: { type: "string", maxLength: 200 },
                  durationMinutes: { type: "integer", minimum: 1, maximum: 300 },
                  questionCount: { type: "integer", minimum: 1, maximum: 50 },
                  difficulty: { type: "string", enum: ["basic", "medium", "advanced"] },
                  extraInstructions: { type: "string", maxLength: 1000 },
                  materialVersionIds: {
                    type: "array",
                    maxItems: 20,
                    items: { type: "string", format: "uuid" },
                  },
                },
              },
            },
          },
        },
        responses: {
          "202": ok("Generation started", {
            type: "object",
            properties: {
              examId: { type: "string", format: "uuid" },
              status: { type: "string", enum: ["generating"] },
              source: { type: "string", enum: ["materials", "ai"] },
            },
          }),
          ...errors("400", "401", "403", "404", "503"),
        },
      },
    },
    "/Admin/exams/{examId}": {
      get: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Exam summary with its questions, options and sources",
        parameters: [pathUuid("examId")],
        responses: {
          "200": ok("Exam detail", {
            type: "object",
            properties: { exam: examSummary, questions: { type: "array", items: { type: "object" } } },
          }),
          ...errors("400", "401", "403", "404"),
        },
      },
      delete: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Delete a draft or failed exam and its own questions",
        parameters: [pathUuid("examId")],
        responses: {
          "204": { description: "Deleted" },
          ...errors("400", "401", "403", "404", "409"),
        },
      },
    },
    "/Admin/exams/{examId}/publish": {
      post: {
        tags: ["Admin"],
        security: [{ bearerAuth: [] }],
        summary: "Publish a draft exam, approving its remaining draft questions",
        parameters: [pathUuid("examId")],
        responses: {
          "200": ok("Published", {
            type: "object",
            properties: {
              examId: { type: "string", format: "uuid" },
              status: { type: "string", enum: ["published"] },
              questionCount: { type: "integer" },
              autoApprovedCount: { type: "integer" },
            },
          }),
          ...errors("400", "401", "403", "404", "409"),
        },
      },
    },
  },
} as const;
