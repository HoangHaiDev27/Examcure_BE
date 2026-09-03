import { createEmbeddings } from "./openai.js";
import { getVectorCollection, getVectorIndexName } from "./mongodb.js";

export type RetrievedChunk = {
  chunk_id: string;
  material_id: string;
  material_version_id: string;
  subject_id: string;
  slide_number: number;
  content: string;
  score: number;
};

export async function retrieveMaterialChunks(input: {
  query: string;
  subjectId: string;
  materialVersionIds: string[];
  limit?: number;
}): Promise<RetrievedChunk[]> {
  const embeddings = await createEmbeddings([input.query]);
  const queryVector = embeddings[0];
  if (!queryVector) throw new Error("OpenAI did not return a query embedding");
  const collection = await getVectorCollection();
  const limit = Math.min(Math.max(input.limit || 16, 4), 40);
  return collection.aggregate<RetrievedChunk>([
    {
      $vectorSearch: {
        index: getVectorIndexName(),
        path: "embedding",
        queryVector,
        numCandidates: Math.max(limit * 20, 100),
        limit,
        filter: {
          $and: [
            { subject_id: input.subjectId },
            { material_version_id: { $in: input.materialVersionIds } },
            { is_active: true },
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        chunk_id: 1,
        material_id: 1,
        material_version_id: 1,
        subject_id: 1,
        slide_number: 1,
        content: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]).toArray();
}
