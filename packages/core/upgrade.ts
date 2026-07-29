import { basename, dirname, join } from "path";
import { mkdtemp, chmod, copyFile, rm, rename } from "fs/promises";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawn } from "child_process";

const LATEST_RELEASE_URL = "https://api.github.com/repos/realrunner/ode/releases/latest";
const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/realrunner/ode/releases/download";

type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string | null;
  isUpdateAvailable: boolean;
};

type LatestReleaseInfo = {
  tag: string;
  version: string | null;
};

function normalizeVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim().replace(/^v/, "");
  if (!trimmed) return null;
  return trimmed.split("-")[0] ?? null;
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10));
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const aValue = Number.isFinite(aParts[i]) ? (aParts[i] as number) : 0;
    const bValue = Number.isFinite(bParts[i]) ? (bParts[i] as number) : 0;
    if (aValue > bValue) return 1;
    if (aValue < bValue) return -1;
  }
  return 0;
}

async function fetchLatestReleaseInfo(): Promise<LatestReleaseInfo | null> {
  try {
    const latestResponse = await fetch(LATEST_RELEASE_URL);
    if (!latestResponse.ok) return null;
    const latest = (await latestResponse.json()) as { tag_name?: string };
    const tag = typeof latest.tag_name === "string" ? latest.tag_name.trim() : "";
    if (!tag) return null;
    return {
      tag,
      version: normalizeVersion(tag),
    };
  } catch {
    return null;
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseSha256SumFile(content: string, assetName: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const hash = match[1]?.toLowerCase();
    const fileName = basename((match[2] ?? "").trim());
    if (fileName !== assetName) continue;
    return hash ?? null;
  }
  return null;
}

function resolveAsset(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    if (arch === "arm64") return "ode-darwin-arm64";
    if (arch === "x64") return "ode-darwin-x64";
  }

  if (platform === "linux") {
    if (arch === "x64") return "ode-linux-x64";
  }

  if (platform === "win32") {
    if (arch === "x64") return "ode-windows-x64.exe";
  }

  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

export function isInstalledBinary(): boolean {
  const execName = basename(process.execPath);
  return execName === "ode" || execName === "ode.exe";
}

function runCodesign(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => resolve({ code: -1, stderr }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/**
 * macOS AMFI refuses to execute completely unsigned binaries. Bun's --compile
 * output is nominally ad-hoc signed, but a malformed LC_CODE_SIGNATURE slips
 * through sometimes and AMFI treats the binary as unsigned on exec. As a
 * defense-in-depth against broken release artifacts, strip any existing
 * signature and ad-hoc re-sign the downloaded binary before swapping it in.
 * Never fails loudly: if codesign is unavailable or refuses to cooperate we
 * still proceed, preserving prior behavior.
 */
async function ensureMacAdhocSigned(binPath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  // `codesign --remove-signature` fails if there is no signature at all; that
  // is fine, we only care that the sign step below succeeds.
  await runCodesign(["--remove-signature", binPath]);
  const signed = await runCodesign(["--sign", "-", "--force", "--timestamp=none", binPath]);
  if (signed.code !== 0) {
    console.error(`Warning: failed to ad-hoc sign upgraded binary: ${signed.stderr.trim()}`);
  }
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const normalizedCurrent = normalizeVersion(currentVersion) ?? "0.0.0";
  const latestRelease = await fetchLatestReleaseInfo();
  const latestVersion = latestRelease?.version ?? null;
  if (!latestVersion) {
    return {
      currentVersion: normalizedCurrent,
      latestVersion: null,
      isUpdateAvailable: false,
    };
  }

  return {
    currentVersion: normalizedCurrent,
    latestVersion,
    isUpdateAvailable: compareVersions(latestVersion, normalizedCurrent) > 0,
  };
}

export async function performUpgrade(): Promise<{ latestVersion: string | null }> {
  const latestRelease = await fetchLatestReleaseInfo();
  if (!latestRelease?.tag) {
    throw new Error("Failed to resolve latest release tag");
  }

  const latestVersion = latestRelease.version;
  const asset = resolveAsset();
  const downloadBaseUrl = `${RELEASE_DOWNLOAD_BASE_URL}/${encodeURIComponent(latestRelease.tag)}`;
  const binaryUrl = `${downloadBaseUrl}/${asset}`;
  const checksumsUrl = `${downloadBaseUrl}/SHA256SUMS`;

  const [binaryResponse, checksumsResponse] = await Promise.all([
    fetch(binaryUrl),
    fetch(checksumsUrl),
  ]);
  if (!binaryResponse.ok) {
    throw new Error(`Failed to download ${binaryUrl} (${binaryResponse.status})`);
  }
  if (!checksumsResponse.ok) {
    throw new Error(`Failed to download ${checksumsUrl} (${checksumsResponse.status})`);
  }

  const [data, checksumsContent] = await Promise.all([
    binaryResponse.arrayBuffer().then((buf) => new Uint8Array(buf)),
    checksumsResponse.text(),
  ]);
  const expectedHash = parseSha256SumFile(checksumsContent, asset);
  if (!expectedHash) {
    throw new Error(`SHA256SUMS missing entry for ${asset}`);
  }
  const actualHash = sha256Hex(data);
  if (actualHash !== expectedHash) {
    throw new Error(`Checksum mismatch for ${asset}`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ode-upgrade-"));
  const tempPath = join(tempDir, asset);
  await Bun.write(tempPath, data);
  if (process.platform !== "win32") {
    await chmod(tempPath, 0o755);
  }
  await ensureMacAdhocSigned(tempPath);

  try {
    const execPath = process.execPath;
    try {
      await copyFile(tempPath, execPath);
    } catch (error) {
      if (process.platform === "win32") throw error;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== "ETXTBSY" && code !== "EBUSY") throw error;

      const execDir = dirname(execPath);
      const swapPath = join(execDir, `${basename(execPath)}.new`);
      await rm(swapPath, { force: true });
      await copyFile(tempPath, swapPath);
      await chmod(swapPath, 0o755);
      await rename(swapPath, execPath);
    }

    if (process.platform !== "win32") {
      await chmod(execPath, 0o755);
    }
  } catch (error) {
    console.error("Failed to replace the existing ode binary.");
    console.error("Try running with elevated permissions or reinstall to a writable directory.");
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return { latestVersion };
}
