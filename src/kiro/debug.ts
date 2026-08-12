// Vendored from pi-kiro (MIT, Copyright (c) 2026 Hongyi Lyu). See NOTICE.
//
// Leveled diagnostics. KIRO_LOG controls metadata verbosity. Raw service
// payloads are never logged unless KIRO_UNSAFE_DEBUG_PAYLOADS=1 is also set.

import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_PREFIX = "[pi-kiro-api]";
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel(): LogLevel {
  const raw = (globalThis.process?.env?.KIRO_LOG ?? "").toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") return raw;
  return "warn";
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel()];
}

function currentFilePath(): string | null {
  const raw = globalThis.process?.env?.KIRO_LOG_FILE;
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

const ensuredDirs = new Set<string>();
let fileFallbackWarned = false;

/** Raw stream/event payloads may contain prompts and responses; require an explicit unsafe opt-in. */
function unsafeDebugPayloads(): boolean {
  return globalThis.process?.env?.KIRO_UNSAFE_DEBUG_PAYLOADS === "1";
}

/** Append a log line only to a regular, non-symlink file owned by this process (0600). */
export function writeSecureLogFile(filePath: string, line: string): void {
  const dir = dirname(filePath);
  if (!ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensuredDirs.add(dir);
  }

  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("KIRO_LOG_FILE must be a regular non-symlink file");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;
  const fd = openSync(filePath, flags, 0o600);
  try {
    // Existing files may have been created under a different umask.
    fchmodSync(fd, 0o600);
    writeSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

function writeToFile(filePath: string, line: string): void {
  try {
    writeSecureLogFile(filePath, line);
  } catch (err) {
    if (!fileFallbackWarned) {
      fileFallbackWarned = true;
      console.error(`${LOG_PREFIX} ERROR failed to write KIRO_LOG_FILE=${filePath}:`, err);
    }
  }
}

function emit(level: LogLevel, message: string, data?: unknown): void {
  if (!enabled(level)) return;
  const filePath = currentFilePath();
  if (filePath) {
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level, msg: message };
    if (data !== undefined) record.data = data;
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ...record, data: String(data) });
    }
    writeToFile(filePath, line);
    return;
  }

  const prefix = `${LOG_PREFIX} ${level.toUpperCase()}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (data === undefined) sink(`${prefix} ${message}`);
  else sink(`${prefix} ${message}`, data);
}

export const log = {
  error: (msg: string, data?: unknown) => emit("error", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
  info: (msg: string, data?: unknown) => emit("info", msg, data),
  debug: (msg: string, data?: unknown) => emit("debug", msg, data),
  isDebug: () => enabled("debug"),
  isUnsafeDebugPayloadEnabled: () => enabled("debug") && unsafeDebugPayloads(),
};

const CHUNK_PREVIEW_LIMIT = 2048;
export function previewChunk(s: string): string {
  let out = "";
  const limit = Math.min(s.length, CHUNK_PREVIEW_LIMIT);
  for (let i = 0; i < limit; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += s[i];
  }
  if (s.length > CHUNK_PREVIEW_LIMIT) out += `…(+${s.length - CHUNK_PREVIEW_LIMIT} chars)`;
  return out;
}
