import JSZip from "jszip";
import { decodeXmlText, type ExtractedPptxSlide } from "./pptx.js";

const MAX_SECTION_CHARS = 4000;
const FALLBACK_GROUP_CHARS = 3000;

const PARAGRAPH_TAG = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>|<\/w:p>/g;
const TOKEN =
  /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;
const HEADING_ID = /^(heading ?[12]|title)$/i;

type Style = { name: string; basedOn: string; outline: boolean };
type Section = { paras: string[]; headed: boolean };

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function parseStyles(xml: string): Map<string, Style> {
  const styles = new Map<string, Style>();
  for (const m of xml.matchAll(/<w:style(\s[^>]*)?>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(m[0].slice(0, m[0].indexOf(">") + 1), "w:styleId");
    if (!id) continue;
    const body = m[2] || "";
    styles.set(id, {
      name: body.match(/<w:name\s[^>]*w:val="([^"]*)"/)?.[1] || "",
      basedOn: body.match(/<w:basedOn\s[^>]*w:val="([^"]*)"/)?.[1] || "",
      outline: /<w:outlineLvl\s[^>]*w:val="[01]"/.test(body),
    });
  }
  return styles;
}

function isHeadingStyle(id: string, styles: Map<string, Style>, depth = 0): boolean {
  if (HEADING_ID.test(id)) return true;
  const style = styles.get(id);
  if (!style || depth > 10) return false;
  if (HEADING_ID.test(style.name) || style.outline) return true;
  return style.basedOn ? isHeadingStyle(style.basedOn, styles, depth + 1) : false;
}

function isHeading(paragraphXml: string, styles: Map<string, Style>): boolean {
  const style = paragraphXml.match(/<w:pStyle\s[^>]*w:val="([^"]*)"/)?.[1];
  if (style && isHeadingStyle(style, styles)) return true;
  return /<w:outlineLvl\s[^>]*w:val="[01]"/.test(paragraphXml);
}

function hasPageBreakBefore(paragraphXml: string): boolean {
  const tag = paragraphXml.match(/<w:pageBreakBefore(?:\s[^>]*)?\/?>/)?.[0];
  if (!tag) return false;
  return !/^(0|false|off)$/i.test(attr(tag, "w:val") ?? "");
}

/** Paragraph XML in document order; textbox paragraphs are lifted out after their host paragraph. */
function paragraphsOf(xml: string): string[] {
  const clean = xml.replace(/<mc:Fallback(?:\s[^>]*)?>[\s\S]*?<\/mc:Fallback>/g, "");
  type Frame = { last: number; parts: string[]; lifted: string[] };
  const out: string[] = [];
  const stack: Frame[] = [];
  for (const m of clean.matchAll(PARAGRAPH_TAG)) {
    const tag = m[0];
    const start = m.index!;
    const end = start + tag.length;
    const top = stack[stack.length - 1];
    if (tag === "</w:p>") {
      if (!top) continue;
      top.parts.push(clean.slice(top.last, start));
      stack.pop();
      const own = [top.parts.join(""), ...top.lifted];
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.lifted.push(...own);
        parent.last = end;
      } else out.push(...own);
    } else if (tag.endsWith("/>")) {
      continue;
    } else {
      if (top) top.parts.push(clean.slice(top.last, start));
      stack.push({ last: end, parts: [], lifted: [] });
    }
  }
  return out;
}

function splitText(text: string, cap: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    const window = rest.slice(0, cap + 1);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf("\n"));
    if (cut < cap * 0.5) cut = Math.max(cut, window.lastIndexOf(" "));
    const at = cut >= cap * 0.3 ? cut + 1 : cap;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
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

/** Splits one section to at most `limit` chars, keeping a heading with its first body piece. */
function splitSection(section: Section, limit: number): string[][] {
  const { paras, headed } = section;
  const expanded = paras.flatMap((p, i) =>
    p.length <= limit
      ? [p]
      : splitText(p, headed && i === 1 ? Math.max(200, limit - (paras[0]?.length ?? 0) - 1) : limit),
  );
  return splitByLength(expanded, limit);
}

async function resolveParts(zip: JSZip): Promise<{ main: string; styles: string }> {
  let main = "word/document.xml";
  const rels = await zip.file("_rels/.rels")?.async("string");
  for (const m of rels?.matchAll(/<Relationship\s[^>]*>/g) ?? []) {
    const target = attr(m[0], "Target");
    if (target && /\/officeDocument$/.test(attr(m[0], "Type") || "")) {
      main = target.replace(/^\//, "");
      break;
    }
  }
  const slash = main.lastIndexOf("/");
  const dir = slash >= 0 ? main.slice(0, slash + 1) : "";
  let styles = "word/styles.xml";
  const partRels = await zip.file(`${dir}_rels/${main.slice(slash + 1)}.rels`)?.async("string");
  for (const m of partRels?.matchAll(/<Relationship\s[^>]*>/g) ?? []) {
    const target = attr(m[0], "Target");
    if (target && /\/styles$/.test(attr(m[0], "Type") || "")) {
      styles = target.startsWith("/") ? target.slice(1) : dir + target;
      break;
    }
  }
  return { main, styles };
}

/** Each returned "slide" is one document section (heading/page-break based). */
export async function extractDocxSections(buffer: Buffer): Promise<ExtractedPptxSlide[]> {
  const zip = await JSZip.loadAsync(buffer);
  const parts = await resolveParts(zip);
  const file = zip.file(parts.main) ?? zip.file("word/document.xml");
  if (!file) throw new Error("word/document.xml was not found in the Word file");
  const xml = await file.async("string");
  const styles = parseStyles((await (zip.file(parts.styles) ?? zip.file("word/styles.xml"))?.async("string")) || "");

  const sections: Section[] = [];
  let current: Section = { paras: [], headed: false };
  let hasBreaks = false;
  const flush = (headed = false) => {
    if (current.paras.length > 0) sections.push(current);
    current = { paras: [], headed };
  };

  for (const body of paragraphsOf(xml)) {
    const heading = isHeading(body, styles);
    if (heading || hasPageBreakBefore(body)) {
      hasBreaks = true;
      flush(heading);
    }
    let text = "";
    const commit = () => {
      const trimmed = text.replace(/[ \t]+\n/g, "\n").trim();
      if (trimmed) current.paras.push(trimmed);
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

  const groups = hasBreaks
    ? sections.flatMap((section) => splitSection(section, MAX_SECTION_CHARS))
    : splitSection({ paras: sections.flatMap((s) => s.paras), headed: false }, FALLBACK_GROUP_CHARS);

  return groups
    .map((group) => group.join("\n").trim())
    .filter(Boolean)
    .map((text, index) => ({ slideNumber: index + 1, text, notes: "" }));
}
