import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { ContentRepository } from "../db/content.js";
import type { FileStorage } from "../integrations/storage.js";
import type { TokenService } from "../services/token.service.js";
import { AppError } from "../lib/errors.js";
import { requireAuth } from "./auth.middleware.js";
const uuid = z.string().uuid();
export function createMaterialsRouter(
  tokens: TokenService,
  db: AppDatabase,
  storage: FileStorage,
  config: AppConfig,
): Router {
  const router = Router(),
    repo = new ContentRepository(db);
  // Signed links are limited to the original file, never a general bearer token.
  router.get("/:versionId/file", async (req, res) => {
    res
      .set("Cache-Control", "private, no-store")
      .set("Referrer-Policy", "no-referrer");
    const id = uuid.parse(req.params.versionId);
    await tokens.verifyDownload(
      typeof req.query.token === "string" ? req.query.token : "",
      id,
    );
    const v = await repo.version(id);
    if (!v || v.status !== "ready")
      throw new AppError(404, "Không tìm thấy tài liệu.", "NOT_FOUND");
    res
      .attachment(v.original_filename)
      .type(v.mime_type)
      .send(await storage.get(v.original_path));
  });
  router.use(requireAuth(tokens, db));
  router.get("/", async (req, res) => {
    const body = z
      .object({
        schoolCode: z.string().trim().min(1).max(50),
        subjectCode: z.string().trim().min(1).max(50),
      })
      .parse(req.query);
    const rows = await repo.listMaterials(body.schoolCode, body.subjectCode);
    res.json({
      materials: rows.map((v) => ({
        id: v.mid,
        title: v.title,
        description: v.description,
        createdAt: v.mcreated,
        version: {
          id: v.id,
          version_number: v.version_number,
          original_filename: v.original_filename,
          size_bytes: v.size_bytes,
          slide_count: v.slide_count,
          processed_at: v.processed_at,
        },
      })),
    });
  });
  router.get("/:versionId/slides", async (req, res) => {
    const id = uuid.parse(req.params.versionId),
      v = await repo.version(id);
    if (!v || v.status !== "ready")
      throw new AppError(
        404,
        "Không tìm thấy giáo trình đã sẵn sàng.",
        "NOT_FOUND",
      );
    res.json({
      material: {
        title: v.title,
        schoolCode: v.school_code,
        subjectCode: v.subject_code,
      },
      version: {
        id: v.id,
        versionNumber: v.version_number,
        originalFilename: v.original_filename,
        sizeBytes: v.size_bytes,
        slideCount: v.slide_count,
        processedAt: v.processed_at,
      },
      slides: (
        await db.find(
          "slides",
          { material_version_id: id },
          { slide_number: 1 },
        )
      ).map((s) => ({
        slide_number: s.slide_number,
        text_content: s.text_content,
        notes: s.notes,
      })),
    });
  });
  router.get("/:versionId/download", async (req, res) => {
    const id = uuid.parse(req.params.versionId),
      v = await repo.version(id);
    if (!v || v.status !== "ready")
      throw new AppError(
        404,
        "Không tìm thấy giáo trình đã sẵn sàng.",
        "NOT_FOUND",
      );
    const token = await tokens.signDownload(
      id,
      req.userId!,
      req.header("authorization")!.slice(7),
    );
    res.set("Cache-Control", "no-store").json({
      url: `${config.API_PUBLIC_URL.replace(/\/$/, "")}/Materials/${id}/file?token=${encodeURIComponent(token)}`,
      filename: v.original_filename,
      expiresInSeconds: 60,
    });
  });
  return router;
}
