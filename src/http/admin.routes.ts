import { Router, raw } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { ContentRepository } from "../db/content.js";
import type { FileStorage } from "../integrations/storage.js";
import type { TokenService } from "../services/token.service.js";
import { generateQuestions } from "../integrations/openai.js";
import { retrieveMaterialChunks } from "../integrations/vector-search.js";
import { AppError } from "../lib/errors.js";
import { ingestPptxMaterialVersion } from "../services/pptx-ingestion.service.js";
import { requireAuth, requireAdmin } from "./auth.middleware.js";
import { validateBody } from "./validation.js";
const uuid = z.string().uuid();
const materialSchema = z.object({
  subjectId: uuid,
  materialId: uuid.optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(200),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
});
const subjectSchema = z.object({
  schoolCode: z.string().trim().min(1).max(50),
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
});

function safeFileName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-120);
}

export function createAdminRouter(
  tokens: TokenService,
  db: AppDatabase,
  storage: FileStorage,
  config: AppConfig,
): Router {
  const router = Router(),
    repo = new ContentRepository(db);
  router.use(requireAuth(tokens, db), requireAdmin);
  router.get("/overview", async (req, res) =>
    res.json({ admin: req.adminIdentity, ...(await repo.overview()) }),
  );
  router.get("/users", async (_req, res) => {
    const rows = await db.find("users", {}, { created_at: -1 });
    res.json({
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        schoolId: u.school_id,
        role: u.role,
        createdAt: u.created_at,
      })),
    });
  });
  router.patch(
    "/users/:userId/role",
    validateBody(z.object({ role: z.enum(["student", "admin"]) })),
    async (req, res) => {
      const id = uuid.parse(req.params.userId);
      await repo.changeRole(req.userId!, id, req.body.role);
      res.json({ userId: id, role: req.body.role });
    },
  );
  router.post("/subjects", validateBody(subjectSchema), async (req, res) =>
    res
      .status(201)
      .json({ subject: await repo.createSubject(req.userId!, req.body) }),
  );
  router.post("/materials", validateBody(materialSchema), async (req, res) => {
    const body = req.body as z.infer<typeof materialSchema>,
      fileName = safeFileName(body.fileName);
    if (
      !fileName.toLowerCase().endsWith(".pptx") ||
      ![
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/octet-stream",
      ].includes(body.mimeType)
    )
      throw new AppError(
        400,
        "Chỉ chấp nhận file .pptx tối đa 20 MB.",
        "INVALID_FILE",
      );
    res
      .status(201)
      .json(await repo.createMaterial(req.userId!, { ...body, fileName }));
  });
  router.put(
    "/materials/:versionId/file",
    raw({ type: () => true, limit: "20mb" }),
    async (req, res) => {
      const versionId = uuid.parse(req.params.versionId);
      await db.transaction(async () => {
        const version = await repo.version(versionId);
        if (!version)
          throw new AppError(404, "Không tìm thấy tài liệu.", "NOT_FOUND");
        if (version.status !== "uploading")
          throw new AppError(
            409,
            "Phiên bản đã được upload.",
            "UPLOAD_ALREADY_COMPLETED",
          );
        if (
          !Buffer.isBuffer(req.body) ||
          req.body.length !== version.size_bytes
        )
          throw new AppError(
            400,
            "Dung lượng upload không khớp.",
            "INVALID_FILE_SIZE",
          );
        // Reject malformed ZIP/PPTX before allocating expensive ingestion work.
        if (req.body.length < 4 || req.body.readUInt32LE(0) !== 0x04034b50)
          throw new AppError(
            400,
            "File PowerPoint không hợp lệ.",
            "INVALID_FILE",
          );
        await storage.put(version.original_path, req.body, version.mime_type);
        await db.update(
          "material_versions",
          { id: versionId },
          { $set: { status: "uploaded", error_message: null } },
        );
      });
      res.json({ versionId, status: "uploaded" });
    },
  );
  router.post("/materials/:versionId/complete-upload", async (req, res) => {
    const versionId = uuid.parse(req.params.versionId);
    const claimed = await db.transaction(async () => {
      const version = await repo.version(versionId);
      if (!version)
        throw new AppError(404, "Không tìm thấy tài liệu.", "NOT_FOUND");
      if (version.status === "ready") return false;
      if (!["uploaded", "failed"].includes(version.status))
        throw new AppError(
          409,
          "File chưa upload hoặc đang xử lý.",
          "UPLOAD_INCOMPLETE",
        );
      if ((await storage.size(version.original_path)) !== version.size_bytes)
        throw new AppError(
          409,
          "File chưa upload hoàn tất.",
          "UPLOAD_INCOMPLETE",
        );
      await db.update(
        "material_versions",
        { id: versionId },
        { $set: { status: "processing", error_message: null } },
      );
      if (config.MATERIAL_PROCESSING_MODE === "worker")
        await repo.insert("processing_jobs", {
          job_type: "material_ingestion",
          payload: { material_version_id: versionId },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      return true;
    });
    if (!claimed) {
      const version = await repo.version(versionId);
      res.json({
        versionId,
        status: "ready",
        slideCount: version!.slide_count,
        chunkCount: 0,
      });
      return;
    }
    if (config.MATERIAL_PROCESSING_MODE === "worker") {
      res.status(202).json({ versionId, status: "processing" });
      return;
    }
    try {
      res.json({
        versionId,
        status: "ready",
        ...(await ingestPptxMaterialVersion(versionId, db, storage)),
      });
    } catch (error) {
      throw new AppError(
        422,
        "Không thể trích xuất/lập chỉ mục PowerPoint. Xem trạng thái tài liệu để biết lỗi.",
        "PPTX_PROCESSING_FAILED",
      );
    }
  });
  const generationSchema = z.object({
    subjectId: uuid,
    materialVersionIds: z.array(uuid).min(1).max(20),
    questionCount: z.number().int().min(1).max(20),
    difficulty: z.enum(["basic", "medium", "advanced"]),
    extraInstructions: z.string().trim().max(1000).optional(),
  });

  router.post(
    "/question-generation",
    validateBody(generationSchema),
    async (req, res) => {
      const body = req.body as z.infer<typeof generationSchema>,
        versionIds = [...new Set(body.materialVersionIds)];
      let runId: string | undefined;
      try {
        const subject = await db.findOne("subjects", { id: body.subjectId });
        if (!subject)
          throw new AppError(404, "Không tìm thấy môn học.", "NOT_FOUND");
        const versions = await repo.readyVersions(body.subjectId, versionIds);
        if (versions.length !== versionIds.length)
          throw new AppError(
            400,
            "Tài liệu chưa sẵn sàng hoặc không thuộc môn đã chọn.",
            "INVALID_MATERIAL",
          );
        runId = await repo.insert("generation_runs", {
          subject_id: body.subjectId,
          requested_by: req.userId!,
          status: "retrieving",
          question_count: body.questionCount,
          difficulty: body.difficulty,
          material_version_ids: versionIds,
          extra_instructions: body.extraInstructions || null,
          model: process.env.OPENAI_QUESTION_MODEL || null,
          created_at: new Date().toISOString(),
        });
        const chunks = await retrieveMaterialChunks({
          query: `${subject.code} ${subject.name}. ${body.extraInstructions || "Kiến thức trọng tâm để tạo đề thi"}`,
          subjectId: body.subjectId,
          materialVersionIds: versionIds,
          limit: Math.min(Math.max(body.questionCount * 4, 12), 40),
        });
        const fallback = chunks[0];
        if (!fallback || chunks.length < 2)
          throw new AppError(
            422,
            "Không tìm thấy đủ nội dung để tạo câu hỏi.",
            "INSUFFICIENT_CONTEXT",
          );
        await db.update(
          "generation_runs",
          { id: runId },
          {
            $set: {
              status: "generating",
              retrieved_chunk_count: chunks.length,
            },
          },
        );
        const generated = await generateQuestions({
          subjectName: `${subject.code} - ${subject.name}`,
          count: body.questionCount,
          difficulty: body.difficulty,
          chunks: chunks.map((c) => ({
            chunkId: c.chunk_id,
            slideNumber: c.slide_number,
            content: c.content,
          })),
          ...(body.extraInstructions
            ? { extraInstructions: body.extraInstructions }
            : {}),
        });
        const byId = new Map(chunks.map((c) => [c.chunk_id, c]));
        const questions = generated.map((q) => {
          const matches = q.source_chunk_ids
              .map((id) => byId.get(id))
              .filter((c): c is typeof fallback => Boolean(c)),
            sources = matches.length ? matches : [fallback];
          return {
            prompt: q.prompt,
            explanation: q.explanation,
            difficulty: q.difficulty,
            options: q.options.map((content, position) => ({
              position,
              content,
              is_correct: position === q.correct_index,
            })),
            sources: sources.map((c) => ({
              material_version_id: c.material_version_id,
              slide_number: c.slide_number,
              chunk_id: c.chunk_id,
              excerpt: c.content.slice(0, 500),
              retrieval_score: c.score,
            })),
          };
        });
        const savedCount = await repo.saveGenerated(
          runId,
          req.userId!,
          body.subjectId,
          questions,
        );
        res.status(201).json({ runId, savedCount, status: "completed" });
      } catch (error) {
        if (runId)
          await db.update(
            "generation_runs",
            { id: runId },
            {
              $set: {
                status: "failed",
                error_message:
                  error instanceof Error
                    ? error.message.slice(0, 1000)
                    : "Processing failed",
                completed_at: new Date().toISOString(),
              },
            },
          );
        throw error;
      }
    },
  );
  const reviewSchema = z.object({
    status: z.enum(["draft", "approved", "rejected"]),
    prompt: z.string().trim().min(1).max(5000).optional(),
    explanation: z.string().trim().min(1).max(5000).optional(),
    options: z
      .array(
        z.object({
          position: z.number().int().min(0).max(3),
          content: z.string().trim().min(1).max(2000),
          isCorrect: z.boolean(),
        }),
      )
      .length(4)
      .optional(),
  });

  router.patch(
    "/questions/:questionId",
    validateBody(reviewSchema),
    async (req, res) => {
      const id = uuid.parse(req.params.questionId),
        body = req.body as z.infer<typeof reviewSchema>;
      if (
        body.options &&
        (new Set(body.options.map((o) => o.position)).size !== 4 ||
          body.options.filter((o) => o.isCorrect).length !== 1)
      )
        throw new AppError(
          400,
          "Phải có 4 vị trí khác nhau và một đáp án đúng.",
          "INVALID_OPTIONS",
        );
      await repo.reviewQuestion(req.userId!, id, body);
      res.json({ questionId: id, status: body.status });
    },
  );
  const examSchema = z.object({
    subjectId: uuid,
    title: z.string().trim().min(1).max(200),
    durationMinutes: z.number().int().positive().max(1440),
    questionIds: z.array(uuid).min(1).max(200),
    publish: z.boolean().default(false),
  });

  router.post("/exams", validateBody(examSchema), async (req, res) =>
    res.status(201).json(await repo.createExam(req.userId!, req.body)),
  );
  return router;
}
