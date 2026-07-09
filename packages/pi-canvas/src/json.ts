import type { CanvasActionDefinition, CanvasActionType, CanvasSource, CanvasStateSnapshot, CanvasViewKind, JsonObject, JsonValue } from "./types.js";
import { CANVAS_ACTION_TYPES, CANVAS_VIEW_KINDS } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`${label} must be JSON-serializable`);
  }
}

export function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function serializeJson(value: JsonValue | JsonObject | CanvasSource | CanvasStateSnapshot): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readViewKind(value: unknown): CanvasViewKind | undefined {
  for (const kind of CANVAS_VIEW_KINDS) {
    if (value === kind) return kind;
  }
  return undefined;
}

export function readActionType(value: unknown): CanvasActionType | undefined {
  for (const actionType of CANVAS_ACTION_TYPES) {
    if (value === actionType) return actionType;
  }
  return undefined;
}

export function readActionDefinitions(value: unknown): CanvasActionDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: CanvasActionDefinition[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const type = readActionType(item.type);
    const path = readString(item, "path");
    const label = readString(item, "label");
    if (!type || !path || !label) return undefined;
    actions.push({ type, path, label });
  }
  return actions;
}
