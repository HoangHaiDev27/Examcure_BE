import type { AppConfig } from "../config.js";
import { AssistantUsageRepository } from "../db/assistant-usage.js";
import { ContentRepository } from "../db/content.js";
import type { AppDatabase } from "../db/database.js";
import { isAssistantConfigured } from "../integrations/env.js";
import {
  answerStudyQuestion,
  type AssistantAnswer,
  type AssistantContextChunk,
  type AssistantTurn,
} from "../integrations/openai.js";
import { retrieveMaterialChunks, type RetrievedChunk } from "../integrations/vector-search.js";
import { AppError } from "../lib/errors.js";

const MAX_SOURCES = 4;
const MAX_ANSWER_CHARS = 6000;
const EXCERPT_CHARS = 300;
const SHORT_QUERY_CHARS = 40;
const RETRIEVAL_LIMIT = 8;

export type AssistantSource = {
  versionId: string;
  materialTitle: string;
  originalFilename: string;
  slideNumber: number;
  excerpt: string;
};
export type AssistantChatResult = {
  answer: string;
  grounded: boolean;
  sources: AssistantSource[];
  subject: { id: string; schoolCode: string; code: string; name: string } | null;
  remainingToday: number;
};
type VersionInfo = { materialTitle: string; originalFilename: string };

const unitOf = (filename: string): "slide" | "phần" => (filename.toLowerCase().endsWith(".docx") ? "phần" : "slide");

/** Last user message, prefixed with the previous user message when it is too short to retrieve on. */
export function retrievalQuery(messages: AssistantTurn[]): string {
  const users = messages.filter((m) => m.role === "user");
  const last = users[users.length - 1]?.content ?? "";
  const previous = users[users.length - 2]?.content;
  return last.length < SHORT_QUERY_CHARS && previous ? `${previous}\n${last}` : last;
}

/** Server-side source selection: never trusts the model beyond the ids it picked from what was retrieved. */
export function finalizeAnswer(
  model: AssistantAnswer,
  retrieved: RetrievedChunk[],
  versions: Map<string, VersionInfo>,
  subjectMode: boolean,
): { answer: string; grounded: boolean; sources: AssistantSource[] } {
  const byId = new Map(retrieved.map((c) => [c.chunk_id, c]));
  const seen = new Set<string>();
  const sources: AssistantSource[] = [];
  for (const id of model.source_chunk_ids) {
    const chunk = byId.get(id);
    const info = chunk && versions.get(chunk.material_version_id);
    if (!chunk || !info) continue;
    const key = `${chunk.material_version_id}:${chunk.slide_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      versionId: chunk.material_version_id,
      materialTitle: info.materialTitle,
      originalFilename: info.originalFilename,
      slideNumber: chunk.slide_number,
      excerpt: chunk.content.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS),
    });
    if (sources.length >= MAX_SOURCES) break;
  }
  const grounded = subjectMode && model.grounded && sources.length > 0;
  return {
    answer: model.answer.trim().slice(0, MAX_ANSWER_CHARS),
    grounded,
    sources: grounded ? sources : [],
  };
}

/** Fixed-vocabulary description of a failure: parse errors, error name and upstream HTTP status only. */
export function describeFailure(error: unknown): string {
  if (error instanceof SyntaxError) return "unparseable model output";
  if (!(error instanceof Error)) return "unknown";
  const status = error.message.match(/^OpenAI API (\d{3})/)?.[1];
  return status ? `${error.name} upstream status ${status}` : error.name;
}

export class AssistantService {
  private readonly usage: AssistantUsageRepository;
  private readonly content: ContentRepository;
  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
  ) {
    this.usage = new AssistantUsageRepository(db);
    this.content = new ContentRepository(db);
  }

  async getUsage(userId: string, now = new Date()) {
    const limit = this.config.ASSISTANT_DAILY_LIMIT;
    const u = await this.usage.assistantUsage(userId, now, limit);
    return { available: isAssistantConfigured(), limit, used: u.used, remainingToday: u.remaining };
  }

  async chat(
    userId: string,
    input: { subjectId?: string | undefined; messages: AssistantTurn[] },
    now = new Date(),
  ): Promise<AssistantChatResult> {
    // Everything that does not need quota is checked first so it never consumes any.
    if (!isAssistantConfigured())
      throw new AppError(503, "Trợ lý AI chưa được cấu hình.", "AI_UNAVAILABLE");
    const subject = input.subjectId ? await this.db.findOne("subjects", { id: input.subjectId }) : null;
    if (input.subjectId && !subject) throw new AppError(404, "Không tìm thấy môn học.", "NOT_FOUND");

    const limit = this.config.ASSISTANT_DAILY_LIMIT;
    const reservation = await this.usage.reserveAssistantQuota(userId, now, limit);
    if (!reservation.ok)
      throw new AppError(
        429,
        `Bạn đã dùng hết ${limit} câu hỏi hôm nay. Hạn mức sẽ được làm mới lúc 0 giờ.`,
        "ASSISTANT_QUOTA_EXCEEDED",
        { remainingToday: 0 },
      );
    try {
      let retrieved: RetrievedChunk[] = [];
      const versions = new Map<string, VersionInfo>();
      if (subject) {
        const ready = await this.content.subjectReadyVersions(subject.id);
        if (ready.length) {
          const materials = await this.db.find("materials", { subject_id: subject.id });
          const titles = new Map(materials.map((m) => [m.id as string, m.title as string]));
          for (const v of ready)
            versions.set(v.id as string, {
              materialTitle: titles.get(v.material_id as string) ?? (v.original_filename as string),
              originalFilename: v.original_filename as string,
            });
          retrieved = await retrieveMaterialChunks({
            query: retrievalQuery(input.messages),
            subjectId: subject.id,
            materialVersionIds: [...versions.keys()],
            limit: RETRIEVAL_LIMIT,
          });
        }
      }
      const chunks: AssistantContextChunk[] = retrieved.flatMap((c) => {
        const info = versions.get(c.material_version_id);
        return info
          ? [{
              chunkId: c.chunk_id,
              documentTitle: info.materialTitle,
              unit: unitOf(info.originalFilename),
              slideNumber: c.slide_number,
              content: c.content,
            }]
          : [];
      });
      const model = await answerStudyQuestion({
        messages: input.messages,
        chunks,
        ...(subject ? { subjectName: `${subject.display_code ?? subject.code} - ${subject.name}` } : {}),
      });
      const final = finalizeAnswer(model, retrieved, versions, Boolean(subject));
      return {
        ...final,
        subject: subject
          ? {
              id: subject.id,
              schoolCode: subject.school_code,
              code: subject.display_code ?? subject.code,
              name: subject.name,
            }
          : null,
        remainingToday: reservation.remaining,
      };
    } catch (error) {
      await this.usage.refundAssistantQuota(userId, reservation.day).catch(() => undefined);
      // Never log message bodies (they may echo student text) or leak upstream text to the client.
      console.error("assistant upstream failure:", describeFailure(error));
      throw new AppError(502, "Trợ lý AI đang bận, vui lòng thử lại sau ít phút.", "ASSISTANT_UPSTREAM_FAILED");
    }
  }
}
