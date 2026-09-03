import { MongoClient } from "mongodb";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || value.includes("YOUR_") || value.includes("USER:PASSWORD")) throw new Error(`Missing ${name}`);
  return value;
}

const client = new MongoClient(requireEnv("MONGODB_URI"));
const databaseName = process.env.MONGODB_DATABASE || "examcure";
const collectionName = process.env.MONGODB_VECTOR_COLLECTION || "material_chunks";
const indexName = process.env.MONGODB_VECTOR_INDEX || "material_vector_index";
const dimensions = Number(process.env.MONGODB_VECTOR_DIMENSIONS || "1536");

try {
  await client.connect();
  const collection = client.db(databaseName).collection(collectionName);
  await collection.createIndex({ chunk_id: 1 }, { unique: true });
  await collection.createIndex({ material_version_id: 1, is_active: 1 });
  const indexes = await collection.listSearchIndexes().toArray();
  if (!indexes.some((index) => index.name === indexName)) {
    await collection.createSearchIndex({
      name: indexName,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
          { type: "filter", path: "subject_id" },
          { type: "filter", path: "material_id" },
          { type: "filter", path: "material_version_id" },
          { type: "filter", path: "is_active" },
        ],
      },
    });
    console.log(`Created MongoDB Vector Search index: ${indexName}`);
  } else {
    console.log(`MongoDB Vector Search index already exists: ${indexName}`);
  }
} finally {
  await client.close();
}
