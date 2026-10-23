import type { AppDatabase } from "./database.js";

const VN_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 24 * 3600_000;
const PURGE_AFTER_DAY_END_MS = 7 * DAY_MS;

/** Calendar day (YYYY-MM-DD) in Asia/Ho_Chi_Minh (UTC+7, no DST). */
export function assistantDayKey(now: Date): string {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Instant the given day key ends, in UTC. */
function dayEnd(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS - VN_OFFSET_MS);
}

export type QuotaReservation =
  | { ok: true; day: string; used: number; remaining: number }
  | { ok: false; day: string; used: number; remaining: 0 };
export interface AssistantUsage {
  used: number;
  remaining: number;
  limit: number;
}

const isDuplicateKey = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

/** Per-user daily question counter for the study assistant. Stores counts only, never chat content. */
export class AssistantUsageRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Atomically takes one unit of today's quota. The conditional `$inc` plus upsert
   * means a doc already at the limit cannot match; the upsert then collides on the
   * unique (user_id, day) key, which is reported as quota exhausted.
   */
  async reserveAssistantQuota(userId: string, now: Date, limit: number): Promise<QuotaReservation> {
    const day = assistantDayKey(now);
    const key = `${userId}:${day}`;
    const filter = { user_id: userId, day, count: { $lt: limit } };
    const update = {
      $inc: { count: 1 },
      $set: { updated_at: now },
    };
    const granted = (doc: { count?: unknown } | null): QuotaReservation | null => {
      if (!doc) return null;
      const used = Number(doc.count ?? 0);
      return { ok: true, day, used, remaining: Math.max(0, limit - used) };
    };
    try {
      const doc = await this.db.findOneAndUpdate(
        "assistant_usage",
        filter,
        {
          ...update,
          $setOnInsert: { _id: key, id: key, purge_at: new Date(dayEnd(day).getTime() + PURGE_AFTER_DAY_END_MS) },
        },
        true,
      );
      const result = granted(doc);
      if (result) return result;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Either the day's document is at the limit, or a concurrent first request of the
      // day just created it. Retry the same conditional update without upsert: it only
      // matches while count < limit, so the limit still can never be exceeded.
      const retry = granted(await this.db.findOneAndUpdate("assistant_usage", filter, update, false));
      if (retry) return retry;
    }
    return { ok: false, day, used: limit, remaining: 0 };
  }

  /** Gives back one unit for the exact day that was reserved; never goes below zero. */
  async refundAssistantQuota(userId: string, day: string): Promise<void> {
    await this.db.update(
      "assistant_usage",
      { user_id: userId, day, count: { $gt: 0 } },
      { $inc: { count: -1 }, $set: { updated_at: new Date() } },
    );
  }

  async assistantUsage(userId: string, now: Date, limit: number): Promise<AssistantUsage> {
    const row = await this.db.findOne("assistant_usage", { user_id: userId, day: assistantDayKey(now) });
    const used = Math.min(limit, Number(row?.count ?? 0));
    return { used, remaining: Math.max(0, limit - used), limit };
  }
}
