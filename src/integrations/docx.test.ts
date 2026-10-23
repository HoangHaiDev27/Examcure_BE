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
  it("handles textboxes: skips fallback, keeps host text, lifts box text once", async () => {
    const body = `<w:p><w:r><w:t>before</w:t></w:r><mc:AlternateContent><mc:Choice><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent><w:r><w:t>AFTER</w:t></w:r></w:p>` + p("next");
    const s = await extractDocxSections(await docx(body));
    expect(s[0]!.text).toBe("beforeAFTER\nBox\nnext");
  });
  it("resolves heading styles through styles.xml names and basedOn", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document ${NS}><w:body>${p("A", "u1")}${p("a")}${p("B", "custom")}${p("b")}${p("C", "Other")}${p("c")}</w:body></w:document>`);
    zip.file("word/styles.xml", `<w:styles ${NS}><w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="custom"><w:name w:val="Mine"/><w:basedOn w:val="u1"/></w:style><w:style w:type="paragraph" w:styleId="Other"><w:name w:val="Normal2"/></w:style></w:styles>`);
    const s = await extractDocxSections(await zip.generateAsync({ type: "nodebuffer" }));
    expect(s.map((x) => x.text)).toEqual(["A\na", "B\nb\nC\nc"]);
  });
  it("does not leak XML from self-closing w:t", async () => {
    const s = await extractDocxSections(await docx(`<w:p><w:r><w:t xml:space="preserve"/></w:r><w:r><w:t>x</w:t></w:r></w:p>`));
    expect(s[0]!.text).toBe("x");
  });
  it("honours pageBreakBefore values", async () => {
    const pb = (v: string) => `<w:p><w:pPr><w:pageBreakBefore${v}/></w:pPr><w:r><w:t>n</w:t></w:r></w:p>`;
    expect((await extractDocxSections(await docx(p("a") + pb(' w:val="1"') + pb(" ")))).length).toBe(3);
    expect((await extractDocxSections(await docx(p("a") + pb(' w:val="false"') + pb(' w:val="0"')))).length).toBe(1);
  });
  it("keeps a heading with an oversized paragraph and caps section size", async () => {
    const long = Array.from({ length: 800 }, (_, i) => `word${i}`).join(" ") + ".";
    const s = await extractDocxSections(await docx(p("Heading", "Heading1") + p(long) + p("Next", "Heading1") + p("n")));
    expect(s[0]!.text.startsWith("Heading\nword0")).toBe(true);
    expect(s.every((x) => x.text.length <= 4000)).toBe(true);
    expect(s.at(-1)!.text).toBe("Next\nn");
  });
  it("finds the main part through _rels/.rels", async () => {
    const zip = new JSZip();
    zip.file("_rels/.rels", '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document2.xml"/></Relationships>');
    zip.file("word/document2.xml", `<w:document ${NS}><w:body>${p("One", "Heading1")}${p("Two", "Heading1")}</w:body></w:document>`);
    expect((await extractDocxSections(await zip.generateAsync({ type: "nodebuffer" }))).length).toBe(2);
  });
  it("throws when document.xml is missing", async () => {
    const zip = new JSZip();
    zip.file("x.txt", "x");
    await expect(extractDocxSections(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/document\.xml/);
  });
});
