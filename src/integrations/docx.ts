import JSZip from "jszip";
import { decodeXmlText, type ExtractedPptxSlide } from "./pptx.js";

const MAX_SECTION_CHARS = 4000;
const FALLBACK_GROUP_CHARS = 3000;

const PARAGRAPH = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
const TOKEN =
  /<w:t\s*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;

function isHeading(paragraphXml: string): boolean {
  const style = paragraphXml.match(/<w:pStyle\s[^>]*w:val="([^"]*)"/)?.[1];
  if (style && /^(heading ?[12]|title)$/i.test(style)) return true;
  return /<w:outlineLvl\s[^>]*w:val="[01]"/.test(paragraphXml);
}

function splitByLength(paragraphs: string[], limit: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const paragraph of paragraphs) {
    if (current.length > 0 && size + paragraph.length > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(paragraph);
    size += paragraph.length + 1;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Each returned "slide" is one document section (heading/page-break based). */
export async function extractDocxSections(buffer: Buffer): Promise<ExtractedPptxSlide[]> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("word/document.xml was not found in the Word file");
  const xml = await file.async("string");

  let sections: string[][] = [];
  let current: string[] = [];
  let hasBreaks = false;
  const flush = () => {
    if (current.length > 0) sections.push(current);
    current = [];
  };

  for (const match of xml.matchAll(PARAGRAPH)) {
    const body = match[1] || "";
    if (isHeading(body) || /<w:pageBreakBefore\s*\/?>/.test(body)) {
      hasBreaks = true;
      flush();
    }
    let text = "";
    const commit = () => {
      const trimmed = text.replace(/[ \t]+\n/g, "\n").trim();
      if (trimmed) current.push(trimmed);
      text = "";
    };
    for (const token of body.matchAll(TOKEN)) {
      const raw = token[0];
      if (raw.startsWith("<w:tab")) text += " ";
      else if (raw.startsWith("<w:br") || raw.startsWith("<w:cr")) {
        if (/w:type="page"/.test(raw)) {
          hasBreaks = true;
          commit();
          flush();
        } else text += "\n";
      } else if (token[1] !== undefined) text += decodeXmlText(token[1]);
    }
    commit();
  }
  flush();

  if (!hasBreaks) sections = splitByLength(sections.flat(), FALLBACK_GROUP_CHARS);
  else
    sections = sections.flatMap((section) =>
      section.join("\n").length > MAX_SECTION_CHARS ? splitByLength(section, MAX_SECTION_CHARS) : [section],
    );

  return sections
    .map((section) => section.join("\n").trim())
    .filter(Boolean)
    .map((text, index) => ({ slideNumber: index + 1, text, notes: "" }));
}
