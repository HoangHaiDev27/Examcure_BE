import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { chunkSlideText, extractPptxText, extractTextFromXml } from "./pptx.js";

describe("PPTX text extraction", () => {
  it("decodes PowerPoint XML text entities", () => {
    expect(extractTextFromXml('<a:t>Chương &amp; 1: &lt;Mở đầu&gt;</a:t>')).toEqual(["Chương & 1: <Mở đầu>"]);
  });

  it("reads slide text and matching speaker notes from a PPTX archive", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", '<p:sld><a:t>Slide hai</a:t></p:sld>');
    zip.file("ppt/slides/slide1.xml", '<p:sld><a:t>Slide một</a:t><a:t>Nội dung</a:t></p:sld>');
    zip.file("ppt/notesSlides/notesSlide1.xml", '<p:notes><a:t>Ghi chú một</a:t></p:notes>');
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    await expect(extractPptxText(buffer)).resolves.toEqual([
      { slideNumber: 1, text: "Slide một Nội dung", notes: "Ghi chú một" },
      { slideNumber: 2, text: "Slide hai", notes: "" },
    ]);
  });

  it("makes overlapping chunks so long slide text remains searchable", () => {
    const text = `${"Đây là nội dung trọng tâm. ".repeat(90)}Kết thúc.`;
    const chunks = chunkSlideText(text, 300, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true);
    expect(chunks.at(-1)).toContain("Kết thúc.");
    expect(chunks[1]).toContain(chunks[0].slice(-30));
  });
});
