import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppDatabase } from "../dist/db/database.js";
import { ContentRepository } from "../dist/db/content.js";
import { createStorage } from "../dist/integrations/storage.js";
import { loadConfig } from "../dist/config.js";
import {
  chunkSlideText,
  extractPptxText,
  numericFileOrder,
} from "./material-pipeline-utils.mjs";

const execFileAsync = promisify(execFile);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || value.includes("YOUR_")) throw new Error(`Missing ${name}`);
  return value;
}

const config = loadConfig(process.env, "maintenance");
const database = new AppDatabase(config.MONGODB_URI, config.MONGODB_DATABASE);
const repository = new ContentRepository(database);
const storage = createStorage(config);
const mongo = database.client;
const mongoDatabase = config.MONGODB_DATABASE;
const mongoCollection =
  process.env.MONGODB_VECTOR_COLLECTION || "material_chunks";
const embeddingModel =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const embeddingDimensions = Number(
  process.env.MONGODB_VECTOR_DIMENSIONS || "1536",
);
const previewsBucket = "previews";
const slidesBucket = "slides";
const workerName = process.env.MATERIAL_WORKER_NAME || `worker-${process.pid}`;
const libreOfficeBin = process.env.LIBREOFFICE_BIN || "soffice";
const pdftoppmBin = process.env.PDFTOPPM_BIN || "pdftoppm";
const pdftotextBin = process.env.PDFTOTEXT_BIN || "pdftotext";

async function createEmbeddings(inputs) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: inputs,
      encoding_format: "float",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `OpenAI embeddings ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  const json = await response.json();
  const embeddings = [...json.data]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
  if (embeddings.length !== inputs.length) {
    throw new Error(
      `OpenAI returned ${embeddings.length}/${inputs.length} embeddings`,
    );
  }
  if (
    embeddings.some((embedding) => embedding.length !== embeddingDimensions)
  ) {
    throw new Error(
      `Embedding dimension does not match MONGODB_VECTOR_DIMENSIONS=${embeddingDimensions}`,
    );
  }
  return embeddings;
}

async function uploadFile(bucket, objectPath, filePath, contentType) {
  const buffer = await readFile(filePath);
  await storage.put(`${bucket}/${objectPath}`, buffer, contentType);
}

async function claimJob() {
  return repository.claimJob(workerName);
}

async function processMaterial(job) {
  const versionId = job.payload?.material_version_id;
  if (!versionId) throw new Error("Job payload is missing material_version_id");

  const version = await repository.version(versionId);
  if (!version) throw new Error("Material version not found");
  const material = { subject_id: version.subject_id };
  await database.update(
    "material_versions",
    { id: versionId },
    { $set: { status: "processing", error_message: null } },
  );
  const originalBuffer = await storage.get(version.original_path);
  const workDir = await mkdtemp(path.join(tmpdir(), "examcure-material-"));

  try {
    const inputPath = path.join(workDir, version.original_filename);
    await writeFile(inputPath, originalBuffer);
    await execFileAsync(
      libreOfficeBin,
      ["--headless", "--convert-to", "pdf", "--outdir", workDir, inputPath],
      { timeout: 180_000, windowsHide: true },
    );

    const pdfPath = path.join(
      workDir,
      `${path.parse(version.original_filename).name}.pdf`,
    );
    const slidePrefix = path.join(workDir, "slide");
    const extractedTextPath = path.join(workDir, "slides.txt");
    await execFileAsync(
      pdftoppmBin,
      ["-png", "-r", "144", pdfPath, slidePrefix],
      {
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    await execFileAsync(pdftotextBin, ["-layout", pdfPath, extractedTextPath], {
      timeout: 120_000,
      windowsHide: true,
    });

    const fallbackPages = (await readFile(extractedTextPath, "utf8")).split(
      "\f",
    );
    const pptxSlides = version.original_filename.toLowerCase().endsWith(".pptx")
      ? await extractPptxText(originalBuffer)
      : [];
    const images = (await readdir(workDir))
      .filter((name) => /^slide-\d+\.png$/.test(name))
      .sort(numericFileOrder);
    if (images.length === 0)
      throw new Error("Document conversion produced no slide images");

    const assetBase = `${version.material_id}/${version.id}`;
    const previewPath = `${assetBase}/preview.pdf`;
    await uploadFile(previewsBucket, previewPath, pdfPath, "application/pdf");

    const slideRows = [];
    for (let index = 0; index < images.length; index += 1) {
      const slideNumber = index + 1;
      const imagePath = `${assetBase}/slide-${String(slideNumber).padStart(3, "0")}.png`;
      await uploadFile(
        slidesBucket,
        imagePath,
        path.join(workDir, images[index]),
        "image/png",
      );
      const pptxSlide = pptxSlides.find(
        (slide) => slide.slideNumber === slideNumber,
      );
      const fallbackText =
        fallbackPages[index]?.replace(/\s+/g, " ").trim() || "";
      slideRows.push({
        material_version_id: version.id,
        slide_number: slideNumber,
        image_path: `${slidesBucket}/${imagePath}`,
        text_content: pptxSlide?.text || fallbackText,
        notes: pptxSlide?.notes || null,
      });
    }

    await repository.saveSlides(version.id, slideRows);

    const chunkInputs = [];
    for (const slide of slideRows) {
      const sourceText = [slide.text_content, slide.notes]
        .filter(Boolean)
        .join("\n");
      const chunks = chunkSlideText(sourceText);
      chunks.forEach((content, chunkIndex) => {
        chunkInputs.push({
          chunk_id: `${version.id}:${slide.slide_number}:${chunkIndex + 1}`,
          material_id: version.material_id,
          material_version_id: version.id,
          subject_id: material.subject_id,
          slide_number: slide.slide_number,
          content,
          content_hash: createHash("sha256").update(content).digest("hex"),
          embedding_model: embeddingModel,
          language: "vi",
          is_active: true,
          updated_at: new Date(),
        });
      });
    }
    if (chunkInputs.length === 0)
      throw new Error("No extractable text was found in the file");

    const collection = mongo.db(mongoDatabase).collection(mongoCollection);
    await collection.createIndex({ chunk_id: 1 }, { unique: true });
    await collection.updateMany(
      { material_version_id: version.id },
      { $set: { is_active: false, updated_at: new Date() } },
    );

    for (let start = 0; start < chunkInputs.length; start += 32) {
      const batch = chunkInputs.slice(start, start + 32);
      const embeddings = await createEmbeddings(
        batch.map((chunk) => chunk.content),
      );
      await collection.bulkWrite(
        batch.map((chunk, index) => {
          const embedding = embeddings[index];
          if (!embedding)
            throw new Error(`Missing embedding at batch index ${index}`);
          return {
            updateOne: {
              filter: { chunk_id: chunk.chunk_id },
              update: { $set: { ...chunk, embedding } },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      );
    }

    const now = new Date().toISOString();
    await database.transaction(async () => {
      const owner = await database.findOne("processing_jobs", {
        id: job.id,
        status: "running",
        locked_by: job.locked_by,
      });
      if (!owner) throw new Error("Worker lease lost");
      await database.update(
        "material_versions",
        { id: version.id },
        {
          $set: {
            status: "ready",
            preview_path: `${previewsBucket}/${previewPath}`,
            slide_count: slideRows.length,
            embedding_model: embeddingModel,
            processed_at: now,
            error_message: null,
          },
        },
      );
      await database.update(
        "processing_jobs",
        { id: job.id },
        {
          $set: {
            status: "completed",
            completed_at: now,
            updated_at: now,
            locked_at: null,
            locked_by: null,
          },
        },
      );
    });
    console.log(
      `Processed ${version.original_filename}: ${slideRows.length} slides, ${chunkInputs.length} chunks`,
    );
  } finally {
    const resolved = path.resolve(workDir);
    if (
      !resolved.startsWith(path.resolve(tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith("examcure-material-")
    )
      throw new Error("Unsafe temporary directory");
    await rm(resolved, { recursive: true, force: true });
  }
}

async function handleJob(job) {
  const heartbeat = setInterval(() => {
    const now = new Date().toISOString();
    void database
      .update(
        "processing_jobs",
        { id: job.id, status: "running", locked_by: job.locked_by },
        { $set: { locked_at: now, updated_at: now } },
      )
      .catch(() => console.error("Worker heartbeat failed"));
  }, 30000);
  try {
    await processMaterial(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error),
      retry = job.attempts < job.max_attempts;
    await database.transaction(async () => {
      if (
        !(await database.findOne("processing_jobs", {
          id: job.id,
          status: "running",
          locked_by: job.locked_by,
        }))
      )
        return;
      await database.update(
        "processing_jobs",
        { id: job.id },
        {
          $set: {
            status: retry ? "queued" : "failed",
            error_message: message.slice(0, 2000),
            locked_at: null,
            locked_by: null,
            updated_at: new Date().toISOString(),
          },
        },
      );
      if (job.payload?.material_version_id)
        await database.update(
          "material_versions",
          { id: job.payload.material_version_id },
          {
            $set: {
              status: retry ? "processing" : "failed",
              error_message: message.slice(0, 1000),
            },
          },
        );
    });
    console.error(
      `Job ${job.id} failed (${retry ? "retry queued" : "permanent"}):`,
      message,
    );
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  const watch = process.argv.includes("--watch");
  try {
    await database.ready;
    await mongo.connect();
    do {
      const job = await claimJob();
      if (job) await handleJob(job);
      else if (watch) await new Promise((resolve) => setTimeout(resolve, 3000));
    } while (watch);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
