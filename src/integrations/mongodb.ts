import { MongoClient, type Collection } from "mongodb";
import { requireIntegrationEnv } from "./env.js";

export type VectorChunk = {
  chunk_id: string;
  material_id: string;
  material_version_id: string;
  subject_id: string;
  slide_number: number;
  content: string;
  content_hash: string;
  embedding_model: string;
  embedding: number[];
  language: string;
  is_active: boolean;
  updated_at: Date;
};

let client: MongoClient | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (!client) {
    client = new MongoClient(requireIntegrationEnv("MONGODB_URI"));
    await client.connect();
  }
  return client;
}

export async function getVectorCollection(): Promise<Collection<VectorChunk>> {
  const mongo = await getMongoClient();
  return mongo
    .db(process.env.MONGODB_DATABASE || "examcure")
    .collection<VectorChunk>(process.env.MONGODB_VECTOR_COLLECTION || "material_chunks");
}

export function getVectorIndexName(): string {
  return process.env.MONGODB_VECTOR_INDEX || "material_vector_index";
}

export async function closeMongoClient(): Promise<void> {
  if (client) await client.close();
  client = null;
}
