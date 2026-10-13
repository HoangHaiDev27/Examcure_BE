import { createHash } from "node:crypto";
import { createEmbeddings } from "../integrations/openai.js";
import { getVectorCollection } from "../integrations/mongodb.js";
import { chunkSlideText, extractPptxText } from "../integrations/pptx.js";
import type { AppDatabase } from "../db/database.js";
import { ContentRepository } from "../db/content.js";
import type { FileStorage } from "../integrations/storage.js";

const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_DIMENSIONS = Number(
  process.env.MONGODB_VECTOR_DIMENSIONS || "1536",
);

export type PptxIngestionResult = {
  slideCount: number;
  chunkCount: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1000)
    : "Unknown error";
}

/**
 * Synchronous, no-worker ingestion mode. It deliberately only handles PPTX text
 * and notes; visual previews require the optional LibreOffice/Poppler worker.
 */
export async function ingestPptxMaterialVersion(
  versionId: string,
  db: AppDatabase,
  storage: FileStorage,
): Promise<PptxIngestionResult> {
  const repo = new ContentRepository(db);
  try {
    const version = await repo.version(versionId);
    if (!version) throw new Error("Material version not found");
    const subject = { subject_id: version.subject_id as string };
    if (!version.original_filename.toLowerCase().endsWith(".pptx"))
      throw new Error("Only .pptx is supported");
    const original = await storage.get(version.original_path);
    const extractedSlides = await extractPptxText(original);
    if (extractedSlides.length === 0)
      throw new Error("No slides were found in the PowerPoint file");
    const slideRows = extractedSlides.map((slide) => ({
      material_version_id: version.id,
      slide_number: slide.slideNumber,
      image_path: null,
      text_content: slide.text,
      notes: slide.notes || null,
    }));
    await repo.saveSlides(version.id, slideRows);

    const chunkInputs = slideRows.flatMap((slide) =>
      chunkSlideText(
        [slide.text_content, slide.notes].filter(Boolean).join("\n"),
      ).map((content, index) => ({
        chunk_id: `${version.id}:${slide.slide_number}:${index + 1}`,
        material_id: version.material_id,
        material_version_id: version.id,
        subject_id: subject.subject_id,
        slide_number: slide.slide_number,
        content,
        content_hash: createHash("sha256").update(content).digest("hex"),
        embedding_model:
          process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
        language: "vi",
        is_active: true,
        updated_at: new Date(),
      })),
    );
    if (chunkInputs.length === 0)
      throw new Error("No extractable text was found in the PowerPoint file");

    const collection = await getVectorCollection();
    await collection.createIndex({ chunk_id: 1 }, { unique: true });
    await collection.updateMany(
      { material_version_id: version.id },
      { $set: { is_active: false, updated_at: new Date() } },
    );
    for (
      let start = 0;
      start < chunkInputs.length;
      start += EMBEDDING_BATCH_SIZE
    ) {
      const batch = chunkInputs.slice(start, start + EMBEDDING_BATCH_SIZE);
      const embeddings = await createEmbeddings(
        batch.map((chunk) => chunk.content),
      );
      if (embeddings.length !== batch.length)
        throw new Error("OpenAI returned an incomplete embedding batch");
      if (
        embeddings.some(
          (embedding) => embedding.length !== EMBEDDING_DIMENSIONS,
        )
      ) {
        throw new Error(
          `Embedding dimension does not match MONGODB_VECTOR_DIMENSIONS=${EMBEDDING_DIMENSIONS}`,
        );
      }
      const operations = batch.map((chunk, index) => {
        const embedding = embeddings[index];
        if (!embedding)
          throw new Error(`OpenAI omitted embedding ${index} in a batch`);
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

    await db.update(
      "material_versions",
      { id: version.id },
      {
        $set: {
          status: "ready",
          slide_count: slideRows.length,
          embedding_model:
            process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
          processed_at: new Date().toISOString(),
          error_message: null,
        },
      },
    );
    return { slideCount: slideRows.length, chunkCount: chunkInputs.length };
  } catch (error) {
    await db.update(
      "material_versions",
      { id: versionId },
      { $set: { status: "failed", error_message: errorMessage(error) } },
    );
    throw error;
  }
}
