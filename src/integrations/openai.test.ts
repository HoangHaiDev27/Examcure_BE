import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractResponseText, generateQuestions } from "./openai.js";

describe("extractResponseText", () => {
  it("reads nested output_text blocks returned by the Responses API", () => {
    expect(extractResponseText({
      output: [
        { type: "reasoning", content: [] },
        {
          type: "message",
          content: [
            { type: "output_text", text: '{"questions":[' },
            { type: "output_text", text: "]}" },
          ],
        },
      ],
    })).toBe('{"questions":[]}');
  });

  it("ignores non-text output and handles an empty payload", () => {
    expect(extractResponseText({ output: [{ type: "reasoning" }] })).toBe("");
    expect(extractResponseText({})).toBe("");
  });
});

describe("generateQuestions", () => {
  const q = { prompt: "Câu hỏi mẫu dài", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "Giải thích ngắn", difficulty: "basic" as const };
  const reply = (questions: unknown[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ questions }) }] }] }),
  });
  let fetchMock: ReturnType<typeof vi.fn>;
  const sent = () => {
    const init = fetchMock.mock.calls[0]![1] as { body: string; signal?: AbortSignal };
    return { ...JSON.parse(init.body), signal: init.signal };
  };
  const base = { subjectName: "PRF192 - Kỹ thuật lập trình C", count: 1, difficulty: "basic" as const };

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_QUESTION_MODEL", "test-model");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("grounded mode sends source context and requires source_chunk_ids", async () => {
    fetchMock.mockResolvedValue(reply([{ ...q, source_chunk_ids: ["c1"] }]));
    const out = await generateQuestions({ ...base, chunks: [{ chunkId: "c1", slideNumber: 3, content: "NOI DUNG" }] });
    const body = sent();
    expect(body.input).toContain("NGỮ CẢNH NGUỒN");
    expect(body.input).toContain("[chunk_id=c1; slide=3]\nNOI DUNG");
    const items = body.text.format.schema.properties.questions.items;
    expect(items.required).toContain("source_chunk_ids");
    expect(items.properties.source_chunk_ids.minItems).toBe(1);
    expect(out[0]!.source_chunk_ids).toEqual(["c1"]);
  });

  it("self-authored mode omits source_chunk_ids and source context", async () => {
    fetchMock.mockResolvedValue(reply([q]));
    const out = await generateQuestions({ ...base, subjectContext: "Khoa CNTT", chunks: [] });
    const body = sent();
    const items = body.text.format.schema.properties.questions.items;
    expect(items.required).not.toContain("source_chunk_ids");
    expect(items.properties.source_chunk_ids).toBeUndefined();
    expect(body.input).not.toContain("NGỮ CẢNH NGUỒN");
    expect(body.input).toContain("Khoa CNTT");
    expect(body.instructions).not.toContain("source_chunk_id");
    expect(out[0]!.source_chunk_ids).toEqual([]);
  });

  it("appends avoidPrompts truncated to 200 chars", async () => {
    fetchMock.mockResolvedValue(reply([q]));
    await generateQuestions({ ...base, avoidPrompts: ["x".repeat(300), "ngắn"] });
    const { input } = sent();
    expect(input).toContain("Không lặp lại hoặc diễn đạt lại các câu đã có:");
    expect(input).toContain(`- ${"x".repeat(200)}\n- ngắn`);
    expect(input).not.toContain("x".repeat(201));
  });

  it("rejects invalid counts without calling fetch", async () => {
    await expect(generateQuestions({ ...base, count: 0 })).rejects.toThrow();
    await expect(generateQuestions({ ...base, count: 11 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when the response count differs", async () => {
    fetchMock.mockResolvedValue(reply([q, q]));
    await expect(generateQuestions(base)).rejects.toThrow("unexpected question count");
  });

  it("passes an abort signal and maps timeouts", async () => {
    fetchMock.mockResolvedValue(reply([q]));
    await generateQuestions(base);
    expect(sent().signal).toBeDefined();
    fetchMock.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(generateQuestions(base)).rejects.toThrow("OpenAI API timeout");
  });
});
