import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { getSupabaseAdmin } from "../integrations/supabase.js";
import { AppError } from "../lib/errors.js";
import { requireSupabaseUser } from "./supabase-user.middleware.js";

const uuid = z.string().uuid();
const subjectQuery = z.object({
  schoolCode: z.string().trim().min(1).max(50),
  subjectCode: z.string().trim().min(1).max(50),
});
const asyncHandler = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

type SubjectRelation = { school_code: string; code: string } | Array<{ school_code: string; code: string }>;
type MaterialRelation = { title: string; subjects: SubjectRelation } | Array<{ title: string; subjects: SubjectRelation }>;
const one = <T,>(value: T | T[] | null): T | null => Array.isArray(value) ? value[0] || null : value;

/** Read-only student endpoints. Files stay private; only the API signs downloads. */
export function createMaterialsRouter(): Router {
  const router = Router();
  router.use(requireSupabaseUser);

  router.get("/", asyncHandler(async (req, res) => {
    const { schoolCode, subjectCode } = subjectQuery.parse(req.query);
    const { data, error } = await getSupabaseAdmin()
      .from("materials")
      .select("id, title, description, created_at, subjects!inner(school_code, code), material_versions!inner(id, version_number, original_filename, size_bytes, slide_count, processed_at)")
      .eq("subjects.school_code", schoolCode.toLowerCase())
      .eq("subjects.code", subjectCode.toUpperCase())
      .eq("material_versions.status", "ready")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const materials = (data || []).flatMap((material) => {
      const versions = (material.material_versions || []) as Array<{
        id: string; version_number: number; original_filename: string; size_bytes: number; slide_count: number; processed_at: string | null;
      }>;
      return versions.map((version) => ({
        id: material.id,
        title: material.title,
        description: material.description,
        createdAt: material.created_at,
        version,
      }));
    });
    res.json({ materials });
  }));

  router.get("/:versionId/slides", asyncHandler(async (req, res) => {
    const versionId = uuid.parse(req.params.versionId);
    const { data, error } = await getSupabaseAdmin()
      .from("material_versions")
      .select("id, version_number, original_filename, size_bytes, slide_count, processed_at, status, materials!inner(title, subjects!inner(school_code, code))")
      .eq("id", versionId)
      .eq("status", "ready")
      .single();
    if (error || !data) throw new AppError(404, "Không tìm thấy giáo trình đã sẵn sàng.", "NOT_FOUND");
    const { data: slides, error: slidesError } = await getSupabaseAdmin()
      .from("slides")
      .select("slide_number, text_content, notes")
      .eq("material_version_id", versionId)
      .order("slide_number");
    if (slidesError) throw slidesError;
    const material = one((data as unknown as { materials: MaterialRelation }).materials);
    const subject = one(material?.subjects || null);
    res.json({
      material: { title: material?.title || data.original_filename, schoolCode: subject?.school_code, subjectCode: subject?.code },
      version: {
        id: data.id,
        versionNumber: data.version_number,
        originalFilename: data.original_filename,
        sizeBytes: data.size_bytes,
        slideCount: data.slide_count,
        processedAt: data.processed_at,
      },
      slides: slides || [],
    });
  }));

  router.get("/:versionId/download", asyncHandler(async (req, res) => {
    const versionId = uuid.parse(req.params.versionId);
    const { data: version, error } = await getSupabaseAdmin()
      .from("material_versions")
      .select("original_bucket, original_path, original_filename")
      .eq("id", versionId)
      .eq("status", "ready")
      .single();
    if (error || !version) throw new AppError(404, "Không tìm thấy giáo trình đã sẵn sàng.", "NOT_FOUND");
    const { data: signed, error: signedError } = await getSupabaseAdmin().storage
      .from(version.original_bucket)
      .createSignedUrl(version.original_path, 60);
    if (signedError || !signed?.signedUrl) throw signedError || new Error("Không thể tạo link tải tài liệu");
    res.json({ url: signed.signedUrl, filename: version.original_filename, expiresInSeconds: 60 });
  }));

  return router;
}
