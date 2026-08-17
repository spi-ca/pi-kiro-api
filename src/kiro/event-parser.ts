// Vendored from pi-kiro (MIT, Copyright (c) 2026 Hongyi Lyu). See NOTICE.
//
// Kiro JSON event parser.
//
// Kiro's streaming response interleaves JSON event objects inside an AWS
// Event Stream binary envelope. We scan for known JSON prefix patterns
// (avoiding framing noise), extract brace-balanced JSON, and dispatch to
// typed event objects.

import { log } from "./debug.ts";

export type KiroStreamEvent =
  | { type: "content"; data: string }
  | { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: "toolUseInput"; data: { input: string } }
  | { type: "toolUseStop"; data: { stop: boolean } }
  | { type: "contextUsage"; data: { contextUsagePercentage: number } }
  | { type: "followupPrompt"; data: string }
  | { type: "usage"; data: { inputTokens?: number; outputTokens?: number } }
  | { type: "error"; data: { error: string; message?: string } };

/** Find the matching `}` for the `{` at `start`. Returns -1 if incomplete. */
export function findJsonEnd(text: string, start: number): number {
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }
  return -1;
}

export function parseKiroEvent(parsed: Record<string, unknown>): KiroStreamEvent | null {
  if (parsed.content !== undefined) {
    return { type: "content", data: parsed.content as string };
  }

  if (parsed.name && parsed.toolUseId) {
    const rawInput = parsed.input;
    const input =
      typeof rawInput === "string"
        ? rawInput
        : rawInput && typeof rawInput === "object" && Object.keys(rawInput as Record<string, unknown>).length > 0
          ? JSON.stringify(rawInput)
          : "";
    return {
      type: "toolUse",
      data: {
        name: parsed.name as string,
        toolUseId: parsed.toolUseId as string,
        input,
        stop: parsed.stop as boolean | undefined,
      },
    };
  }

  if (parsed.input !== undefined && !parsed.name) {
    return {
      type: "toolUseInput",
      data: {
        input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input),
      },
    };
  }

  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
    return { type: "toolUseStop", data: { stop: parsed.stop as boolean } };
  }

  if (parsed.contextUsagePercentage !== undefined) {
    return {
      type: "contextUsage",
      data: { contextUsagePercentage: parsed.contextUsagePercentage as number },
    };
  }

  if (parsed.followupPrompt !== undefined) {
    return { type: "followupPrompt", data: parsed.followupPrompt as string };
  }

  if (parsed.error !== undefined || parsed.Error !== undefined) {
    const err = (parsed.error || parsed.Error || "unknown") as string | Record<string, unknown>;
    const message = (parsed.message || parsed.Message || parsed.reason) as string | undefined;
    return {
      type: "error",
      data: {
        error: typeof err === "string" ? err : JSON.stringify(err),
        message,
      },
    };
  }

  if (parsed.usage !== undefined) {
    const u = parsed.usage as Record<string, unknown>;
    return {
      type: "usage",
      data: {
        inputTokens: u.inputTokens as number | undefined,
        outputTokens: u.outputTokens as number | undefined,
      },
    };
  }

  return null;
}

/**
 * Known JSON prefixes that start a Kiro event. Explicit matching avoids the
 * `{"` sequences inside the AWS Event Stream binary envelope.
 */
const EVENT_PATTERNS = [
  '{"content":',
  '{"name":',
  '{"input":',
  '{"stop":',
  '{"contextUsagePercentage":',
  '{"followupPrompt":',
  '{"usage":',
  '{"toolUseId":',
  '{"unit":',
  '{"error":',
  '{"Error":',
  '{"message":',
];

function findNextEventStart(buffer: string, from: number): number {
  let earliest = -1;
  for (const pattern of EVENT_PATTERNS) {
    const idx = buffer.indexOf(pattern, from);
    if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

/** Longest event prefix, so a split prefix can never be longer than this. */
const MAX_PATTERN_LENGTH = Math.max(...EVENT_PATTERNS.map((p) => p.length));

/**
 * Cap on retained characters for an event that has not closed yet.
 *
 * This is a memory bound, not a protocol limit: nothing in Kiro's wire format
 * states a maximum frame size. It is set far above any observed frame so that
 * hitting it means the response is not producing closable events. Exceeding it
 * is reported to the caller rather than discarded, since dropping the buffer
 * would silently truncate output or trigger an empty-response retry.
 */
const MAX_RETAINED_BYTES = 1_048_576;

/** Raised when an unterminated event grows past {@link MAX_RETAINED_BYTES}. */
export class KiroEventBufferOverflowError extends Error {
  constructor(readonly retainedBytes: number) {
    super(
      `unterminated Kiro stream event exceeded ${MAX_RETAINED_BYTES} characters (retained ${retainedBytes})`,
    );
    this.name = "KiroEventBufferOverflowError";
  }
}

/**
 * Length of the tail to keep when no event prefix is present.
 *
 * A prefix can straddle a chunk boundary (`{\"cont` + `ent\":...`), so dropping
 * the whole remainder would lose the event. Keeping the last
 * `MAX_PATTERN_LENGTH - 1` characters is enough to complete any prefix on the
 * next chunk while still discarding framing noise.
 */
function tailForSplitPrefix(buffer: string, from: number): string {
  const gap = buffer.substring(from);
  if (gap.length <= MAX_PATTERN_LENGTH - 1) return gap;
  return gap.substring(gap.length - (MAX_PATTERN_LENGTH - 1));
}

export function parseKiroEvents(
  buffer: string,
): { events: KiroStreamEvent[]; remaining: string } {
  const events: KiroStreamEvent[] = [];
  let pos = 0;

  while (pos < buffer.length) {
    const jsonStart = findNextEventStart(buffer, pos);
    if (jsonStart < 0) {
      // No known event prefix in the remainder. If there are brace-opens
      // sitting in the gap, surface them — that's where an unrecognized
      // top-level key would live.
      if (log.isUnsafeDebugPayloadEnabled()) {
        const gap = buffer.substring(pos);
        const braceIdx = gap.indexOf('{"');
        if (braceIdx >= 0) {
          log.debug("event.unmatchedBrace", {
            from: pos + braceIdx,
            preview: gap.substring(braceIdx, Math.min(braceIdx + 200, gap.length)),
          });
        }
      }
      // Keep only enough of the tail to complete a prefix split across the
      // chunk boundary; the rest is framing noise.
      return { events, remaining: tailForSplitPrefix(buffer, pos) };
    }

    if (log.isUnsafeDebugPayloadEnabled() && jsonStart > pos) {
      // Bytes skipped between pos and the next known event — usually binary
      // framing, but worth peeking at once so we can tell.
      const skipped = buffer.substring(pos, jsonStart);
      const braceIdx = skipped.indexOf('{"');
      if (braceIdx >= 0) {
        log.debug("event.skippedBrace", {
          from: pos + braceIdx,
          preview: skipped.substring(braceIdx, Math.min(braceIdx + 200, skipped.length)),
        });
      }
    }

    const jsonEnd = findJsonEnd(buffer, jsonStart);
    if (jsonEnd < 0) {
      // Incomplete JSON at end of buffer — preserve for next call, unless it
      // has grown past the memory bound. Any events already parsed from this
      // buffer are lost with the throw, but they would be an incomplete
      // response either way; failing loudly beats a silent truncation.
      const retained = buffer.substring(jsonStart);
      if (retained.length > MAX_RETAINED_BYTES) {
        throw new KiroEventBufferOverflowError(retained.length);
      }
      return { events, remaining: retained };
    }

    try {
      const parsed = JSON.parse(buffer.substring(jsonStart, jsonEnd + 1)) as Record<
        string,
        unknown
      >;
      const event = parseKiroEvent(parsed);
      if (event) {
        events.push(event);
      } else if (log.isUnsafeDebugPayloadEnabled()) {
        // Frame parsed cleanly but didn't match any known event shape.
        // This is the primary signal for a new upstream event type.
        log.debug("event.unknown", { keys: Object.keys(parsed), raw: parsed });
      }
    } catch (err) {
      // Brace-balanced but not valid JSON — skip.
      if (log.isUnsafeDebugPayloadEnabled()) {
        log.debug("event.parseFail", {
          err: err instanceof Error ? err.message : String(err),
          snippet: buffer.substring(jsonStart, Math.min(jsonEnd + 1, jsonStart + 200)),
        });
      }
    }
    pos = jsonEnd + 1;
  }

  return { events, remaining: "" };
}
