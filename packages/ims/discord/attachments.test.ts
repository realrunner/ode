import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadDiscordAttachments,
  extractDiscordAttachmentReferences,
} from "./attachments";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ode-discord-attachments-test-"));
  tempDirs.push(path);
  return path;
}

describe("Discord attachments", () => {
  it("extracts attachment metadata from Discord collections", () => {
    const attachments = new Map([["A1", {
      id: "A1",
      name: "image.png",
      contentType: "image/png",
      size: 4,
      url: "https://cdn.discordapp.com/attachments/C1/A1/image.png",
    }]]);

    expect(extractDiscordAttachmentReferences({ attachments })).toEqual([{
      id: "A1",
      filename: "image.png",
      mimeType: "image/png",
      size: 4,
      downloadUrl: "https://cdn.discordapp.com/attachments/C1/A1/image.png",
    }]);
  });

  it("downloads CDN files with safe filenames", async () => {
    const storageRoot = await createTempDir();
    const fetchImpl = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response("data", {
        headers: { "content-type": "text/plain", "content-length": "4" },
      });
    });

    const result = await downloadDiscordAttachments({
      files: [{
        id: "A1",
        filename: "../../report.txt",
        mimeType: "text/plain",
        size: 4,
        downloadUrl: "https://cdn.discordapp.com/attachments/C1/A1/report.txt",
      }],
      channelId: "C1",
      threadId: "T1",
      messageId: "M1",
      storageRoot,
      fetchImpl,
    });

    expect(result.failures).toEqual([]);
    expect(result.attachments[0]?.filename).toBe("A1-report.txt");
    expect(await readFile(result.attachments[0]!.localPath, "utf8")).toBe("data");
  });

  it("rejects non-Discord and oversized downloads", async () => {
    const storageRoot = await createTempDir();
    const fetchImpl = mock(async () => new Response("unused"));
    const result = await downloadDiscordAttachments({
      files: [
        { id: "A1", filename: "bad.txt", downloadUrl: "https://example.com/bad.txt" },
        {
          id: "A2",
          filename: "large.zip",
          size: 26 * 1024 * 1024,
          downloadUrl: "https://cdn.discordapp.com/attachments/C1/A2/large.zip",
        },
      ],
      channelId: "C1",
      threadId: "T1",
      messageId: "M1",
      storageRoot,
      fetchImpl,
    });

    expect(result.attachments).toEqual([]);
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      "Discord attachment has no supported CDN URL",
      "File exceeds the download size limit",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });
});
