import { describe, expect, it } from "vitest";
import { describeFailure, finalizeAnswer, retrievalQuery } from "./assistant.service.js";

describe("retrievalQuery", () => {
  it("uses the last user message, adding the previous one when it is short", () => {
    const long = "Hãy giải thích chi tiết về con trỏ trong ngôn ngữ C và cách sử dụng";
    expect(retrievalQuery([{ role: "user", content: long }])).toBe(long);
    expect(
      retrievalQuery([
        { role: "user", content: "Con trỏ là gì?" },
        { role: "assistant", content: "..." },
        { role: "user", content: "Ví dụ?" },
      ]),
    ).toBe("Con trỏ là gì?\nVí dụ?");
    expect(
      retrievalQuery([
        { role: "user", content: "x" },
        { role: "assistant", content: "..." },
        { role: "user", content: long },
      ]),
    ).toBe(long);
  });
});

describe("describeFailure", () => {
  it("never includes message bodies", () => {
    expect(describeFailure(new SyntaxError('Unexpected token "tin nhắn bí mật"'))).toBe("unparseable model output");
    expect(describeFailure(new Error("OpenAI API 500: echo of student text"))).toBe("Error upstream status 500");
    expect(describeFailure(new Error("vector down with student text"))).toBe("Error");
    expect(describeFailure("x")).toBe("unknown");
  });
});

describe("finalizeAnswer", () => {
  const versions = new Map([["v1", { materialTitle: "T", originalFilename: "a.pptx" }]]);
  const c = (id: string, slide: number) => ({ chunk_id: id, material_id: "m", material_version_id: "v1", subject_id: "s", slide_number: slide, content: "x".repeat(500), score: 1 });
  it("caps sources at 4, dedupes by slide, truncates excerpt and answer", () => {
    const retrieved = [1, 2, 3, 4, 5, 6].map((n) => c(`c${n}`, n)).concat([c("dup", 1)]);
    const r = finalizeAnswer({ answer: "a".repeat(7000), grounded: true, source_chunk_ids: ["dup", "c1", "c2", "c3", "c4", "c5"] }, retrieved, versions, true);
    expect(r.sources.map((s) => s.slideNumber)).toEqual([1, 2, 3, 4]);
    expect(r.sources[0]!.excerpt).toHaveLength(300);
    expect(r.answer).toHaveLength(6000);
    expect(r.grounded).toBe(true);
  });
  it("is never grounded without a subject", () => {
    const r = finalizeAnswer({ answer: "a", grounded: true, source_chunk_ids: ["c1"] }, [c("c1", 1)], versions, false);
    expect(r).toEqual({ answer: "a", grounded: false, sources: [] });
  });
});
