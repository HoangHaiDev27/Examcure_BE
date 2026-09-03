import { describe, expect, it } from "vitest";
import { extractResponseText } from "./openai.js";

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
