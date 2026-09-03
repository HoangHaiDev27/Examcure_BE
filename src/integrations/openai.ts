import { requireIntegrationEnv } from "./env.js";

const OPENAI_API_BASE = "https://api.openai.com/v1";

async function openAIRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${OPENAI_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireIntegrationEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiError = payload as { error?: { message?: string; code?: string } };
    throw new Error(
      `OpenAI API ${response.status}: ${apiError.error?.message || apiError.error?.code || "Unknown error"}`,
    );
  }
  return payload as T;
}

export async function createEmbeddings(inputs: string[]): Promise<number[][]> {
  const result = await openAIRequest<{
    data: Array<{ index: number; embedding: number[] }>;
  }>("/embeddings", {
    model: requireIntegrationEnv("OPENAI_EMBEDDING_MODEL"),
    input: inputs,
    encoding_format: "float",
  });
  return [...result.data]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

export type GeneratedQuestion = {
  prompt: string;
  options: string[];
  correct_index: number;
  explanation: string;
  difficulty: "basic" | "medium" | "advanced";
  source_chunk_ids: string[];
};

type ResponsePayload = {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

export function extractResponseText(result: ResponsePayload): string {
  return (result.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

export async function generateQuestionsFromContext(input: {
  subjectName: string;
  count: number;
  difficulty: "basic" | "medium" | "advanced";
  extraInstructions?: string;
  chunks: Array<{ chunkId: string; slideNumber: number; content: string }>;
}): Promise<GeneratedQuestion[]> {
  const sourceContext = input.chunks
    .map((chunk) => `[chunk_id=${chunk.chunkId}; slide=${chunk.slideNumber}]\n${chunk.content}`)
    .join("\n\n---\n\n");
  const result = await openAIRequest<ResponsePayload>("/responses", {
    model: requireIntegrationEnv("OPENAI_QUESTION_MODEL"),
    store: false,
    reasoning: { effort: "none" },
    instructions:
      "Bạn là chuyên gia khảo thí đại học. Chỉ tạo câu hỏi dựa trên ngữ cảnh được cung cấp. Không suy đoán kiến thức ngoài nguồn. Mỗi câu phải có đúng một đáp án đúng, ba phương án nhiễu hợp lý, lời giải ngắn và ít nhất một source_chunk_id có thật trong ngữ cảnh.",
    input: `Môn học: ${input.subjectName}\nĐộ khó: ${input.difficulty}\nSố câu: ${input.count}\nYêu cầu thêm: ${input.extraInstructions || "Không có"}\n\nNGỮ CẢNH NGUỒN:\n${sourceContext}`,
    text: {
      format: {
        type: "json_schema",
        name: "exam_question_batch",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["questions"],
          properties: {
            questions: {
              type: "array",
              minItems: input.count,
              maxItems: input.count,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["prompt", "options", "correct_index", "explanation", "difficulty", "source_chunk_ids"],
                properties: {
                  prompt: { type: "string", minLength: 8 },
                  options: { type: "array", minItems: 4, maxItems: 4, items: { type: "string", minLength: 1 } },
                  correct_index: { type: "integer", minimum: 0, maximum: 3 },
                  explanation: { type: "string", minLength: 8 },
                  difficulty: { type: "string", enum: ["basic", "medium", "advanced"] },
                  source_chunk_ids: { type: "array", minItems: 1, items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  });
  const outputText = extractResponseText(result);
  if (!outputText) throw new Error("OpenAI did not return question output text");
  const parsed = JSON.parse(outputText) as { questions?: GeneratedQuestion[] };
  if (!Array.isArray(parsed.questions) || parsed.questions.length !== input.count) {
    throw new Error("OpenAI returned an unexpected question count");
  }
  return parsed.questions;
}
