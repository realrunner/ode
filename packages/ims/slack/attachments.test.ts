import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadSlackAttachments,
  extractSlackFileReferences,
} from "./attachments";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ode-slack-attachments-test-"));
  tempDirs.push(path);
  return path;
}

describe("Slack attachments", () => {
  it("extracts and deduplicates file metadata and x_files", () => {
    expect(extractSlackFileReferences({
      files: [{
        id: "F1",
        name: "image.png",
        mimetype: "image/png",
        size: 4,
        url_private_download: "https://files.slack.com/image.png",
      }],
      x_files: ["F1", "F2"],
    })).toEqual([
      {
        id: "F1",
        filename: "image.png",
        mimeType: "image/png",
        size: 4,
        downloadUrl: "https://files.slack.com/image.png",
      },
      { id: "F2" },
    ]);
  });

  it("downloads private files with authentication and safe filenames", async () => {
    const storageRoot = await createTempDir();
    const fetchImpl = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-test");
      return new Response("data", {
        headers: { "content-type": "text/plain", "content-length": "4" },
      });
    });
    const info = mock(async () => ({ file: {} }));

    const result = await downloadSlackAttachments({
      files: extractSlackFileReferences({ files: [{
        id: "F1",
        name: "../../report.txt",
        mimetype: "text/plain",
        size: 4,
        url_private_download: "https://files.slack.com/report.txt",
      }] }),
      client: { files: { info } },
      token: "xoxb-test",
      channelId: "C1",
      threadId: "1.2",
      messageId: "1.3",
      storageRoot,
      fetchImpl,
    });

    expect(result.failures).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.filename).toBe("F1-report.txt");
    expect(await readFile(result.attachments[0]!.localPath, "utf8")).toBe("data");
    expect(info).toHaveBeenCalledTimes(0);
  });

  it("resolves id-only Slack Connect file references", async () => {
    const storageRoot = await createTempDir();
    const info = mock(async () => ({
      file: {
        id: "F2",
        name: "image.png",
        mimetype: "image/png",
        size: 3,
        url_private_download: "https://files.slack.com/image.png",
      },
    }));

    const result = await downloadSlackAttachments({
      files: [{ id: "F2" }],
      client: { files: { info } },
      token: "xoxb-test",
      channelId: "C1",
      threadId: "T1",
      messageId: "M1",
      storageRoot,
      fetchImpl: async () => new Response("png"),
    });

    expect(result.attachments).toHaveLength(1);
    expect(info).toHaveBeenCalledWith({ file: "F2" });
  });

  it("rejects oversized files before downloading", async () => {
    const storageRoot = await createTempDir();
    const fetchImpl = mock(async () => new Response("unused"));
    const result = await downloadSlackAttachments({
      files: [{
        id: "F3",
        filename: "large.zip",
        mimeType: "application/zip",
        size: 26 * 1024 * 1024,
        downloadUrl: "https://files.slack.com/large.zip",
      }],
      client: { files: { info: async () => ({}) } },
      token: "xoxb-test",
      channelId: "C1",
      threadId: "T1",
      messageId: "M1",
      storageRoot,
      fetchImpl,
    });

    expect(result.attachments).toEqual([]);
    expect(result.failures[0]?.reason).toContain("size limit");
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });
});
