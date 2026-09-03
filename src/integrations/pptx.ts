import JSZip from "jszip";

export type ExtractedPptxSlide = {
  slideNumber: number;
  text: string;
  notes: string;
};

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function extractTextFromXml(xml: string): string[] {
  return Array.from(
    xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g),
    (match) => decodeXmlText(match[1] || ""),
  );
}

export function numericFileOrder(a: string, b: string): number {
  return Number(a.match(/(\d+)/)?.[1] || 0) - Number(b.match(/(\d+)/)?.[1] || 0);
}

export async function extractPptxText(buffer: Buffer): Promise<ExtractedPptxSlide[]> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(numericFileOrder);
  const noteFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
    .sort(numericFileOrder);
  const notes = new Map<number, string>();

  for (const name of noteFiles) {
    const number = Number(name.match(/notesSlide(\d+)/)?.[1]);
    const file = zip.file(name);
    if (file) notes.set(number, extractTextFromXml(await file.async("string")).join(" ").trim());
  }

  const slides: ExtractedPptxSlide[] = [];
  for (const name of slideFiles) {
    const number = Number(name.match(/slide(\d+)/)?.[1]);
    const file = zip.file(name);
    if (!file) continue;
    slides.push({
      slideNumber: number,
      text: extractTextFromXml(await file.async("string")).join(" ").replace(/\s+/g, " ").trim(),
      notes: notes.get(number) || "",
    });
  }
  return slides;
}

export function chunkSlideText(text: string, maxLength = 1100, overlap = 140): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const remaining = normalized.length - start;
    if (chunks.length > 0 && remaining > maxLength && remaining <= maxLength + overlap) start = normalized.length - maxLength;
    let end = Math.min(start + maxLength, normalized.length);
    if (end < normalized.length) {
      const sentenceBreak = Math.max(
        normalized.lastIndexOf(". ", end),
        normalized.lastIndexOf("; ", end),
        normalized.lastIndexOf("\n", end),
      );
      if (sentenceBreak > start + maxLength * 0.55) end = sentenceBreak + 1;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}
