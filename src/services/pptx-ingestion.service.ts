import { createHash } from "node:crypto";
import { createEmbeddings } from "../integrations/openai.js";
import { getVectorCollection } from "../integrations/mongodb.js";
import { chunkSlideText, extractPptxText } from "../integrations/pptx.js";
import { getSupabaseAdmin } from "../integrations/supabase.js";

const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_DIMENSIONS = Number(process.env.MONGODB_VECTOR_DIMENSIONS || "1536");

export type PptxIngestionResult = {
  slideCount: number;
  chunkCount: number;
};

type MaterialVersion = {
  id: string;
  material_id: string;
  original_bucket: string;
  original_path: string;
  original_filename: string;
  materials: { subject_id: string } | Array<{ subject_id: string }> | null;
};

function relatedSubject(version: MaterialVersion): { subject_id: string } | undefined {
  return Array.isArray(version.materials) ? version.materials[0] : version.materials ?? undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : "Unknown error";
}

/**
 * Synchronous, no-worker ingestion mode. It deliberately only handles PPTX text
 * and notes; visual previews require the optional LibreOffice/Poppler worker.
 */
export async function ingestPptxMaterialVersion(versionId: string): Promise<PptxIngestionResult> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("material_versions")
      .select("id, material_id, original_bucket, original_path, original_filename, materials!inner(subject_id)")
      .eq("id", versionId)
      .single();
    const version = data as MaterialVersion | null;
    if (error || !version) throw error || new Error("Material version not found");
    const subject = relatedSubject(version);
    if (!subject?.subject_id) throw new Error("Material subject relation was not found");
    if (!version.original_filename.toLowerCase().endsWith(".pptx")) {
      throw new Error("Only .pptx files are supported without the conversion worker");
    }

    const { error: processingError } = await supabase
      .from("material_versions")
      .update({ status: "processing", error_message: null })
      .eq("id", versionId);
    if (processingError) throw processingError;

    const { data: original, error: downloadError } = await supabase.storage
      .from(version.original_bucket)
      .download(version.original_path);
    if (downloadError || !original) throw downloadError || new Error("Original file download failed");

    const extractedSlides = await extractPptxText(Buffer.from(await original.arrayBuffer()));
    if (extractedSlides.length === 0) throw new Error("No slides were found in the PowerPoint file");
    const slideRows = extractedSlides.map((slide) => ({
      material_version_id: version.id,
      slide_number: slide.slideNumber,
      image_path: null,
      text_content: slide.text,
      notes: slide.notes || null,
    }));
    const { error: slideError } = await supabase
      .from("slides")
      .upsert(slideRows, { onConflict: "material_version_id,slide_number" });
    if (slideError) throw slideError;

    const chunkInputs = slideRows.flatMap((slide) =>
      chunkSlideText([slide.text_content, slide.notes].filter(Boolean).join("\n")).map((content, index) => ({
        chunk_id: `${version.id}:${slide.slide_number}:${index + 1}`,
        material_id: version.material_id,
        material_version_id: version.id,
        subject_id: subject.subject_id,
        slide_number: slide.slide_number,
        content,
        content_hash: createHash("sha256").update(content).digest("hex"),
        embedding_model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
        language: "vi",
        is_active: true,
        updated_at: new Date(),
      })),
    );
    if (chunkInputs.length === 0) throw new Error("No extractable text was found in the PowerPoint file");

    const collection = await getVectorCollection();
    await collection.createIndex({ chunk_id: 1 }, { unique: true });
    await collection.updateMany(
      { material_version_id: version.id },
      { $set: { is_active: false, updated_at: new Date() } },
    );
    for (let start = 0; start < chunkInputs.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = chunkInputs.slice(start, start + EMBEDDING_BATCH_SIZE);
      const embeddings = await createEmbeddings(batch.map((chunk) => chunk.content));
      if (embeddings.length !== batch.length) throw new Error("OpenAI returned an incomplete embedding batch");
      if (embeddings.some((embedding) => embedding.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error(`Embedding dimension does not match MONGODB_VECTOR_DIMENSIONS=${EMBEDDING_DIMENSIONS}`);
      }
      const operations = batch.map((chunk, index) => {
        const embedding = embeddings[index];
        if (!embedding) throw new Error(`OpenAI omitted embedding ${index} in a batch`);
        return {
          updateOne: {
            filter: { chunk_id: chunk.chunk_id },
            update: { $set: { ...chunk, embedding } },
            upsert: true,
          },
        };
      });
      await collection.bulkWrite(operations, { ordered: false });
    }

    const { error: readyError } = await supabase
      .from("material_versions")
      .update({
        status: "ready",
        preview_path: null,
        slide_count: slideRows.length,
        embedding_model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
        processed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", version.id);
    if (readyError) throw readyError;
    return { slideCount: slideRows.length, chunkCount: chunkInputs.length };
  } catch (error) {
    await supabase
      .from("material_versions")
      .update({ status: "failed", error_message: errorMessage(error) })
      .eq("id", versionId);
    throw error;
  }
}
