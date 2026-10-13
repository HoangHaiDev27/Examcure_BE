import { randomUUID } from "node:crypto";
import type { AppDatabase, DataRow } from "../db/database.js";
import { ContentRepository } from "../db/content.js";
import { generateQuestions } from "../integrations/openai.js";
import {
  retrieveMaterialChunks,
  type RetrievedChunk,
} from "../integrations/vector-search.js";
import { AppError } from "../lib/errors.js";

export type ExamGenerationRequest = {
  subjectId: string;
  title: string;
  durationMinutes: number;
  questionCount: number;
  difficulty: "basic" | "medium" | "advanced";
  extraInstructions?: string | undefined;
  materialVersionIds?: string[] | undefined;
};

const BATCH_SIZE = 10;
const GENERIC_FAILURE = "AI chưa soạn được đề. Thử lại sau ít phút.";
const inFlight = new Set<Promise<void>>();
const now = () => new Date().toISOString();

export async function waitForExamGenerations(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

type PreparedQuestion = {
  prompt: string;
  explanation: string;
  difficulty: string;
  options: Array<{ position: number; content: string; is_correct: boolean }>;
  sources: Array<{
    material_version_id: string;
    slide_number: number;
    chunk_id: string;
    excerpt: string;
    retrieval_score: number;
  }>;
};

/** Validates the request, records the exam as `generating` and starts the background run. */
export async function requestExamGeneration(
  db: AppDatabase,
  actor: string,
  body: ExamGenerationRequest,
): Promise<{ examId: string; status: "generating"; source: "materials" | "ai" }> {
  const repo = new ContentRepository(db);
  const subject = await db.findOne("subjects", { id: body.subjectId });
  if (!subject) throw new AppError(404, "Không tìm thấy môn học.", "NOT_FOUND");
  const versionIds = [...new Set(body.materialVersionIds ?? [])];
  const ready = await repo.subjectReadyVersions(body.subjectId);
  let source: "materials" | "ai";
  if (ready.length) {
    if (!versionIds.length)
      throw new AppError(
        400,
        "Chọn ít nhất một tài liệu làm nguồn.",
        "SOURCE_REQUIRED",
      );
    const readyIds = new Set(ready.map((v) => v.id as string));
    if (versionIds.some((id) => !readyIds.has(id)))
      throw new AppError(
        400,
        "Tài liệu chưa sẵn sàng hoặc không thuộc môn đã chọn.",
        "INVALID_MATERIAL",
      );
    source = "materials";
  } else {
    if (versionIds.length)
      throw new AppError(
        400,
        "Môn này chưa có tài liệu đã lập chỉ mục.",
        "INVALID_MATERIAL",
      );
    source = "ai";
  }
  const examId = randomUUID(),
    runId = randomUUID(),
    timestamp = now();
  await db.transaction(async () => {
    await repo.insert("generation_runs", {
      id: runId,
      subject_id: body.subjectId,
      exam_id: examId,
      source,
      requested_by: actor,
      status: "generating",
      question_count: body.questionCount,
      difficulty: body.difficulty,
      material_version_ids: versionIds,
      extra_instructions: body.extraInstructions || null,
      model: process.env.OPENAI_QUESTION_MODEL || null,
      created_at: timestamp,
    });
    await repo.insert("exams", {
      id: examId,
      status: "generating",
      title: body.title,
      duration_minutes: body.durationMinutes,
      subject_id: body.subjectId,
      source,
      difficulty: body.difficulty,
      requested_count: body.questionCount,
      source_version_ids: versionIds,
      extra_instructions: body.extraInstructions || null,
      generation_run_id: runId,
      error_message: null,
      exam_questions: [],
      created_by: actor,
      created_at: timestamp,
      updated_at: timestamp,
      published_at: null,
    });
    await repo.audit(actor, "exam.generation_started", "exam", examId, {
      source,
      requested_count: body.questionCount,
    });
  });
  const task: Promise<void> = runGeneration(db, repo, {
    examId,
    runId,
    actor,
    subject,
    source,
    versionIds,
    body,
  })
    .catch(() => {})
    .finally(() => inFlight.delete(task));
  inFlight.add(task);
  return { examId, status: "generating", source };
}

async function runGeneration(
  db: AppDatabase,
  repo: ContentRepository,
  ctx: {
    examId: string;
    runId: string;
    actor: string;
    subject: DataRow;
    source: "materials" | "ai";
    versionIds: string[];
    body: ExamGenerationRequest;
  },
): Promise<void> {
  const { examId, runId, actor, subject, source, versionIds, body } = ctx;
  try {
    let chunks: RetrievedChunk[] = [];
    if (source === "materials") {
      chunks = await retrieveMaterialChunks({
        query: `${subject.code} ${subject.name}. ${body.extraInstructions || "Kiến thức trọng tâm để tạo đề thi"}`,
        subjectId: body.subjectId,
        materialVersionIds: versionIds,
        limit: 40,
      });
      if (chunks.length < 2)
        throw new AppError(
          422,
          "Tài liệu đã chọn có quá ít nội dung để AI soạn đề.",
          "INSUFFICIENT_CONTEXT",
        );
    }
    const fallback = chunks[0];
    const subjectName = `${subject.display_code ?? subject.code} - ${subject.name}`;
    const contextLines = [
      subject.faculty ? `Khoa: ${subject.faculty}` : null,
      subject.description ? `Mô tả: ${subject.description}` : null,
    ].filter((l): l is string => Boolean(l));
    const byId = new Map(chunks.map((c) => [c.chunk_id, c]));
    const prepared: PreparedQuestion[] = [];
    const prompts: string[] = [];
    for (
      let remaining = body.questionCount;
      remaining > 0;
      remaining -= BATCH_SIZE
    ) {
      const generated = await generateQuestions({
        subjectName,
        ...(source === "ai" && contextLines.length
          ? { subjectContext: contextLines.join("\n") }
          : {}),
        count: Math.min(BATCH_SIZE, remaining),
        difficulty: body.difficulty,
        ...(body.extraInstructions
          ? { extraInstructions: body.extraInstructions }
          : {}),
        ...(source === "materials"
          ? {
              chunks: chunks.map((c) => ({
                chunkId: c.chunk_id,
                slideNumber: c.slide_number,
                content: c.content,
              })),
            }
          : {}),
        avoidPrompts: [...prompts],
      });
      for (const q of generated) {
        const matches = (q.source_chunk_ids ?? [])
          .map((id) => byId.get(id))
          .filter((c): c is RetrievedChunk => Boolean(c));
        const sources =
          source === "ai" ? [] : matches.length ? matches : fallback ? [fallback] : [];
        prompts.push(q.prompt);
        prepared.push({
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
        });
      }
    }
    await db.transaction(async () => {
      const exam = await db.findOne("exams", { id: examId });
      const timestamp = now();
      if (exam?.status !== "generating") {
        await db.update(
          "generation_runs",
          { id: runId },
          {
            $set: {
              status: "failed",
              error_message: "Exam is no longer generating",
              completed_at: timestamp,
            },
          },
        );
        return;
      }
      const links: DataRow[] = [];
      for (const q of prepared) {
        const id = randomUUID();
        await repo.insert("questions", {
          id,
          exam_id: examId,
          generation_run_id: runId,
          subject_id: body.subjectId,
          prompt: q.prompt,
          explanation: q.explanation,
          difficulty: q.difficulty,
          status: "draft",
          created_by: actor,
          created_at: timestamp,
          updated_at: timestamp,
          question_options: q.options.map((o) => ({
            ...o,
            id: randomUUID(),
            question_id: id,
          })),
          question_sources: [
            ...new Map(q.sources.map((s) => [s.chunk_id, s])).values(),
          ].map((s) => ({ ...s, id: randomUUID(), question_id: id })),
        });
        links.push({
          exam_id: examId,
          question_id: id,
          position: links.length + 1,
          points: 1,
        });
      }
      await db.update(
        "exams",
        { id: examId },
        {
          $set: { status: "draft", exam_questions: links, updated_at: timestamp },
        },
      );
      await db.update(
        "generation_runs",
        { id: runId },
        {
          $set: {
            status: "completed",
            completed_at: timestamp,
            retrieved_chunk_count: chunks.length,
          },
        },
      );
      await repo.audit(actor, "exam.generated", "exam", examId, {
        question_count: links.length,
      });
    });
  } catch (error) {
    try {
      const timestamp = now();
      await db.update(
        "exams",
        { id: examId, status: "generating" },
        {
          $set: {
            status: "failed",
            error_message:
              error instanceof AppError ? error.message : GENERIC_FAILURE,
            updated_at: timestamp,
          },
        },
      );
      await db.update(
        "generation_runs",
        { id: runId },
        {
          $set: {
            status: "failed",
            error_message: (error instanceof Error
              ? error.message
              : "Processing failed"
            ).slice(0, 1000),
            completed_at: timestamp,
          },
        },
      );
    } catch {
      // Never let a bookkeeping failure become an unhandled rejection.
    }
  }
}
