import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { generateQuestionsFromContext } from "../integrations/openai.js";
import { getStorageBuckets, getSupabaseAdmin } from "../integrations/supabase.js";
import { retrieveMaterialChunks } from "../integrations/vector-search.js";
import { AppError } from "../lib/errors.js";
import { requireSupabaseAdmin } from "./supabase-admin.middleware.js";
import { validateBody } from "./validation.js";

type Difficulty = "basic" | "medium" | "advanced";
const uuid = z.string().uuid();
const asyncHandler = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
const admin = (req: Express.Request) => {
  if (!req.adminIdentity) throw new AppError(401, "Bạn cần đăng nhập.", "AUTH_REQUIRED");
  return req.adminIdentity;
};

const materialSchema = z.object({
  subjectId: uuid,
  materialId: uuid.optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
});
const subjectSchema = z.object({
  schoolCode: z.string().trim().min(1).max(50),
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
});

function safeFileName(name: string): string {
  return name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(-120);
}

export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireSupabaseAdmin);

  router.get("/overview", asyncHandler(async (req, res) => {
    const identity = admin(req);
    const supabase = getSupabaseAdmin();
    const [subjects, materials, runs, questions, exams] = await Promise.all([
      supabase.from("subjects").select("id, school_code, code, name").order("code"),
      supabase.from("materials").select("id, subject_id, title, created_at, material_versions(id, version_number, status, original_filename, slide_count, error_message, created_at)").order("created_at", { ascending: false }),
      supabase.from("generation_runs").select("id, subject_id, status, question_count, difficulty, error_message, created_at").order("created_at", { ascending: false }).limit(20),
      supabase.from("questions").select("id, subject_id, prompt, explanation, difficulty, status, created_at, question_options(id, position, content, is_correct), question_sources(id, slide_number, chunk_id, excerpt)").order("created_at", { ascending: false }).limit(100),
      supabase.from("exams").select("id, subject_id, title, duration_minutes, status, created_at, exam_questions(question_id, position)").order("created_at", { ascending: false }).limit(30),
    ]);
    const firstError = [subjects, materials, runs, questions, exams].find((result) => result.error)?.error;
    if (firstError) throw firstError;
    res.json({
      admin: identity,
      subjects: subjects.data ?? [],
      materials: materials.data ?? [],
      generationRuns: runs.data ?? [],
      questions: questions.data ?? [],
      exams: exams.data ?? [],
    });
  }));

  router.post("/subjects", validateBody(subjectSchema), asyncHandler(async (req, res) => {
    const identity = admin(req);
    const { schoolCode, code, name, description } = req.body as z.infer<typeof subjectSchema>;
    const { data, error } = await getSupabaseAdmin().from("subjects").upsert({
      school_code: schoolCode.toLowerCase(),
      code: code.toUpperCase(),
      name,
      description: description || null,
      created_by: identity.bootstrap ? null : identity.id,
    }, { onConflict: "school_code,code" }).select("id, school_code, code, name").single();
    if (error) throw error;
    res.status(201).json({ subject: data });
  }));

  router.post("/materials", validateBody(materialSchema), asyncHandler(async (req, res) => {
    const identity = admin(req);
    const body = req.body as z.infer<typeof materialSchema>;
    const fileName = safeFileName(body.fileName);
    const extension = fileName.toLowerCase().split(".").pop();
    const allowedMime = new Set([
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/octet-stream",
    ]);
    if (!fileName || !["ppt", "pptx"].includes(extension || "") || !allowedMime.has(body.mimeType)) {
      throw new AppError(400, "Chỉ chấp nhận file PowerPoint .ppt hoặc .pptx.", "INVALID_FILE");
    }
    const supabase = getSupabaseAdmin();
    const actorId = identity.bootstrap ? null : identity.id;
    let materialId = body.materialId;
    if (materialId) {
      const { data, error } = await supabase.from("materials").select("id, subject_id").eq("id", materialId).single();
      if (error || data.subject_id !== body.subjectId) throw new AppError(400, "Tài liệu không thuộc môn học đã chọn.", "INVALID_MATERIAL");
    } else {
      const { data, error } = await supabase.from("materials").insert({
        subject_id: body.subjectId,
        title: body.title,
        description: body.description || null,
        created_by: actorId,
      }).select("id").single();
      if (error) throw error;
      materialId = data.id;
    }
    const { data: versions, error: versionError } = await supabase.from("material_versions").select("version_number").eq("material_id", materialId).order("version_number", { ascending: false }).limit(1);
    if (versionError) throw versionError;
    const versionId = randomUUID();
    const versionNumber = (versions?.[0]?.version_number || 0) + 1;
    const bucket = getStorageBuckets().originals;
    const path = `${body.subjectId}/${materialId}/${versionId}/${fileName}`;
    const { error: insertError } = await supabase.from("material_versions").insert({
      id: versionId,
      material_id: materialId,
      version_number: versionNumber,
      original_bucket: bucket,
      original_path: path,
      original_filename: fileName,
      mime_type: body.mimeType,
      size_bytes: body.sizeBytes,
      created_by: actorId,
    });
    if (insertError) throw insertError;
    const { data: signed, error: signedError } = await supabase.storage.from(bucket).createSignedUploadUrl(path, { upsert: false });
    if (signedError) throw signedError;
    res.status(201).json({ materialId, versionId, versionNumber, bucket, path, token: signed.token });
  }));

  router.post("/materials/:versionId/complete-upload", asyncHandler(async (req, res) => {
    admin(req);
    const versionId = uuid.parse(req.params.versionId);
    const supabase = getSupabaseAdmin();
    const { data: version, error } = await supabase.from("material_versions").select("id, status, original_bucket, original_path").eq("id", versionId).single();
    if (error || !version) throw new AppError(404, "Không tìm thấy phiên bản tài liệu.", "NOT_FOUND");
    const pathParts = version.original_path.split("/");
    const fileName = pathParts.pop() || "";
    const { data: objects, error: listError } = await supabase.storage.from(version.original_bucket).list(pathParts.join("/"), { search: fileName, limit: 2 });
    if (listError) throw listError;
    if (!objects?.some((item) => item.name === fileName)) throw new AppError(409, "File chưa được upload hoàn tất.", "UPLOAD_INCOMPLETE");
    const { error: updateError } = await supabase.from("material_versions").update({ status: "uploaded", error_message: null }).eq("id", versionId);
    if (updateError) throw updateError;
    const { data: existing } = await supabase.from("processing_jobs").select("id").eq("job_type", "material_ingestion").in("status", ["queued", "running"]).contains("payload", { material_version_id: versionId }).maybeSingle();
    let jobId = existing?.id;
    if (!jobId) {
      const { data: job, error: jobError } = await supabase.from("processing_jobs").insert({ job_type: "material_ingestion", payload: { material_version_id: versionId } }).select("id").single();
      if (jobError) throw jobError;
      jobId = job.id;
    }
    res.json({ versionId, jobId, status: "queued" });
  }));

  const generationSchema = z.object({
    subjectId: uuid,
    materialVersionIds: z.array(uuid).min(1).max(20),
    questionCount: z.number().int().min(1).max(20),
    difficulty: z.enum(["basic", "medium", "advanced"]),
    extraInstructions: z.string().trim().max(1000).optional(),
  });
  router.post("/question-generation", validateBody(generationSchema), asyncHandler(async (req, res) => {
    const identity = admin(req);
    const body = req.body as z.infer<typeof generationSchema>;
    const versionIds = [...new Set(body.materialVersionIds)];
    const supabase = getSupabaseAdmin();
    let runId: string | null = null;
    try {
      const { data: subject, error: subjectError } = await supabase.from("subjects").select("id, code, name").eq("id", body.subjectId).single();
      if (subjectError || !subject) throw new AppError(404, "Không tìm thấy môn học.", "NOT_FOUND");
      const { data: versions, error: versionsError } = await supabase.from("material_versions").select("id, materials!inner(subject_id)").in("id", versionIds).eq("status", "ready").eq("materials.subject_id", body.subjectId);
      if (versionsError) throw versionsError;
      if (versions?.length !== versionIds.length) throw new AppError(400, "Có tài liệu chưa xử lý xong hoặc không thuộc môn đã chọn.", "INVALID_MATERIAL");
      const { data: run, error: runError } = await supabase.from("generation_runs").insert({
        subject_id: body.subjectId,
        requested_by: identity.bootstrap ? null : identity.id,
        status: "retrieving",
        question_count: body.questionCount,
        difficulty: body.difficulty,
        material_version_ids: versionIds,
        extra_instructions: body.extraInstructions || null,
        model: process.env.OPENAI_QUESTION_MODEL,
      }).select("id").single();
      if (runError) throw runError;
      runId = run.id;
      const chunks = await retrieveMaterialChunks({
        query: `${subject.code} ${subject.name}. ${body.extraInstructions || "Kiến thức trọng tâm để tạo đề thi"}`,
        subjectId: body.subjectId,
        materialVersionIds: versionIds,
        limit: Math.min(Math.max(body.questionCount * 4, 12), 40),
      });
      const fallbackChunk = chunks[0];
      if (!fallbackChunk || chunks.length < 2) throw new Error("Không tìm thấy đủ nội dung vector để tạo câu hỏi.");
      await supabase.from("generation_runs").update({ status: "generating", retrieved_chunk_count: chunks.length }).eq("id", runId);
      const generationInput = {
        subjectName: `${subject.code} - ${subject.name}`,
        count: body.questionCount,
        difficulty: body.difficulty as Difficulty,
        chunks: chunks.map((chunk) => ({ chunkId: chunk.chunk_id, slideNumber: chunk.slide_number, content: chunk.content })),
        ...(body.extraInstructions ? { extraInstructions: body.extraInstructions } : {}),
      };
      const generated = await generateQuestionsFromContext(generationInput);
      const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
      const questions = generated.map((question) => {
        const matched = question.source_chunk_ids.map((id) => chunkById.get(id)).filter((chunk): chunk is typeof fallbackChunk => Boolean(chunk));
        const sources = matched.length ? matched : [fallbackChunk];
        return {
          prompt: question.prompt,
          explanation: question.explanation,
          difficulty: question.difficulty,
          options: question.options.map((content, position) => ({ position, content, is_correct: position === question.correct_index })),
          sources: sources.map((chunk) => ({ material_version_id: chunk.material_version_id, slide_number: chunk.slide_number, chunk_id: chunk.chunk_id, excerpt: chunk.content.slice(0, 500), retrieval_score: chunk.score })),
        };
      });
      const { data: savedCount, error: saveError } = await supabase.rpc("save_generated_questions", { p_run_id: runId, p_questions: questions });
      if (saveError) throw saveError;
      await supabase.from("audit_logs").insert({ actor_id: identity.bootstrap ? null : identity.id, action: "questions.generated", entity_type: "generation_run", entity_id: runId, details: { saved_count: savedCount, material_version_ids: versionIds } });
      res.status(201).json({ runId, savedCount, status: "completed" });
    } catch (error) {
      if (runId) await supabase.from("generation_runs").update({ status: "failed", error_message: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error", completed_at: new Date().toISOString() }).eq("id", runId);
      throw error;
    }
  }));

  const reviewSchema = z.object({
    status: z.enum(["draft", "approved", "rejected"]),
    prompt: z.string().trim().min(1).max(5000).optional(),
    explanation: z.string().trim().min(1).max(5000).optional(),
    options: z.array(z.object({ position: z.number().int().min(0).max(3), content: z.string().trim().min(1).max(2000), isCorrect: z.boolean() })).length(4).optional(),
  });
  router.patch("/questions/:questionId", validateBody(reviewSchema), asyncHandler(async (req, res) => {
    const identity = admin(req);
    const questionId = uuid.parse(req.params.questionId);
    const body = req.body as z.infer<typeof reviewSchema>;
    if (body.options) {
      if (new Set(body.options.map((option) => option.position)).size !== 4 || body.options.filter((option) => option.isCorrect).length !== 1) {
        throw new AppError(400, "Câu hỏi phải có 4 vị trí khác nhau và đúng một đáp án đúng.", "INVALID_OPTIONS");
      }
    }
    const supabase = getSupabaseAdmin();
    const updates: Record<string, unknown> = {
      status: body.status,
      updated_at: new Date().toISOString(),
      approved_by: body.status === "approved" && !identity.bootstrap ? identity.id : null,
      approved_at: body.status === "approved" ? new Date().toISOString() : null,
    };
    if (body.prompt) updates.prompt = body.prompt;
    if (body.explanation) updates.explanation = body.explanation;
    const { data, error } = await supabase.from("questions").update(updates).eq("id", questionId).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError(404, "Không tìm thấy câu hỏi.", "NOT_FOUND");
    if (body.options) {
      const { error: optionError } = await supabase.from("question_options").upsert(body.options.map((option) => ({ question_id: questionId, position: option.position, content: option.content, is_correct: option.isCorrect })), { onConflict: "question_id,position" });
      if (optionError) throw optionError;
    }
    await supabase.from("audit_logs").insert({ actor_id: identity.bootstrap ? null : identity.id, action: `question.${body.status}`, entity_type: "question", entity_id: questionId });
    res.json({ questionId, status: body.status });
  }));

  const examSchema = z.object({
    subjectId: uuid,
    title: z.string().trim().min(1).max(200),
    durationMinutes: z.number().int().positive().max(1440),
    questionIds: z.array(uuid).min(1).max(200),
    publish: z.boolean().default(false),
  });
  router.post("/exams", validateBody(examSchema), asyncHandler(async (req, res) => {
    const identity = admin(req);
    const body = req.body as z.infer<typeof examSchema>;
    const questionIds = [...new Set(body.questionIds)];
    const supabase = getSupabaseAdmin();
    const { data: questions, error } = await supabase.from("questions").select("id").eq("subject_id", body.subjectId).eq("status", "approved").in("id", questionIds);
    if (error) throw error;
    if (questions?.length !== questionIds.length) throw new AppError(400, "Đề chỉ được sử dụng câu hỏi đã được admin duyệt.", "INVALID_QUESTIONS");
    const { data: examId, error: examError } = await supabase.rpc("create_exam_with_questions", {
      p_subject_id: body.subjectId,
      p_title: body.title,
      p_duration_minutes: body.durationMinutes,
      p_question_ids: questionIds,
      p_publish: body.publish,
      p_created_by: identity.bootstrap ? null : identity.id,
    });
    if (examError) throw examError;
    const status = body.publish ? "published" : "draft";
    await supabase.from("audit_logs").insert({ actor_id: identity.bootstrap ? null : identity.id, action: body.publish ? "exam.published" : "exam.created", entity_type: "exam", entity_id: examId, details: { question_count: questionIds.length } });
    res.status(201).json({ examId, status });
  }));

  return router;
}
