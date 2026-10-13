import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";
export interface FileStorage {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  size(key: string): Promise<number | null>;
}
export function createStorage(config: AppConfig): FileStorage {
  if (config.STORAGE_DRIVER === "s3") {
    const client = new S3Client({
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      },
    });
    return {
      async put(key, buffer, contentType) {
        await client.send(
          new PutObjectCommand({
            Bucket: config.S3_BUCKET!,
            Key: key,
            Body: buffer,
            ContentType: contentType,
          }),
        );
      },
      async get(key) {
        const response = await client.send(
          new GetObjectCommand({ Bucket: config.S3_BUCKET!, Key: key }),
        );
        if (!response.Body) throw new Error("File missing");
        return Buffer.from(await response.Body.transformToByteArray());
      },
      async size(key) {
        try {
          return (
            (
              await client.send(
                new HeadObjectCommand({ Bucket: config.S3_BUCKET!, Key: key }),
              )
            ).ContentLength ?? null
          );
        } catch (error) {
          if (
            (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode === 404
          )
            return null;
          throw error;
        }
      },
    };
  }
  const base = resolve(config.STORAGE_PATH);
  const file = (key: string) => {
    const target = resolve(base, key);
    if (!target.startsWith(base + sep) || key.includes("\\"))
      throw new Error("Invalid storage key");
    return target;
  };
  return {
    async put(key, buffer) {
      const target = file(key);
      await mkdir(dirname(target), { recursive: true });
      const temporary = target + "." + randomUUID() + ".tmp";
      await writeFile(temporary, buffer);
      await rename(temporary, target);
    },
    async get(key) {
      return readFile(file(key));
    },
    async size(key) {
      try {
        return (await stat(file(key))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
