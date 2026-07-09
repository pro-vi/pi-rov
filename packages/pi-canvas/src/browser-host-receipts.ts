import { createHash } from "node:crypto";

export const BROWSER_HOST_RECEIPT_SUFFIX = "-browser-host-receipt.json";

export function formatBrowserHostReceiptFileName(artifactId: string, runId: string, sourcePath: string): string {
  return `${browserHostReceiptArtifactPrefix(artifactId)}${browserHostReceiptSourcePrefix(sourcePath)}${toReceiptFilePart(runId)}${BROWSER_HOST_RECEIPT_SUFFIX}`;
}

export function browserHostReceiptFileNameMatchesSource(fileName: string, artifactId: string, sourcePath: string): boolean {
  return fileName.startsWith(`${browserHostReceiptArtifactPrefix(artifactId)}${browserHostReceiptSourcePrefix(sourcePath)}`) && fileName.endsWith(BROWSER_HOST_RECEIPT_SUFFIX);
}

export function isScopedBrowserHostReceiptFileName(fileName: string): boolean {
  return /^artifact-\d+-.*-source-[0-9a-f]{16}-.+-browser-host-receipt\.json$/.test(fileName);
}

function browserHostReceiptArtifactPrefix(artifactId: string): string {
  const filePart = toReceiptFilePart(artifactId);
  return `artifact-${filePart.length}-${filePart}-`;
}

function browserHostReceiptSourcePrefix(sourcePath: string): string {
  return `source-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}-`;
}

function toReceiptFilePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return sanitized.length === 0 ? "value" : sanitized;
}
