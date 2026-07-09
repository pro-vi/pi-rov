import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { HARD_PASS_TOOLS, DEFAULT_SEMANTIC_TOOLS } from "../constants.js";
import { looksLikeDiff } from "../content.js";
import { sha256 } from "../artifacts.js";
import type { TranscriptCandidate, TranscriptScanResult, TranscriptScanWarning } from "./types.js";

export interface TranscriptScanOptions {
  thresholdBytes?: number;
  forceProductionEligibility?: boolean;
}

export class TranscriptScanError extends Error {
  readonly sessionPath: string;
  readonly code: "missing-file" | "unreadable-file";

  constructor(sessionPath: string, code: "missing-file" | "unreadable-file", message: string) {
    super(message);
    this.name = "TranscriptScanError";
    this.sessionPath = sessionPath;
    this.code = code;
  }
}

interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

interface SessionHeaderState {
  sessionId?: string;
  cwd?: string;
}

export function defaultSessionRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

export async function findSessionFiles(root = defaultSessionRoot()): Promise<string[]> {
  const files: string[] = [];
  await collectSessionFiles(root, files);
  return files.sort((left, right) => left.localeCompare(right));
}

export async function scanTranscriptTree(root = defaultSessionRoot(), options: TranscriptScanOptions = {}): Promise<TranscriptScanResult> {
  let sessionFiles: string[];
  try {
    sessionFiles = await findSessionFiles(root);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { filesScanned: 0, entriesScanned: 0, candidates: [], warnings: [{ sessionPath: root, reason: "sessions root does not exist" }] };
    }
    throw error;
  }

  const aggregate: TranscriptScanResult = { filesScanned: 0, entriesScanned: 0, candidates: [], warnings: [] };
  for (const sessionPath of sessionFiles) {
    const result = await scanSessionFile(sessionPath, options);
    aggregate.filesScanned += result.filesScanned;
    aggregate.entriesScanned += result.entriesScanned;
    aggregate.candidates.push(...result.candidates);
    aggregate.warnings.push(...result.warnings);
  }
  return aggregate;
}

export async function scanSessionFile(sessionPath: string, options: TranscriptScanOptions = {}): Promise<TranscriptScanResult> {
  try {
    const stats = await stat(sessionPath);
    if (!stats.isFile()) {
      throw new TranscriptScanError(sessionPath, "unreadable-file", `Not a file: ${sessionPath}`);
    }
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new TranscriptScanError(sessionPath, "missing-file", `Session file not found: ${sessionPath}`);
    }
    if (error instanceof TranscriptScanError) {
      throw error;
    }
    throw new TranscriptScanError(sessionPath, "unreadable-file", `Unable to read session file: ${sessionPath}`);
  }

  const thresholdBytes = options.thresholdBytes ?? 12_000;
  const warnings: TranscriptScanWarning[] = [];
  const candidates: TranscriptCandidate[] = [];
  const toolCalls = new Map<string, ToolCallRecord>();
  const header: SessionHeaderState = {};
  let entriesScanned = 0;
  let lineNumber = 0;

  const lineReader = createInterface({ input: createReadStream(sessionPath, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of lineReader) {
    lineNumber += 1;
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseJsonLine(line);
    if (!parsed) {
      warnings.push({ sessionPath, lineNumber, reason: "malformed JSONL line" });
      continue;
    }
    if (!isRecord(parsed)) {
      warnings.push({ sessionPath, lineNumber, reason: "JSONL line is not an object" });
      continue;
    }
    entriesScanned += 1;

    readSessionHeader(parsed, header);
    collectAssistantToolCalls(parsed, toolCalls);

    const candidate = candidateFromEntry(parsed, sessionPath, lineNumber, header, toolCalls, thresholdBytes, options.forceProductionEligibility === true);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return { filesScanned: 1, entriesScanned, candidates, warnings };
}

function candidateFromEntry(
  entry: Record<string, unknown>,
  sessionPath: string,
  lineNumber: number,
  header: SessionHeaderState,
  toolCalls: Map<string, ToolCallRecord>,
  thresholdBytes: number,
  forceProductionEligibility: boolean,
): TranscriptCandidate | undefined {
  if (entry.type !== "message") {
    return undefined;
  }
  const entryId = readString(entry, "id");
  const parentId = readParentId(entry, "parentId");
  const timestamp = readString(entry, "timestamp");
  const message = entry.message;
  if (!entryId || parentId === undefined || !isRecord(message)) {
    return undefined;
  }

  if (message.role === "toolResult") {
    const content = readToolResultText(message.content);
    if (content.textBytes < thresholdBytes) {
      return undefined;
    }
    const toolCallId = readString(message, "toolCallId");
    const toolNameFromMessage = readString(message, "toolName");
    const call = toolCallId ? toolCalls.get(toolCallId) : undefined;
    const toolName = toolNameFromMessage ?? call?.name;
    if (!toolName) {
      return undefined;
    }
    const input = call?.input ?? {};
    const eligibility = classifyProductionEligibility(toolName, input, content.text, forceProductionEligibility);
    return buildCandidate({
      sessionPath,
      lineNumber,
      entryId,
      parentId,
      role: "toolResult",
      toolName,
      input,
      rawText: content.text,
      timestamp,
      header,
      productionEligible: eligibility.productionEligible,
      ineligibilityReason: eligibility.reason,
      toolCallId,
      isError: readBoolean(message, "isError"),
    });
  }

  if (message.role === "bashExecution") {
    const output = readString(message, "output");
    if (output === undefined) {
      return undefined;
    }
    const textBytes = Buffer.byteLength(output, "utf-8");
    if (textBytes < thresholdBytes) {
      return undefined;
    }
    const command = readString(message, "command") ?? "";
    const exitCode = readNumber(message, "exitCode");
    const truncated = readBoolean(message, "truncated");
    const input: Record<string, unknown> = { command };
    if (exitCode !== undefined) input.exitCode = exitCode;
    const cancelled = readBoolean(message, "cancelled");
    if (cancelled !== undefined) input.cancelled = cancelled;
    if (truncated !== undefined) input.truncated = truncated;
    const fullOutputPath = readString(message, "fullOutputPath");
    if (fullOutputPath !== undefined) input.fullOutputPath = fullOutputPath;
    const eligibility = classifyProductionEligibility("bash", input, output, forceProductionEligibility);
    return buildCandidate({
      sessionPath,
      lineNumber,
      entryId,
      parentId,
      role: "bashExecution",
      toolName: "bash",
      input,
      rawText: output,
      timestamp,
      header,
      productionEligible: eligibility.productionEligible,
      ineligibilityReason: eligibility.reason,
      exitCode,
      truncated,
    });
  }

  return undefined;
}

function buildCandidate(request: {
  sessionPath: string;
  lineNumber: number;
  entryId: string;
  parentId: string | null;
  role: "toolResult" | "bashExecution";
  toolName: string;
  input: Record<string, unknown>;
  rawText: string;
  timestamp?: string | undefined;
  header: SessionHeaderState;
  productionEligible: boolean;
  ineligibilityReason?: string | undefined;
  toolCallId?: string | undefined;
  isError?: boolean | undefined;
  exitCode?: number | undefined;
  truncated?: boolean | undefined;
}): TranscriptCandidate {
  const rawHash = sha256(request.rawText);
  const id = sha256(`${request.sessionPath}:${request.entryId}:${request.toolName}:${rawHash}`).slice(0, 20);
  const candidate: TranscriptCandidate = {
    id,
    sessionPath: request.sessionPath,
    lineNumber: request.lineNumber,
    entryId: request.entryId,
    parentId: request.parentId,
    role: request.role,
    toolName: request.toolName,
    input: request.input,
    rawText: request.rawText,
    rawHash,
    textBytes: Buffer.byteLength(request.rawText, "utf-8"),
    lineCount: request.rawText.length === 0 ? 0 : request.rawText.split("\n").length,
    productionEligible: request.productionEligible,
  };
  if (request.timestamp !== undefined) candidate.timestamp = request.timestamp;
  if (request.header.sessionId !== undefined) candidate.sessionId = request.header.sessionId;
  if (request.header.cwd !== undefined) candidate.cwd = request.header.cwd;
  if (request.toolCallId !== undefined) candidate.toolCallId = request.toolCallId;
  if (request.isError !== undefined) candidate.isError = request.isError;
  if (request.exitCode !== undefined) candidate.exitCode = request.exitCode;
  if (request.truncated !== undefined) candidate.truncated = request.truncated;
  if (request.ineligibilityReason !== undefined) candidate.ineligibilityReason = request.ineligibilityReason;
  return candidate;
}

function classifyProductionEligibility(
  toolName: string,
  input: Record<string, unknown>,
  text: string,
  forceProductionEligibility: boolean,
): { productionEligible: boolean; reason?: string } {
  if (forceProductionEligibility) {
    return { productionEligible: true };
  }
  if (HARD_PASS_TOOLS.has(toolName)) {
    return { productionEligible: false, reason: "exactness-sensitive tool" };
  }
  if (looksLikeDiff(toolName, input, text)) {
    return { productionEligible: false, reason: "diff-like output is exactness-sensitive" };
  }
  if (!DEFAULT_SEMANTIC_TOOLS.has(toolName)) {
    return { productionEligible: false, reason: "tool not semantic by default" };
  }
  return { productionEligible: true };
}

function collectAssistantToolCalls(entry: Record<string, unknown>, toolCalls: Map<string, ToolCallRecord>): void {
  if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
    return;
  }
  for (const block of entry.message.content) {
    if (!isRecord(block) || block.type !== "toolCall") {
      continue;
    }
    const id = readString(block, "id");
    const name = readString(block, "name");
    if (!id || !name) {
      continue;
    }
    const args = isRecord(block.arguments) ? block.arguments : {};
    toolCalls.set(id, { name, input: args });
  }
}

function readSessionHeader(entry: Record<string, unknown>, header: SessionHeaderState): void {
  if (entry.type !== "session") {
    return;
  }
  const id = readString(entry, "id");
  const cwd = readString(entry, "cwd");
  if (id !== undefined) header.sessionId = id;
  if (cwd !== undefined) header.cwd = cwd;
}

function readToolResultText(content: unknown): { text: string; textBytes: number } {
  if (!Array.isArray(content)) {
    return { text: "", textBytes: 0 };
  }
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const text = parts.join("\n");
  return { text, textBytes: Buffer.byteLength(text, "utf-8") };
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed;
  } catch {
    return undefined;
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readParentId(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function collectSessionFiles(root: string, files: string[]): Promise<void> {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(path, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
}
