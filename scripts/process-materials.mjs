import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { MongoClient } from "mongodb";
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

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const mongo = new MongoClient(requireEnv("MONGODB_URI"));
const mongoDatabase = process.env.MONGODB_DATABASE || "examcure";
const mongoCollection = process.env.MONGODB_VECTOR_COLLECTION || "material_chunks";
const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const embeddingDimensions = Number(process.env.MONGODB_VECTOR_DIMENSIONS || "1536");
const originalsBucket = process.env.SUPABASE_ORIGINALS_BUCKET || "material-originals";
const previewsBucket = process.env.SUPABASE_PREVIEWS_BUCKET || "material-previews";
const slidesBucket = process.env.SUPABASE_SLIDES_BUCKET || "slide-images";
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
    body: JSON.stringify({ model: embeddingModel, input: inputs, encoding_format: "float" }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI embeddings ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const json = await response.json();
  const embeddings = [...json.data]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
  if (embeddings.length !== inputs.length) {
    throw new Error(`OpenAI returned ${embeddings.length}/${inputs.length} embeddings`);
  }
  if (embeddings.some((embedding) => embedding.length !== embeddingDimensions)) {
    throw new Error(`Embedding dimension does not match MONGODB_VECTOR_DIMENSIONS=${embeddingDimensions}`);
  }
  return embeddings;
}

async function uploadFile(bucket, objectPath, filePath, contentType) {
  const buffer = await readFile(filePath);
  const { error } = await supabase.storage
    .from(bucket)
    .upload(objectPath, buffer, { contentType, upsert: true });
  if (error) throw error;
}

async function claimJob() {
  const { data, error } = await supabase.rpc("claim_processing_job", {
    p_worker_name: workerName,
  });
  if (error) throw error;
  return data?.[0] || null;
}

async function processMaterial(job) {
  const versionId = job.payload?.material_version_id;
  if (!versionId) throw new Error("Job payload is missing material_version_id");

  const { data: version, error: versionError } = await supabase
    .from("material_versions")
    .select("id, material_id, original_bucket, original_path, original_filename, mime_type, materials!inner(subject_id)")
    .eq("id", versionId)
    .single();
  if (versionError || !version) throw versionError || new Error("Material version not found");
  const material = Array.isArray(version.materials) ? version.materials[0] : version.materials;
  if (!material?.subject_id) throw new Error("Material subject relation was not found");

  const { error: processingError } = await supabase
    .from("material_versions")
    .update({ status: "processing", error_message: null })
    .eq("id", versionId);
  if (processingError) throw processingError;

  const { data: original, error: downloadError } = await supabase.storage
    .from(version.original_bucket || originalsBucket)
    .download(version.original_path);
  if (downloadError || !original) throw downloadError || new Error("Original file download failed");

  const originalBuffer = Buffer.from(await original.arrayBuffer());
  const workDir = await mkdtemp(path.join(tmpdir(), "examcure-material-"));

  try {
    const inputPath = path.join(workDir, version.original_filename);
    await writeFile(inputPath, originalBuffer);
    await execFileAsync(libreOfficeBin, [
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      workDir,
      inputPath,
    ], { timeout: 180_000, windowsHide: true });

    const pdfPath = path.join(workDir, `${path.parse(version.original_filename).name}.pdf`);
    const slidePrefix = path.join(workDir, "slide");
    const extractedTextPath = path.join(workDir, "slides.txt");
    await execFileAsync(pdftoppmBin, ["-png", "-r", "144", pdfPath, slidePrefix], {
      timeout: 180_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    await execFileAsync(pdftotextBin, ["-layout", pdfPath, extractedTextPath], {
      timeout: 120_000,
      windowsHide: true,
    });

    const fallbackPages = (await readFile(extractedTextPath, "utf8")).split("\f");
    const pptxSlides = version.original_filename.toLowerCase().endsWith(".pptx")
      ? await extractPptxText(originalBuffer)
      : [];
    const images = (await readdir(workDir))
      .filter((name) => /^slide-\d+\.png$/.test(name))
      .sort(numericFileOrder);
    if (images.length === 0) throw new Error("PowerPoint conversion produced no slide images");

    const assetBase = `${version.material_id}/${version.id}`;
    const previewPath = `${assetBase}/preview.pdf`;
    await uploadFile(previewsBucket, previewPath, pdfPath, "application/pdf");

    const slideRows = [];
    for (let index = 0; index < images.length; index += 1) {
      const slideNumber = index + 1;
      const imagePath = `${assetBase}/slide-${String(slideNumber).padStart(3, "0")}.png`;
      await uploadFile(slidesBucket, imagePath, path.join(workDir, images[index]), "image/png");
      const pptxSlide = pptxSlides.find((slide) => slide.slideNumber === slideNumber);
      const fallbackText = fallbackPages[index]?.replace(/\s+/g, " ").trim() || "";
      slideRows.push({
        material_version_id: version.id,
        slide_number: slideNumber,
        image_path: imagePath,
        text_content: pptxSlide?.text || fallbackText,
        notes: pptxSlide?.notes || null,
      });
    }

    const { error: slideError } = await supabase
      .from("slides")
      .upsert(slideRows, { onConflict: "material_version_id,slide_number" });
    if (slideError) throw slideError;

    const chunkInputs = [];
    for (const slide of slideRows) {
      const sourceText = [slide.text_content, slide.notes].filter(Boolean).join("\n");
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
    if (chunkInputs.length === 0) throw new Error("No extractable text was found in the PowerPoint file");

    const collection = mongo.db(mongoDatabase).collection(mongoCollection);
    await collection.createIndex({ chunk_id: 1 }, { unique: true });
    await collection.updateMany(
      { material_version_id: version.id },
      { $set: { is_active: false, updated_at: new Date() } },
    );

    for (let start = 0; start < chunkInputs.length; start += 32) {
      const batch = chunkInputs.slice(start, start + 32);
      const embeddings = await createEmbeddings(batch.map((chunk) => chunk.content));
      await collection.bulkWrite(
        batch.map((chunk, index) => {
          const embedding = embeddings[index];
          if (!embedding) throw new Error(`Missing embedding at batch index ${index}`);
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
    const { error: readyError } = await supabase
      .from("material_versions")
      .update({
        status: "ready",
        preview_path: previewPath,
        slide_count: slideRows.length,
        embedding_model: embeddingModel,
        processed_at: now,
        error_message: null,
      })
      .eq("id", version.id);
    if (readyError) throw readyError;

    const { error: completedError } = await supabase
      .from("processing_jobs")
      .update({ status: "completed", completed_at: now, updated_at: now })
      .eq("id", job.id);
    if (completedError) throw completedError;
    console.log(`Processed ${version.original_filename}: ${slideRows.length} slides, ${chunkInputs.length} chunks`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function handleJob(job) {
  try {
    await processMaterial(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetry = job.attempts < job.max_attempts;
    await supabase
      .from("processing_jobs")
      .update({
        status: shouldRetry ? "queued" : "failed",
        error_message: message.slice(0, 2000),
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    const versionId = job.payload?.material_version_id;
    if (versionId) {
      await supabase
        .from("material_versions")
        .update({
          status: shouldRetry ? "uploaded" : "failed",
          error_message: message.slice(0, 2000),
        })
        .eq("id", versionId);
    }
    console.error(`Job ${job.id} failed (${shouldRetry ? "retry queued" : "permanent"}):`, message);
  }
}

async function main() {
  await mongo.connect();
  const watch = process.argv.includes("--watch");
  try {
    do {
      const job = await claimJob();
      if (job) await handleJob(job);
      else if (watch) await new Promise((resolve) => setTimeout(resolve, 3000));
    } while (watch);
  } finally {
    await mongo.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
