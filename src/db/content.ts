import { randomUUID } from "node:crypto";
import { AppDatabase, type DataRow } from "./database.js";
import { AppError } from "../lib/errors.js";
const COLLECTIONS = new Set([
  "subjects",
  "materials",
  "material_versions",
  "slides",
  "processing_jobs",
  "generation_runs",
  "questions",
  "exams",
  "attempts",
  "audit_logs",
]);
const now = () => new Date().toISOString();
const defaults: Record<string, DataRow> = {
  material_versions: {
    status: "uploading",
    preview_path: null,
    slide_count: 0,
    embedding_model: null,
    error_message: null,
    processed_at: null,
  },
  processing_jobs: {
    status: "queued",
    attempts: 0,
    max_attempts: 3,
    locked_at: null,
    locked_by: null,
    error_message: null,
    completed_at: null,
  },
  generation_runs: {
    retrieved_chunk_count: 0,
    error_message: null,
    completed_at: null,
  },
  questions: {
    status: "draft",
    approved_by: null,
    approved_at: null,
    question_options: [],
    question_sources: [],
  },
  exams: { exam_questions: [] },
};
export class ContentRepository {
  constructor(readonly db: AppDatabase) {}
  async claimJob(workerName: string) {
    return this.db.transaction(async () => {
      const timestamp = now(),
        stale = new Date(Date.now() - 30 * 60000).toISOString();
      const expired = await this.db.find("processing_jobs", {
        status: "running",
        locked_at: { $lt: stale },
      });
      for (const job of expired) {
        const retry = job.attempts < job.max_attempts;
        await this.db.update(
          "processing_jobs",
          { id: job.id },
          {
            $set: {
              status: retry ? "queued" : "failed",
              locked_at: null,
              locked_by: null,
              error_message: "Worker lease expired",
              updated_at: timestamp,
            },
          },
        );
        if (!retry && job.payload?.material_version_id)
          await this.db.update(
            "material_versions",
            { id: job.payload.material_version_id },
            {
              $set: { status: "failed", error_message: "Worker lease expired" },
            },
          );
      }
      const job = await this.db.findOne(
        "processing_jobs",
        {
          status: "queued",
          job_type: "material_ingestion",
          $expr: { $lt: ["$attempts", "$max_attempts"] },
        },
        { created_at: 1 },
      );
      if (!job) return null;
      const owner = `${workerName}:${randomUUID()}`;
      await this.db.update(
        "processing_jobs",
        { id: job.id },
        {
          $set: {
            status: "running",
            locked_by: owner,
            locked_at: timestamp,
            updated_at: timestamp,
          },
          $inc: { attempts: 1 },
        },
      );
      return { ...job, attempts: job.attempts + 1, locked_by: owner };
    });
  }
  async insert(collection: string, values: DataRow): Promise<string> {
    if (!COLLECTIONS.has(collection))
      throw new Error("Invalid application collection");
    const id = typeof values.id === "string" ? values.id : randomUUID();
    await this.db.insert(collection, {
      ...defaults[collection],
      ...values,
      id,
    });
    return id;
  }
  async audit(
    actor: string,
    action: string,
    type: string,
    id: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.insert("audit_logs", {
      actor_id: actor,
      action,
      entity_type: type,
      entity_id: id,
      details,
      created_at: now(),
    });
  }
  async version(id: string): Promise<DataRow | null> {
    const version = await this.db.findOne("material_versions", { id });
    if (!version) return null;
    const material = await this.db.findOne("materials", {
      id: version.material_id,
    });
    if (!material) return null;
    const subject = await this.db.findOne("subjects", {
      id: material.subject_id,
    });
    return subject
      ? {
          ...version,
          subject_id: material.subject_id,
          title: material.title,
          school_code: subject.school_code,
          subject_code: subject.code,
        }
      : null;
  }
  async overview() {
    const [subjects, materials, versions, generationRuns, questions, exams] =
      await Promise.all([
        this.db.find("subjects", {}, { code: 1 }),
        this.db.find("materials", {}, { created_at: -1 }),
        this.db.find("material_versions", {}, { version_number: -1 }),
        this.db.find("generation_runs", {}, { created_at: -1 }, 20),
        this.db.find("questions", {}, { created_at: -1 }, 100),
        this.db.find("exams", {}, { created_at: -1 }, 30),
      ]);
    return {
      subjects,
      materials: materials.map((m) => ({
        ...m,
        material_versions: versions.filter((v) => v.material_id === m.id),
      })),
      generationRuns,
      questions,
      exams,
    };
  }
  async readyVersions(subjectId: string, ids: string[]) {
    const materials = await this.db.find("materials", {
      subject_id: subjectId,
    });
    return this.db.find("material_versions", {
      id: { $in: ids },
      material_id: { $in: materials.map((m) => m.id) },
      status: "ready",
    });
  }
  async listMaterials(
    schoolCode: string,
    subjectCode: string,
  ): Promise<DataRow[]> {
    const subject = await this.db.findOne("subjects", {
      school_code: schoolCode.toLowerCase(),
      code: subjectCode.toUpperCase(),
    });
    if (!subject) return [];
    const materials = await this.db.find(
      "materials",
      { subject_id: subject.id },
      { created_at: -1 },
    );
    const versions = await this.db.find(
      "material_versions",
      { material_id: { $in: materials.map((m) => m.id) }, status: "ready" },
      { version_number: -1 },
    );
    return materials.flatMap((m) =>
      versions
        .filter((v) => v.material_id === m.id)
        .map((v) => ({
          ...v,
          mid: m.id,
          title: m.title,
          description: m.description,
          mcreated: m.created_at,
        })),
    );
  }
  async listSubjects(
    schoolCode: string,
    userId: string,
    code?: string,
  ): Promise<DataRow[]> {
    const subjects = await this.db.find("subjects", {
      school_code: schoolCode.toLowerCase(),
      ...(code ? { code: code.toUpperCase() } : {}),
    });
    if (!subjects.length) return [];
    const ids = subjects.map((s) => s.id);
    const [exams, lastScores] = await Promise.all([
      this.db.find("exams", { subject_id: { $in: ids }, status: "published" }),
      this.db.aggregate("attempts", [
        { $match: { user_id: userId, subject_id: { $in: ids } } },
        { $sort: { submitted_at: -1 } },
        { $group: { _id: "$subject_id", score: { $first: "$score" } } },
      ]),
    ]);
    const published = new Map<string, number>(),
      last = new Map<string, number>(
        lastScores.map((r) => [r._id as string, r.score as number]),
      );
    for (const e of exams)
      published.set(e.subject_id, (published.get(e.subject_id) ?? 0) + 1);
    return subjects.map((s) => ({
      ...s,
      published_exam_count: published.get(s.id) ?? 0,
      last_score: last.get(s.id) ?? null,
    }));
  }
  /** Exam questions that may be served and graded: approved and still existing. */
  private async servable(exam: DataRow) {
    const links = [...(exam.exam_questions ?? [])].sort(
      (a: DataRow, b: DataRow) => a.position - b.position,
    );
    const questions = await this.db.find("questions", {
      id: { $in: links.map((l: DataRow) => l.question_id) },
      status: "approved",
    });
    const byId = new Map(questions.map((q) => [q.id as string, q]));
    return links.flatMap((l: DataRow) => {
      const question = byId.get(l.question_id);
      return question ? [{ question, points: Number(l.points ?? 1) }] : [];
    });
  }
  private publicSubject(s: DataRow) {
    return {
      id: s.id,
      schoolCode: s.school_code,
      code: s.display_code ?? s.code,
      name: s.name,
    };
  }
  private publicOptions(q: DataRow) {
    return [...(q.question_options ?? [])]
      .sort((a: DataRow, b: DataRow) => a.position - b.position)
      .map((o: DataRow) => ({ position: o.position, content: o.content }));
  }
  private async publishedExam(examId: string) {
    const exam = await this.db.findOne("exams", {
      id: examId,
      status: "published",
    });
    if (!exam) throw new AppError(404, "Không tìm thấy đề thi.", "NOT_FOUND");
    const subject = await this.db.findOne("subjects", { id: exam.subject_id });
    if (!subject) throw new AppError(404, "Không tìm thấy đề thi.", "NOT_FOUND");
    const items = await this.servable(exam);
    if (!items.length)
      throw new AppError(409, "Đề thi chưa có câu hỏi.", "EXAM_EMPTY");
    return { exam, items, subject };
  }
  async listSubjectExams(subjectId: string, userId: string) {
    if (!(await this.db.findOne("subjects", { id: subjectId })))
      throw new AppError(404, "Không tìm thấy môn học.", "NOT_FOUND");
    const exams = await this.db.find(
      "exams",
      { subject_id: subjectId, status: "published" },
      { published_at: -1 },
    );
    const scores = await this.db.aggregate("attempts", [
      { $match: { user_id: userId, exam_id: { $in: exams.map((e) => e.id) } } },
      { $sort: { submitted_at: -1 } },
      { $group: { _id: "$exam_id", score: { $first: "$score" } } },
    ]);
    const last = new Map(scores.map((r) => [r._id as string, r.score]));
    return Promise.all(
      exams.map(async (e) => ({
        id: e.id,
        title: e.title,
        durationMinutes: e.duration_minutes,
        questionCount: (await this.servable(e)).length,
        publishedAt: e.published_at ?? null,
        lastScore: last.get(e.id) ?? null,
      })),
    );
  }
  async getExamForPlay(examId: string) {
    const { exam, items, subject } = await this.publishedExam(examId);
    return {
      id: exam.id,
      title: exam.title,
      durationMinutes: exam.duration_minutes,
      questionCount: items.length,
      subject: this.publicSubject(subject),
      questions: items.map(({ question: q }) => ({
        id: q.id,
        prompt: q.prompt,
        options: this.publicOptions(q),
      })),
    };
  }
  async submitAttempt(
    userId: string,
    examId: string,
    body: {
      answers: Array<{ questionId: string; selectedPosition: number | null }>;
      spentSec: number;
    },
  ) {
    return this.db.transaction(async () => {
      const { exam, items, subject } = await this.publishedExam(examId);
      const chosen = new Map<string, number | null>(),
        valid = new Set(items.map((i) => i.question.id as string));
      for (const a of body.answers) {
        if (chosen.has(a.questionId))
          throw new AppError(400, "Câu trả lời bị trùng.", "DUPLICATE_ANSWER");
        if (!valid.has(a.questionId))
          throw new AppError(
            400,
            "Câu hỏi không thuộc đề thi.",
            "INVALID_QUESTION",
          );
        chosen.set(a.questionId, a.selectedPosition);
      }
      let earned = 0,
        total = 0,
        correct = 0;
      const answers = items.map(({ question: q, points }) => {
        const right = (q.question_options ?? []).find(
            (o: DataRow) => o.is_correct,
          ),
          selected = chosen.get(q.id) ?? null,
          isCorrect = selected !== null && selected === right?.position;
        total += points;
        if (isCorrect) {
          earned += points;
          correct++;
        }
        return {
          question_id: q.id,
          selected_position: selected,
          correct_position: right?.position ?? null,
          is_correct: isCorrect,
          points,
        };
      });
      const score = total > 0 ? Math.round((earned / total) * 100) / 10 : 0;
      const attemptId = await this.insert("attempts", {
        user_id: userId,
        exam_id: exam.id,
        subject_id: exam.subject_id,
        school_code: subject.school_code,
        answers,
        correct_count: correct,
        total_count: items.length,
        score,
        spent_sec: Math.min(body.spentSec, exam.duration_minutes * 60 + 60),
        submitted_at: now(),
      });
      return {
        attemptId,
        score,
        correctCount: correct,
        totalCount: items.length,
      };
    });
  }
  private async attemptItems(rows: DataRow[]) {
    const [exams, subjects] = await Promise.all([
      this.db.find("exams", { id: { $in: [...new Set(rows.map((r) => r.exam_id))] } }),
      this.db.find("subjects", {
        id: { $in: [...new Set(rows.map((r) => r.subject_id))] },
      }),
    ]);
    const e = new Map(exams.map((x) => [x.id as string, x])),
      s = new Map(subjects.map((x) => [x.id as string, x]));
    return rows.map((r) => ({
      id: r.id,
      examId: r.exam_id,
      examTitle: e.get(r.exam_id)?.title ?? null,
      subjectId: r.subject_id,
      subjectCode: s.get(r.subject_id)
        ? (s.get(r.subject_id)!.display_code ?? s.get(r.subject_id)!.code)
        : null,
      subjectName: s.get(r.subject_id)?.name ?? null,
      score: r.score,
      correctCount: r.correct_count,
      totalCount: r.total_count,
      submittedAt: r.submitted_at,
    }));
  }
  async listMyAttempts(userId: string, limit: number, before?: string) {
    const rows = await this.db.find(
      "attempts",
      {
        user_id: userId,
        ...(before ? { submitted_at: { $lt: before } } : {}),
      },
      { submitted_at: -1 },
      limit,
    );
    const attempts = await this.attemptItems(rows);
    return {
      attempts,
      nextBefore:
        attempts.length === limit ? attempts[attempts.length - 1]!.submittedAt : null,
    };
  }
  async dashboard(user: { id: string; schoolId: string }) {
    const userId = user.id;
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const [totals, week, recent, perSubject] = await Promise.all([
      this.db.aggregate("attempts", [
        { $match: { user_id: userId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            avg: { $avg: "$score" },
            subjects: { $addToSet: "$subject_id" },
          },
        },
      ]),
      this.db.count("attempts", { user_id: userId, submitted_at: { $gte: weekAgo } }),
      this.db.find("attempts", { user_id: userId }, { submitted_at: -1 }, 8),
      this.db.aggregate("attempts", [
        { $match: { user_id: userId } },
        {
          $group: {
            _id: "$subject_id",
            avg: { $avg: "$score" },
            last: { $max: "$submitted_at" },
          },
        },
        { $sort: { avg: 1, last: -1 } },
        { $limit: 1 },
      ]),
    ]);
    const t = totals[0];
    let rankPercentile: number | null = null;
    if (t) {
      const cohortUsers = await this.db.aggregate("users", [
        { $match: { school_id: user.schoolId, status: "active" } },
        { $project: { _id: 0, id: 1 } },
      ]);
      const means = await this.db.aggregate("attempts", [
        { $match: { user_id: { $in: cohortUsers.map((u) => u.id) } } },
        { $group: { _id: "$user_id", avg: { $avg: "$score" } } },
      ]);
      const mine = means.find((m) => m._id === userId);
      if (mine && means.length >= 5) {
        const rank = 1 + means.filter((m) => m.avg > mine.avg).length;
        rankPercentile = Math.ceil((rank / means.length) * 100);
      }
    }
    let weakestSubject = null;
    if (perSubject[0]) {
      const subject = await this.db.findOne("subjects", { id: perSubject[0]._id });
      if (subject)
        weakestSubject = {
          subjectId: subject.id,
          code: subject.display_code ?? subject.code,
          name: subject.name,
          averageScore: Math.round(perSubject[0].avg * 10) / 10,
        };
    }
    return {
      stats: {
        totalAttempts: t?.total ?? 0,
        averageScore: t ? Math.round(t.avg * 10) / 10 : null,
        attemptsThisWeek: week,
        subjectsInProgress: t?.subjects.length ?? 0,
        rankPercentile,
      },
      trend: recent
        .map((r) => ({ score: r.score, submittedAt: r.submitted_at }))
        .reverse(),
      recentAttempts: await this.attemptItems(recent.slice(0, 5)),
      weakestSubject,
    };
  }
  async wrongAnswers(userId: string, limit: number) {
    const latest = await this.db.aggregate("attempts", [
      { $match: { user_id: userId } },
      { $sort: { submitted_at: -1 } },
      { $unwind: "$answers" },
      {
        $group: {
          _id: "$answers.question_id",
          answer: { $first: "$answers" },
          submitted_at: { $first: "$submitted_at" },
          subject_id: { $first: "$subject_id" },
        },
      },
      { $match: { "answer.is_correct": false } },
      { $sort: { submitted_at: -1 } },
      { $limit: limit * 2 },
    ]);
    const [questions, subjects] = await Promise.all([
      this.db.find("questions", { id: { $in: latest.map((l) => l._id) } }),
      this.db.find("subjects", {
        id: { $in: [...new Set(latest.map((l) => l.subject_id))] },
      }),
    ]);
    const qm = new Map(questions.map((q) => [q.id as string, q])),
      sm = new Map(subjects.map((s) => [s.id as string, s]));
    const text = (q: DataRow, pos: number | null) =>
      pos == null
        ? null
        : ((q.question_options ?? []).find((o: DataRow) => o.position === pos)
            ?.content ?? null);
    return latest
      .flatMap((l) => {
        const q = qm.get(l._id);
        if (!q) return [];
        const s = sm.get(l.subject_id);
        return [
          {
            questionId: l._id,
            subjectId: l.subject_id,
            subjectCode: s ? (s.display_code ?? s.code) : null,
            subjectName: s?.name ?? null,
            prompt: q.prompt,
            yourAnswer: text(q, l.answer.selected_position),
            correctAnswer: text(q, l.answer.correct_position),
            explanation: q.explanation ?? null,
            submittedAt: l.submitted_at,
          },
        ];
      })
      .slice(0, limit);
  }
  async getAttempt(userId: string, attemptId: string) {
    const attempt = await this.db.findOne("attempts", {
      id: attemptId,
      user_id: userId,
    });
    if (!attempt)
      throw new AppError(404, "Không tìm thấy bài làm.", "NOT_FOUND");
    const [exam, subject, questions] = await Promise.all([
      this.db.findOne("exams", { id: attempt.exam_id }),
      this.db.findOne("subjects", { id: attempt.subject_id }),
      this.db.find("questions", {
        id: { $in: attempt.answers.map((a: DataRow) => a.question_id) },
      }),
    ]);
    const byId = new Map(questions.map((q) => [q.id as string, q]));
    return {
      id: attempt.id,
      score: attempt.score,
      correctCount: attempt.correct_count,
      totalCount: attempt.total_count,
      spentSec: attempt.spent_sec,
      submittedAt: attempt.submitted_at,
      exam: {
        id: attempt.exam_id,
        title: exam?.title ?? null,
        durationMinutes: exam?.duration_minutes ?? null,
      },
      subject: subject
        ? this.publicSubject(subject)
        : { id: attempt.subject_id, schoolCode: attempt.school_code },
      questions: attempt.answers.map((a: DataRow) => {
        const q = byId.get(a.question_id);
        return {
          id: a.question_id,
          prompt: q?.prompt ?? null,
          options: q ? this.publicOptions(q) : [],
          selectedPosition: a.selected_position,
          correctPosition: a.correct_position,
          isCorrect: a.is_correct,
          explanation: q?.explanation ?? null,
        };
      }),
    };
  }
  async changeRole(actor: string, userId: string, role: string) {
    return this.db.transaction(async () => {
      if ((await this.db.findUserById(actor))?.role !== "admin")
        throw new AppError(403, "Không có quyền quản trị.", "FORBIDDEN");
      if (actor === userId)
        throw new AppError(
          400,
          "Không thể tự đổi vai trò của mình.",
          "SELF_ROLE_CHANGE",
        );
      const target = await this.db.findUserById(userId);
      if (!target)
        throw new AppError(404, "Không tìm thấy tài khoản.", "NOT_FOUND");
      if (target.status !== "active")
        throw new AppError(
          400,
          "Tài khoản chưa xác thực email.",
          "ACCOUNT_NOT_ACTIVE",
        );
      if (target.role === role) return;
      if (
        target.role === "admin" &&
        role === "student" &&
        (await this.db.count("users", { role: "admin", status: "active" })) <= 1
      )
        throw new AppError(
          400,
          "Không thể hạ quyền admin cuối cùng.",
          "LAST_ADMIN",
        );
      await this.db.update(
        "users",
        { id: userId },
        { $set: { role, updated_at: now() } },
      );
      await this.audit(actor, "user.role_changed", "user", userId, {
        from: target.role,
        to: role,
      });
    });
  }
  async createSubject(
    actor: string,
    body: {
      schoolCode: string;
      code: string;
      name: string;
      description?: string | undefined;
    },
  ) {
    return this.db.transaction(async () => {
      const filter = {
        school_code: body.schoolCode.toLowerCase(),
        code: body.code.toUpperCase(),
      };
      const existing = await this.db.findOne("subjects", filter);
      if (existing)
        await this.db.update(
          "subjects",
          { id: existing.id },
          { $set: { name: body.name, description: body.description || null } },
        );
      else
        await this.insert("subjects", {
          ...filter,
          name: body.name,
          description: body.description || null,
          created_by: actor,
          created_at: now(),
        });
      return this.db.findOne("subjects", filter);
    });
  }
  async createMaterial(
    actor: string,
    body: {
      subjectId: string;
      materialId?: string | undefined;
      title: string;
      description?: string | undefined;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    },
  ) {
    return this.db.transaction(async () => {
      if (!(await this.db.findOne("subjects", { id: body.subjectId })))
        throw new AppError(404, "Không tìm thấy môn học.", "NOT_FOUND");
      let materialId = body.materialId;
      if (materialId) {
        const material = await this.db.findOne("materials", { id: materialId });
        if (material?.subject_id !== body.subjectId)
          throw new AppError(
            400,
            "Tài liệu không thuộc môn đã chọn.",
            "INVALID_MATERIAL",
          );
      } else
        materialId = await this.insert("materials", {
          subject_id: body.subjectId,
          title: body.title,
          description: body.description || null,
          created_by: actor,
          created_at: now(),
          updated_at: now(),
        });
      const last = await this.db.findOne(
        "material_versions",
        { material_id: materialId },
        { version_number: -1 },
      );
      const versionNumber = Number(last?.version_number || 0) + 1,
        versionId = randomUUID();
      await this.insert("material_versions", {
        id: versionId,
        material_id: materialId,
        version_number: versionNumber,
        original_bucket: "originals",
        original_path: `originals/${body.subjectId}/${materialId}/${versionId}/${body.fileName}`,
        original_filename: body.fileName,
        mime_type: body.mimeType,
        size_bytes: body.sizeBytes,
        created_by: actor,
        created_at: now(),
      });
      return {
        materialId,
        versionId,
        versionNumber,
        uploadPath: `/Admin/materials/${versionId}/file`,
      };
    });
  }
  async saveSlides(
    versionId: string,
    slides: Array<{
      slide_number: number;
      text_content: string;
      notes: string | null;
      image_path: string | null;
    }>,
  ) {
    await this.db.transaction(async () => {
      for (const slide of slides) {
        const id = randomUUID();
        await this.db.update(
          "slides",
          { material_version_id: versionId, slide_number: slide.slide_number },
          {
            $set: {
              slide_number: slide.slide_number,
              text_content: slide.text_content,
              notes: slide.notes,
              image_path: slide.image_path,
            },
            $setOnInsert: {
              _id: id,
              id,
              material_version_id: versionId,
              created_at: now(),
            },
          },
          true,
        );
      }
    });
  }
  async saveGenerated(
    runId: string,
    actor: string,
    subjectId: string,
    questions: Array<{
      prompt: string;
      explanation: string;
      difficulty: string;
      options: Array<{
        position: number;
        content: string;
        is_correct: boolean;
      }>;
      sources: Array<{
        material_version_id: string;
        slide_number: number;
        chunk_id: string;
        excerpt: string;
        retrieval_score: number;
      }>;
    }>,
  ) {
    return this.db.transaction(async () => {
      for (const q of questions) {
        const id = randomUUID();
        await this.insert("questions", {
          id,
          generation_run_id: runId,
          subject_id: subjectId,
          prompt: q.prompt,
          explanation: q.explanation,
          difficulty: q.difficulty,
          created_by: actor,
          created_at: now(),
          updated_at: now(),
          question_options: q.options
            .map((o) => ({ ...o, id: randomUUID(), question_id: id }))
            .sort((a, b) => a.position - b.position),
          question_sources: [
            ...new Map(q.sources.map((s) => [s.chunk_id, s])).values(),
          ].map((s) => ({ ...s, id: randomUUID(), question_id: id })),
        });
      }
      await this.db.update(
        "generation_runs",
        { id: runId },
        { $set: { status: "completed", completed_at: now() } },
      );
      await this.audit(actor, "questions.generated", "generation_run", runId, {
        saved_count: questions.length,
      });
      return questions.length;
    });
  }
  async reviewQuestion(
    actor: string,
    id: string,
    body: {
      status: string;
      prompt?: string | undefined;
      explanation?: string | undefined;
      options?:
        | Array<{ position: number; content: string; isCorrect: boolean }>
        | undefined;
    },
  ) {
    await this.db.transaction(async () => {
      const q = await this.db.findOne("questions", { id });
      if (!q) throw new AppError(404, "Không tìm thấy câu hỏi.", "NOT_FOUND");
      const options: DataRow[] = body.options
        ? body.options
            .map((o) => ({
              id:
                q.question_options.find(
                  (old: DataRow) => old.position === o.position,
                )?.id || randomUUID(),
              question_id: id,
              position: o.position,
              content: o.content,
              is_correct: o.isCorrect,
            }))
            .sort((a, b) => a.position - b.position)
        : q.question_options;
      if (
        body.status === "approved" &&
        (options.length !== 4 ||
          new Set(options.map((o) => o.position)).size !== 4 ||
          options.filter((o) => o.is_correct).length !== 1)
      )
        throw new AppError(
          400,
          "Câu hỏi phải có 4 phương án và đúng một đáp án đúng.",
          "INVALID_OPTIONS",
        );
      await this.db.update(
        "questions",
        { id },
        {
          $set: {
            status: body.status,
            prompt: body.prompt || q.prompt,
            explanation: body.explanation || q.explanation,
            approved_by: body.status === "approved" ? actor : null,
            approved_at: body.status === "approved" ? now() : null,
            updated_at: now(),
            question_options: options,
          },
        },
      );
      await this.audit(actor, `question.${body.status}`, "question", id);
    });
  }
  async createExam(
    actor: string,
    body: {
      subjectId: string;
      title: string;
      durationMinutes: number;
      questionIds: string[];
      publish: boolean;
    },
  ) {
    return this.db.transaction(async () => {
      const ids = [...new Set(body.questionIds)];
      const questions = await this.db.find("questions", {
        subject_id: body.subjectId,
        status: "approved",
        id: { $in: ids },
      });
      if (questions.length !== ids.length)
        throw new AppError(
          400,
          "Đề chỉ dùng câu hỏi đã duyệt thuộc cùng môn học.",
          "INVALID_QUESTIONS",
        );
      const status = body.publish ? "published" : "draft",
        examId = randomUUID();
      await this.insert("exams", {
        id: examId,
        subject_id: body.subjectId,
        title: body.title,
        duration_minutes: body.durationMinutes,
        status,
        created_by: actor,
        published_at: body.publish ? now() : null,
        created_at: now(),
        updated_at: now(),
        exam_questions: ids.map((id, index) => ({
          exam_id: examId,
          question_id: id,
          position: index + 1,
          points: 1,
        })),
      });
      await this.audit(
        actor,
        body.publish ? "exam.published" : "exam.created",
        "exam",
        examId,
        { question_count: ids.length },
      );
      return { examId, status };
    });
  }
}
