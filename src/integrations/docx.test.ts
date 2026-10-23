import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractDocxSections } from "./docx.js";

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
async function docx(body: string) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document ${NS}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractDocxSections", () => {
  it("splits on Heading 1/2", async () => {
    const s = await extractDocxSections(await docx(p("Intro", "Heading1") + p("a") + p("Sub", "heading2") + p("b") + p("c", "Heading3")));
    expect(s.map((x) => x.slideNumber)).toEqual([1, 2]);
    expect(s[0]!.text).toBe("Intro\na");
    expect(s[1]!.text).toBe("Sub\nb\nc");
    expect(s[0]!.notes).toBe("");
  });
  it("splits on explicit page breaks", async () => {
    const s = await extractDocxSections(await docx(`<w:p><w:r><w:t>one</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>` + p("two")));
    expect(s.map((x) => x.text)).toEqual(["one", "two"]);
  });
  it("includes table text", async () => {
    const s = await extractDocxSections(await docx(p("T", "Heading1") + `<w:tbl><w:tr><w:tc>${p("cell1")}</w:tc><w:tc>${p("cell2")}</w:tc></w:tr></w:tbl>`));
    expect(s[0]!.text).toBe("T\ncell1\ncell2");
  });
  it("decodes XML entities and does not leak tab/table tags", async () => {
    const s = await extractDocxSections(await docx(`<w:p><w:r><w:t>A &amp; B &lt;x&gt;</w:t><w:tab/><w:t>C</w:t></w:r></w:p>`));
    expect(s[0]!.text).toBe("A & B <x> C");
  });
  it("groups paragraphs when there are no headings", async () => {
    const body = Array.from({ length: 10 }, (_, i) => p(`${i}`.repeat(900))).join("");
    const s = await extractDocxSections(await docx(body));
    expect(s.length).toBe(4);
    expect(s.map((x) => x.slideNumber)).toEqual([1, 2, 3, 4]);
  });
  it("splits oversized sections", async () => {
    const body = p("H", "Heading1") + Array.from({ length: 6 }, () => p("x".repeat(1500))).join("");
    const s = await extractDocxSections(await docx(body));
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x) => x.text.length <= 4100)).toBe(true);
  });
  it("drops empty paragraphs and sections", async () => {
    const s = await extractDocxSections(await docx(p("", "Heading1") + `<w:p/>` + p("   ") + p("Real", "Heading1") + p("t")));
    expect(s).toEqual([{ slideNumber: 1, text: "Real\nt", notes: "" }]);
  });
  it("throws when document.xml is missing", async () => {
    const zip = new JSZip();
    zip.file("x.txt", "x");
    await expect(extractDocxSections(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/document\.xml/);
  });
});
