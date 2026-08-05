import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { InboundAttachment } from "@/core/model/inbound-attachment";

const MAX_FILES_PER_MESSAGE = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

type SlackFileReference = {
  id: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  downloadUrl?: string;
};

export type SlackAttachmentDownloadResult = {
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

function normalizeFile(value: unknown): SlackFileReference | null {
  if (!value || typeof value !== "object") return null;
  const file = value as Record<string, unknown>;
  const id = optionalString(file.id);
  if (!id) return null;
  return {
    id,
    filename: optionalString(file.name),
    mimeType: optionalString(file.mimetype),
    size: optionalSize(file.size),
    downloadUrl: optionalString(file.url_private_download) ?? optionalString(file.url_private),
  };
}

export function extractSlackFileReferences(message: unknown): SlackFileReference[] {
  if (!message || typeof message !== "object") return [];
  const event = message as Record<string, unknown>;
  const files = Array.isArray(event.files) ? event.files : [];
  const xFiles = Array.isArray(event.x_files) ? event.x_files : [];
  const byId = new Map<string, SlackFileReference>();

  for (const value of files) {
    const file = normalizeFile(value);
    if (file) byId.set(file.id, file);
  }
  for (const value of xFiles) {
    const id = optionalString(value);
    if (id && !byId.has(id)) byId.set(id, { id });
  }

  return [...byId.values()];
}

function safeSegment(value: string, fallback: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || fallback;
}

function safeFilename(file: SlackFileReference): string {
  const raw = basename(file.filename ?? "attachment")
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180) || "attachment";
  return `${safeSegment(file.id, "file")}-${raw}`;
}

function defaultStorageRoot(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "ode", "attachments", "slack");
}

function isSlackDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "files.slack.com" || url.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

async function resolveFile(
  file: SlackFileReference,
  client: { files: { info(args: { file: string }): Promise<unknown> } }
): Promise<SlackFileReference> {
  if (file.downloadUrl && file.filename && file.size !== undefined) return file;
  const response = await client.files.info({ file: file.id });
  const resolved = normalizeFile((response as { file?: unknown })?.file);
  if (!resolved) throw new Error("Slack did not return downloadable file metadata");
  return {
    ...resolved,
    ...file,
    filename: file.filename ?? resolved.filename,
    mimeType: file.mimeType ?? resolved.mimeType,
    size: file.size ?? resolved.size,
    downloadUrl: file.downloadUrl ?? resolved.downloadUrl,
  };
}

async function downloadFile(params: {
  file: SlackFileReference;
  token: string;
  directory: string;
  remainingBytes: number;
  fetchImpl: FetchImplementation;
}): Promise<InboundAttachment> {
  const { file, token, directory, remainingBytes, fetchImpl } = params;
  if (!file.downloadUrl || !isSlackDownloadUrl(file.downloadUrl)) {
    throw new Error("Slack file has no supported private download URL");
  }
  if (file.size !== undefined && file.size > Math.min(MAX_FILE_BYTES, remainingBytes)) {
    throw new Error("File exceeds the download size limit");
  }

  const response = await fetchImpl(file.downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Slack download failed with HTTP ${response.status}`);
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
      // The original download error is more useful than a secondary close error.
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

export async function downloadSlackAttachments(params: {
  files: readonly SlackFileReference[];
  client: { files: { info(args: { file: string }): Promise<unknown> } };
  token: string;
  channelId: string;
  threadId: string;
  messageId: string;
  storageRoot?: string;
  fetchImpl?: FetchImplementation;
}): Promise<SlackAttachmentDownloadResult> {
  const attachments: InboundAttachment[] = [];
  const failures: SlackAttachmentDownloadResult["failures"] = [];
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
  for (const reference of files) {
    try {
      const file = await resolveFile(reference, params.client);
      const attachment = await downloadFile({
        file,
        token: params.token,
        directory,
        remainingBytes: MAX_MESSAGE_BYTES - downloadedBytes,
        fetchImpl: params.fetchImpl ?? fetch,
      });
      downloadedBytes += attachment.size;
      attachments.push(attachment);
    } catch (error) {
      failures.push({
        id: reference.id,
        filename: reference.filename,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { attachments, failures };
}
