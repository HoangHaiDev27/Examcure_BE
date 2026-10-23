import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerStudyQuestion, buildAssistantInput, extractResponseText, generateQuestions, parseAssistantOutput } from "./openai.js";

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

describe("study assistant", () => {
  const turns = [
    { role: "user" as const, content: "Con trỏ là gì?" },
    { role: "assistant" as const, content: "Là biến lưu địa chỉ." },
    { role: "user" as const, content: "Cho ví dụ" },
  ];
  const chunk = { chunkId: "c1", documentTitle: "Bài 1", unit: "slide" as const, slideNumber: 3, content: "Nội dung" };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds a labelled transcript and context blocks", () => {
    const text = buildAssistantInput({ messages: turns, chunks: [chunk], subjectName: "PRF192 - C" });
    expect(text).toContain("Môn học: PRF192 - C");
    expect(text).toContain('[chunk_id=c1; tài liệu="Bài 1"; slide=3]\nNội dung');
    expect(text).toContain("Sinh viên: Con trỏ là gì?\nTrợ lý: Là biến lưu địa chỉ.\nSinh viên: Cho ví dụ");
    expect(buildAssistantInput({ messages: turns })).not.toContain("NGỮ CẢNH");
  });
  it("parses schema output and rejects empty answers", () => {
    expect(parseAssistantOutput('{"answer":"Xin chào","grounded":true,"source_chunk_ids":["a",1]}')).toEqual({ answer: "Xin chào", grounded: true, source_chunk_ids: ["a"] });
    expect(() => parseAssistantOutput('{"answer":"  ","grounded":false,"source_chunk_ids":[]}')).toThrow();
    expect(() => parseAssistantOutput("not json")).toThrow();
  });
  it("sends a strict, unstored Responses request with the chat model", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_QUESTION_MODEL", "q-model");
    vi.stubEnv("OPENAI_CHAT_MODEL", "chat-model");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: '{"answer":"ok","grounded":false,"source_chunk_ids":[]}' }] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await answerStudyQuestion({ messages: turns, chunks: [chunk] })).toEqual({ answer: "ok", grounded: false, source_chunk_ids: [] });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toMatchObject({ model: "chat-model", store: false, reasoning: { effort: "none" }, max_output_tokens: 1500 });
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.instructions).toContain("NGỮ CẢNH");
    vi.stubEnv("OPENAI_CHAT_MODEL", "");
    await answerStudyQuestion({ messages: turns });
    const second = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
    expect(second.model).toBe("q-model");
    expect(second.instructions).toContain("Không có tài liệu");
  });
});
