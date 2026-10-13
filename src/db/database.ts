import { AsyncLocalStorage } from "node:async_hooks";
import {
  MongoClient,
  type ClientSession,
  type Filter,
  type Sort,
  type UpdateFilter,
} from "mongodb";
import type { OtpPurpose, User } from "../domain/types.js";
import { initializeCollections } from "./indexes.js";

export type DataRow = Record<string, any>;
export type AppDocument = DataRow & { _id: string; id: string };
export interface OtpRow {
  id: string;
  userId: string;
  purpose: OtpPurpose;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  consumedAt: string | null;
}
export interface RefreshTokenRow {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}
function mapUser(row: DataRow): User {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    passwordHash: row.password_hash,
    mssv: row.mssv,
    schoolId: row.school_id,
    role: row.role,
    status: row.status,
    googleSubject: row.google_subject,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
const now = () => new Date().toISOString();

/** MongoDB is the only application database. All operations inherit the current session. */
export class AppDatabase {
  readonly client: MongoClient;
  readonly ready: Promise<void>;
  private context = new AsyncLocalStorage<ClientSession>();
  constructor(
    uri: string,
    readonly databaseName = "examcure",
  ) {
    this.client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 20,
    });
    this.ready = this.initialize();
    // Startup/request handlers await this promise; avoid an unhandled rejection meanwhile.
    void this.ready.catch(() => undefined);
  }
  private async initialize() {
    await this.client.connect();
    const hello = await this.client.db(this.databaseName).command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid")
      throw new Error(
        "MongoDB must be a replica set or Atlas cluster to support auth/admin transactions",
      );
    await initializeCollections(this.client.db(this.databaseName));
  }
  private collection(name: string) {
    return this.client.db(this.databaseName).collection<AppDocument>(name);
  }
  private options() {
    const session = this.context.getStore();
    return session ? { session } : {};
  }
  async find(
    name: string,
    filter: Filter<AppDocument> = {},
    sort: Sort = {},
    limit = 0,
  ): Promise<DataRow[]> {
    await this.ready;
    return this.collection(name)
      .find(filter, { ...this.options(), projection: { _id: 0 } })
      .sort(sort)
      .limit(limit)
      .toArray();
  }
  async findOne(
    name: string,
    filter: Filter<AppDocument>,
    sort: Sort = {},
  ): Promise<DataRow | null> {
    await this.ready;
    return this.collection(name).findOne(filter, {
      ...this.options(),
      sort,
      projection: { _id: 0 },
    });
  }
  async aggregate(name: string, pipeline: DataRow[]): Promise<DataRow[]> {
    await this.ready;
    return this.collection(name)
      .aggregate(pipeline, this.options())
      .toArray();
  }
  async count(name: string, filter: Filter<AppDocument> = {}) {
    await this.ready;
    return this.collection(name).countDocuments(filter, this.options());
  }
  async insert(name: string, row: DataRow & { id: string }): Promise<void> {
    await this.ready;
    await this.collection(name).insertOne(
      { ...row, _id: row.id },
      this.options(),
    );
  }
  async update(
    name: string,
    filter: Filter<AppDocument>,
    update: UpdateFilter<AppDocument>,
    upsert = false,
  ) {
    await this.ready;
    return this.collection(name).updateOne(filter, update, {
      ...this.options(),
      upsert,
    });
  }
  async updateMany(
    name: string,
    filter: Filter<AppDocument>,
    update: UpdateFilter<AppDocument>,
  ) {
    await this.ready;
    return this.collection(name).updateMany(filter, update, this.options());
  }
  async deleteMany(name: string, filter: Filter<AppDocument>) {
    await this.ready;
    return this.collection(name).deleteMany(filter, this.options());
  }
  async transaction<T>(task: () => Promise<T>): Promise<T> {
    await this.ready;
    if (this.context.getStore()) return task();
    const session = this.client.startSession();
    try {
      return await session.withTransaction(
        () =>
          this.context.run(session, async () => {
            // Serialize business invariants across processes. A write conflict retries the
            // whole snapshot, so concurrent bootstrap/role changes cannot remove every admin.
            const locked = await this.collection("system_state").updateOne(
              { _id: "business-lock" },
              { $inc: { revision: 1 } },
              { session },
            );
            if (locked.matchedCount !== 1)
              throw new Error(
                "MongoDB transaction state is missing; restart the API to initialize it",
              );
            return task();
          }),
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
        },
      );
    } finally {
      await session.endSession();
    }
  }
  async findUserByEmail(email: string): Promise<User | null> {
    const row = await this.findOne("users", { email: email.toLowerCase() });
    return row ? mapUser(row) : null;
  }
  async findUserById(id: string): Promise<User | null> {
    const row = await this.findOne("users", { id });
    return row ? mapUser(row) : null;
  }
  async findUserByGoogleSubject(subject: string): Promise<User | null> {
    const row = await this.findOne("users", { google_subject: subject });
    return row ? mapUser(row) : null;
  }
  async createUser(
    input: Omit<User, "createdAt" | "updatedAt">,
  ): Promise<User> {
    const timestamp = now();
    await this.insert("users", {
      id: input.id,
      email: input.email.toLowerCase(),
      full_name: input.fullName,
      password_hash: input.passwordHash,
      mssv: input.mssv,
      school_id: input.schoolId,
      role: input.role,
      status: input.status,
      google_subject: input.googleSubject,
      email_verified_at: input.emailVerifiedAt,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return (await this.findUserById(input.id))!;
  }
  async updatePendingUser(
    id: string,
    fullName: string,
    passwordHash: string,
    mssv: string,
    schoolId: string,
  ): Promise<User> {
    await this.update(
      "users",
      { id, status: "pending" },
      {
        $set: {
          full_name: fullName,
          password_hash: passwordHash,
          mssv,
          school_id: schoolId,
          updated_at: now(),
        },
      },
    );
    return (await this.findUserById(id))!;
  }
  async activateUser(id: string): Promise<User> {
    const user = (await this.findUserById(id))!;
    await this.update(
      "users",
      { id },
      {
        $set: {
          status: "active",
          email_verified_at: user.emailVerifiedAt || now(),
          updated_at: now(),
        },
      },
    );
    return (await this.findUserById(id))!;
  }
  async connectGoogle(
    id: string,
    subject: string,
    fullName: string,
  ): Promise<User> {
    const user = (await this.findUserById(id))!;
    await this.update(
      "users",
      { id },
      {
        $set: {
          google_subject: subject,
          full_name: fullName,
          password_hash: user.status === "pending" ? null : user.passwordHash,
          status: "active",
          email_verified_at: user.emailVerifiedAt || now(),
          updated_at: now(),
        },
      },
    );
    return (await this.findUserById(id))!;
  }
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.update(
      "users",
      { id },
      { $set: { password_hash: passwordHash, updated_at: now() } },
    );
  }
  async updateProfile(
    id: string,
    fullName: string,
    mssv: string,
    schoolId: string,
  ): Promise<User> {
    await this.update(
      "users",
      { id },
      {
        $set: {
          full_name: fullName,
          mssv,
          school_id: schoolId,
          updated_at: now(),
        },
      },
    );
    return (await this.findUserById(id))!;
  }
  async replaceOtp(input: OtpRow): Promise<void> {
    await this.transaction(async () => {
      await this.updateMany(
        "otp_codes",
        { user_id: input.userId, purpose: input.purpose, consumed_at: null },
        { $set: { consumed_at: now() } },
      );
      await this.insert("otp_codes", {
        id: input.id,
        user_id: input.userId,
        purpose: input.purpose,
        code_hash: input.codeHash,
        expires_at: input.expiresAt,
        attempts: input.attempts,
        consumed_at: input.consumedAt,
        created_at: now(),
        purge_at: new Date(Date.parse(input.expiresAt) + 86400000),
      });
    });
  }
  async getLatestOtp(
    userId: string,
    purpose: OtpPurpose,
  ): Promise<OtpRow | null> {
    // Replacement consumes previous codes atomically. Prefer the only live code
    // even when two replacements have the same millisecond timestamp.
    const filter = { user_id: userId, purpose };
    const row =
      (await this.findOne("otp_codes", { ...filter, consumed_at: null })) ??
      (await this.findOne("otp_codes", filter, { created_at: -1, id: -1 }));
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          purpose: row.purpose,
          codeHash: row.code_hash,
          expiresAt: row.expires_at,
          attempts: row.attempts,
          consumedAt: row.consumed_at,
        }
      : null;
  }
  async incrementOtpAttempts(id: string): Promise<void> {
    await this.update("otp_codes", { id }, { $inc: { attempts: 1 } });
  }
  async consumeOtp(id: string): Promise<void> {
    await this.update("otp_codes", { id }, { $set: { consumed_at: now() } });
  }
  async createRefreshToken(
    id: string,
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<void> {
    await this.insert("refresh_tokens", {
      id,
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null,
      created_at: now(),
      purge_at: new Date(Date.parse(expiresAt) + 86400000),
    });
  }
  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
    const row = await this.findOne("refresh_tokens", { token_hash: tokenHash });
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
        }
      : null;
  }
  async revokeRefreshToken(id: string): Promise<void> {
    await this.update(
      "refresh_tokens",
      { id, revoked_at: null },
      { $set: { revoked_at: now() } },
    );
  }
  async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.updateMany(
      "refresh_tokens",
      { user_id: userId, revoked_at: null },
      { $set: { revoked_at: now() } },
    );
  }
  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    await this.client.close();
  }
}
