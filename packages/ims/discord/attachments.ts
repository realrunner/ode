import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { InboundAttachment } from "@/core/model/inbound-attachment";

const MAX_FILES_PER_MESSAGE = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type DiscordAttachmentReference = {
  id: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  downloadUrl?: string;
};

export type DiscordAttachmentDownloadResult = {
  attachments: InboundAttachment[];
  failures: Array<{ id: string; filename?: string; reason: string }>;
};

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizeAttachment(value: unknown): DiscordAttachmentReference | null {
  if (!value || typeof value !== "object") return null;
  const attachment = value as Record<string, unknown>;
  const id = optionalString(attachment.id);
  if (!id) return null;
  return {
    id,
    filename: optionalString(attachment.name) ?? optionalString(attachment.filename),
    mimeType: optionalString(attachment.contentType) ?? optionalString(attachment.content_type),
    size: optionalSize(attachment.size),
    downloadUrl: optionalString(attachment.url),
  };
}

export function extractDiscordAttachmentReferences(message: unknown): DiscordAttachmentReference[] {
  if (!message || typeof message !== "object") return [];
  const attachments = (message as { attachments?: unknown }).attachments;
  let values: unknown[] = [];
  if (Array.isArray(attachments)) {
    values = attachments;
  } else if (attachments && typeof attachments === "object" && Symbol.iterator in attachments) {
    values = Array.from(attachments as Iterable<unknown>, (entry) =>
      Array.isArray(entry) && entry.length === 2 ? entry[1] : entry
    );
  }
  return values.map(normalizeAttachment).filter((file): file is DiscordAttachmentReference => Boolean(file));
}

function safeSegment(value: string, fallback: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || fallback;
}

function safeFilename(file: DiscordAttachmentReference): string {
  const raw = basename(file.filename ?? "attachment")
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180) || "attachment";
  return `${safeSegment(file.id, "file")}-${raw}`;
}

function defaultStorageRoot(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "ode", "attachments", "discord");
}

function isDiscordDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net");
  } catch {
    return false;
  }
}

async function downloadFile(params: {
  file: DiscordAttachmentReference;
  directory: string;
  remainingBytes: number;
  fetchImpl: FetchImplementation;
}): Promise<InboundAttachment> {
  const { file, directory, remainingBytes, fetchImpl } = params;
  if (!file.downloadUrl || !isDiscordDownloadUrl(file.downloadUrl)) {
    throw new Error("Discord attachment has no supported CDN URL");
  }
  if (file.size !== undefined && file.size > Math.min(MAX_FILE_BYTES, remainingBytes)) {
    throw new Error("File exceeds the download size limit");
  }

  const response = await fetchImpl(file.downloadUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Discord download failed with HTTP ${response.status}`);
  }

  const allowedBytes = Math.min(MAX_FILE_BYTES, remainingBytes);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > allowedBytes) {
    throw new Error("File exceeds the download size limit");
  }

  const filename = safeFilename(file);
  const localPath = join(directory, filename);
  const partialPath = `${localPath}.part`;
  const reader = response.body.getReader();
  const writer = Bun.file(partialPath).writer({ highWaterMark: 64 * 1024 });
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > allowedBytes) {
        await reader.cancel();
        throw new Error("File exceeds the download size limit");
      }
      await writer.write(value);
    }
    await writer.end();
    await rename(partialPath, localPath);
  } catch (error) {
    try {
      await writer.end();
    } catch {
      // Preserve the original download error.
    }
    await rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    id: file.id,
    filename,
    mimeType: file.mimeType || response.headers.get("content-type") || "application/octet-stream",
    size,
    localPath,
  };
}

export async function downloadDiscordAttachments(params: {
  files: readonly DiscordAttachmentReference[];
  channelId: string;
  threadId: string;
  messageId: string;
  storageRoot?: string;
  fetchImpl?: FetchImplementation;
}): Promise<DiscordAttachmentDownloadResult> {
  const attachments: InboundAttachment[] = [];
  const failures: DiscordAttachmentDownloadResult["failures"] = [];
  const files = params.files.slice(0, MAX_FILES_PER_MESSAGE);
  const directory = join(
    params.storageRoot ?? defaultStorageRoot(),
    safeSegment(params.channelId, "channel"),
    safeSegment(params.threadId, "thread"),
    safeSegment(params.messageId, "message")
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });

  if (params.files.length > MAX_FILES_PER_MESSAGE) {
    failures.push({ id: "additional-files", reason: `Only the first ${MAX_FILES_PER_MESSAGE} files are supported` });
  }

  let downloadedBytes = 0;
  for (const file of files) {
    try {
      const attachment = await downloadFile({
        file,
        directory,
        remainingBytes: MAX_MESSAGE_BYTES - downloadedBytes,
        fetchImpl: params.fetchImpl ?? fetch,
      });
      downloadedBytes += attachment.size;
      attachments.push(attachment);
    } catch (error) {
      failures.push({
        id: file.id,
        filename: file.filename,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { attachments, failures };
}
