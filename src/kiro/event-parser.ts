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
  // Searching each pattern independently scans the remaining suffix once per
  // pattern. With many small concatenated events that becomes quadratic. Scan
  // for the common `{"` introducer once instead, then test the bounded set of
  // known prefixes at that position.
  let candidate = buffer.indexOf('{"', from);
  while (candidate >= 0) {
    if (EVENT_PATTERNS.some((pattern) => buffer.startsWith(pattern, candidate))) return candidate;
    candidate = buffer.indexOf('{"', candidate + 2);
  }
  return -1;
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
/** Maximum retained text per open-event segment. */
const SEGMENT_SLAB_BYTES = 4 * 1024;

/** Raised when an unterminated event grows past {@link MAX_RETAINED_BYTES}. */
export class KiroEventBufferOverflowError extends Error {
  constructor(
    readonly retainedBytes: number,
    completed = false,
  ) {
    super(
      `${completed ? "Kiro stream event" : "unterminated Kiro stream event"} exceeded ${MAX_RETAINED_BYTES} characters (retained ${retainedBytes})`,
    );
    this.name = "KiroEventBufferOverflowError";
  }
}

/** Raised when EOF cuts off an event whose prefix was recognized. */
export class KiroIncompleteEventError extends Error {
  constructor() {
    super("Kiro stream ended with an incomplete event");
    this.name = "KiroIncompleteEventError";
  }
}

type EventSegment = { codeUnits: Uint16Array; length: number };
type OpenEvent = {
  segments: EventSegment[];
  length: number;
  braceCount: number;
  inString: boolean;
  escapeNext: boolean;
};

/**
 * Stateful incremental parser for Kiro's binary-framed event stream.
 *
 * An open JSON event keeps fixed-size UTF-16 slabs. New chunks are scanned
 * exactly once using persisted JSON state, then the slabs are joined only
 * after the closing brace arrives. Bytes outside an event retain only a
 * bounded possible-prefix tail.
 */
export class KiroEventParser {
  private splitPrefixTail = "";
  private open: OpenEvent | null = null;
  // Kept as deterministic regression instrumentation: an open event must not
  // be assembled until it closes, and each completed event gets one join.
  private completedEventJoinCount = 0;
  private completedEventJoinedCharacters = 0;

  push(chunk: string): KiroStreamEvent[] {
    // Empty decoded chunks carry neither bytes nor characters. In particular,
    // do not create an empty segment for an already-open event.
    if (chunk.length === 0) return [];

    const events: KiroStreamEvent[] = [];
    let source: string;
    let searchOffset: number;

    if (this.open) {
      source = chunk;
      const jsonEnd = this.scanOpenSegment(source, 0);
      if (jsonEnd < 0) return events;
      this.dispatchCompletedEvent(events);
      searchOffset = jsonEnd + 1;
    } else {
      // `splitPrefixTail` is bounded to less than the longest known prefix,
      // so this is never a growing event-buffer append.
      source = this.splitPrefixTail + chunk;
      this.splitPrefixTail = "";
      searchOffset = 0;
    }

    while (true) {
      const jsonStart = findNextEventStart(source, searchOffset);
      if (jsonStart < 0) {
        this.logUnmatchedBrace(source, searchOffset);
        this.retainSplitPrefix(source, searchOffset);
        return events;
      }

      this.logSkippedBrace(source, searchOffset, jsonStart);
      this.open = {
        segments: [],
        length: 0,
        braceCount: 0,
        inString: false,
        escapeNext: false,
      };
      const jsonEnd = this.scanOpenSegment(source, jsonStart);
      if (jsonEnd < 0) return events;
      this.dispatchCompletedEvent(events);
      searchOffset = jsonEnd + 1;
    }
  }

  /** Finalize a response and reject a recognized event cut off by EOF. */
  finish(): void {
    if (this.open) throw new KiroIncompleteEventError();
  }

  /** The unconsumed suffix, retained for compatibility with parseKiroEvents. */
  get remaining(): string {
    if (this.open) return this.joinOpenEvent();
    return this.splitPrefixTail;
  }

  /**
   * Scan new source text once while copying each UTF-16 code unit directly
   * into a fixed-size slab. `jsonEnd` remains an offset into `text`, so
   * callers can continue finding events that follow a completion in the same
   * source chunk.
   */
  private scanOpenSegment(text: string, start: number): number {
    const open = this.open!;

    for (let i = start; i < text.length; i++) {
      const char = text[i];
      open.length++;
      let completed = false;
      if (open.escapeNext) {
        open.escapeNext = false;
      } else if (char === "\\") {
        open.escapeNext = true;
      } else if (char === '"') {
        open.inString = !open.inString;
      } else if (!open.inString) {
        if (char === "{") open.braceCount++;
        else if (char === "}") {
          open.braceCount--;
          completed = open.braceCount === 0;
        }
      }

      if (open.length > MAX_RETAINED_BYTES) {
        throw new KiroEventBufferOverflowError(open.length, completed);
      }
      this.appendScannedCharacter(char);
      if (completed) return i;
    }
    return -1;
  }

  /** Store a scanned code unit without allocating a segment per tiny chunk. */
  private appendScannedCharacter(char: string): void {
    const segments = this.open!.segments;
    let last = segments.at(-1);
    if (!last || last.length === SEGMENT_SLAB_BYTES) {
      last = { codeUnits: new Uint16Array(SEGMENT_SLAB_BYTES), length: 0 };
      segments.push(last);
    }
    last.codeUnits[last.length++] = char.charCodeAt(0);
  }

  private dispatchCompletedEvent(events: KiroStreamEvent[]): void {
    const raw = this.joinOpenEvent();
    this.completedEventJoinCount++;
    this.completedEventJoinedCharacters += raw.length;
    this.open = null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const event = parseKiroEvent(parsed);
      if (event) {
        events.push(event);
      } else if (log.isUnsafeDebugPayloadEnabled()) {
        log.debug("event.unknown", { keys: Object.keys(parsed), raw: parsed });
      }
    } catch (err) {
      // Brace-balanced but not valid JSON — skip.
      if (log.isUnsafeDebugPayloadEnabled()) {
        log.debug("event.parseFail", {
          err: err instanceof Error ? err.message : String(err),
          snippet: raw.substring(0, 200),
        });
      }
    }
  }

  /** Join retained slabs once after completion (or for the legacy remaining view). */
  private joinOpenEvent(): string {
    return this.open!.segments
      .map((segment) => String.fromCharCode(...segment.codeUnits.subarray(0, segment.length)))
      .join("");
  }

  private retainSplitPrefix(source: string, from: number): void {
    const gap = source.substring(from);
    this.splitPrefixTail =
      gap.length <= MAX_PATTERN_LENGTH - 1 ? gap : gap.substring(gap.length - (MAX_PATTERN_LENGTH - 1));
  }

  private logUnmatchedBrace(source: string, from: number): void {
    if (!log.isUnsafeDebugPayloadEnabled()) return;
    const braceIdx = source.indexOf('{"', from);
    if (braceIdx >= 0) {
      log.debug("event.unmatchedBrace", {
        from: braceIdx,
        preview: source.substring(braceIdx, Math.min(braceIdx + 200, source.length)),
      });
    }
  }

  private logSkippedBrace(source: string, from: number, to: number): void {
    if (!log.isUnsafeDebugPayloadEnabled() || to <= from) return;
    const braceIdx = source.indexOf('{"', from);
    if (braceIdx >= 0 && braceIdx < to) {
      log.debug("event.skippedBrace", {
        from: braceIdx,
        preview: source.substring(braceIdx, Math.min(braceIdx + 200, to)),
      });
    }
  }
}

/**
 * Stateless compatibility wrapper for existing callers. Stream consumers
 * should keep one {@link KiroEventParser} and call push for each decoded chunk.
 */
export function parseKiroEvents(buffer: string): { events: KiroStreamEvent[]; remaining: string } {
  const parser = new KiroEventParser();
  const events = parser.push(buffer);
  return { events, remaining: parser.remaining };
}
