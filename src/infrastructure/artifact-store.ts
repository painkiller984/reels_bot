import { createReadStream } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactStore } from "../application/ports.js";
import type { Artifact } from "../domain/job.js";

export class LocalArtifactStore implements ArtifactStore {
  readonly name = "local";

  async persist(_jobId: string, artifact: Artifact): Promise<string> {
    return artifact.uri;
  }

  async materialize(uri: string): Promise<string> {
    await access(uri);
    return uri;
  }

  async createDownloadUrl(_uri: string): Promise<undefined> {
    return undefined;
  }
}

export interface R2ArtifactStoreOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  cacheDir: string;
  signedUrlTtlSec: number;
}

export class R2ArtifactStore implements ArtifactStore {
  readonly name = "cloudflare-r2";
  private readonly client: S3Client;

  constructor(private readonly options: R2ArtifactStoreOptions) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async persist(jobId: string, artifact: Artifact): Promise<string> {
    if (artifact.uri.startsWith("r2://") || artifact.uri.startsWith("mock://")) return artifact.uri;
    const file = await stat(artifact.uri);
    const safeName = basename(artifact.uri).replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${jobId}/${artifact.kind}-${safeName}`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      Body: createReadStream(artifact.uri),
      ContentLength: file.size,
      ContentType: contentTypeFor(artifact.uri),
      Metadata: { jobId, artifactKind: artifact.kind },
    }));
    return this.uriFor(key);
  }

  async materialize(uri: string): Promise<string> {
    if (!uri.startsWith("r2://")) {
      await access(uri);
      return uri;
    }
    const key = this.keyFromUri(uri);
    const destination = this.cachePath(key);
    try {
      await access(destination);
      return destination;
    } catch {
      // Cache miss is expected after a deploy or service restart.
    }
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (!response.Body) throw new Error(`R2 object has no body: ${key}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await response.Body.transformToByteArray());
    return destination;
  }

  async createDownloadUrl(uri: string): Promise<string | undefined> {
    if (!uri.startsWith("r2://")) return undefined;
    const key = this.keyFromUri(uri);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { expiresIn: this.options.signedUrlTtlSec },
    );
  }

  private uriFor(key: string): string {
    return `r2://${this.options.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private keyFromUri(uri: string): string {
    const parsed = new URL(uri);
    if (parsed.protocol !== "r2:" || parsed.hostname !== this.options.bucket) {
      throw new Error("R2 artifact points to an unexpected bucket");
    }
    const key = parsed.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
    if (!key || key.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new Error("Invalid R2 object key");
    }
    return key;
  }

  private cachePath(key: string): string {
    const root = resolve(this.options.cacheDir);
    const destination = resolve(root, ...key.split("/"));
    if (destination !== root && !destination.startsWith(root + sep)) throw new Error("Invalid R2 cache path");
    return destination;
  }
}

function contentTypeFor(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".mp4": return "video/mp4";
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".json": return "application/json";
    default: return "application/octet-stream";
  }
}
