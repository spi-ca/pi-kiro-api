import { expect, test } from "bun:test";
import { KiroEventParser, findJsonEnd, parseKiroEvent, parseKiroEvents } from "../src/kiro/event-parser.ts";

test("returns negative one when JSON is incomplete", () => {
  expect(findJsonEnd('{"content":"partial', 0)).toBe(-1);
});

test("finds the end of JSON with nested braces", () => {
  const json = '{"input":{"nested":{"value":true}}}';
  expect(findJsonEnd(json, 0)).toBe(json.length - 1);
});

test("ignores braces in strings and escaped quotes", () => {
  const json = '{"content":"brace } and { with an escaped \\" quote"}';
  expect(findJsonEnd(json, 0)).toBe(json.length - 1);
});

test("maps content events", () => {
  expect(parseKiroEvent({ content: "hello" })).toEqual({ type: "content", data: "hello" });
});

test("maps tool use events and serializes non-empty object input", () => {
  expect(parseKiroEvent({ name: "search", toolUseId: "tool-1", input: { query: "moon" }, stop: true })).toEqual({
    type: "toolUse",
    data: { name: "search", toolUseId: "tool-1", input: '{"query":"moon"}', stop: true },
  });
});

test("maps tool use input events", () => {
  expect(parseKiroEvent({ input: { query: "moon" } })).toEqual({
    type: "toolUseInput",
    data: { input: '{"query":"moon"}' },
  });
});

test("maps tool use stop events", () => {
  expect(parseKiroEvent({ stop: false })).toEqual({ type: "toolUseStop", data: { stop: false } });
});

test("maps context usage events", () => {
  expect(parseKiroEvent({ contextUsagePercentage: 74 })).toEqual({
    type: "contextUsage",
    data: { contextUsagePercentage: 74 },
  });
});

test("maps followup prompt events", () => {
  expect(parseKiroEvent({ followupPrompt: "What next?" })).toEqual({
    type: "followupPrompt",
    data: "What next?",
  });
});

test("maps usage events", () => {
  expect(parseKiroEvent({ usage: { inputTokens: 12, outputTokens: 34 } })).toEqual({
    type: "usage",
    data: { inputTokens: 12, outputTokens: 34 },
  });
});

test("maps lowercase and uppercase error events", () => {
  expect(parseKiroEvent({ error: "bad request", message: "details" })).toEqual({
    type: "error",
    data: { error: "bad request", message: "details" },
  });
  expect(parseKiroEvent({ Error: { code: "Internal" }, Message: "failed" })).toEqual({
    type: "error",
    data: { error: '{"code":"Internal"}', message: "failed" },
  });
});

test("returns null for unrecognized event shapes", () => {
  expect(parseKiroEvent({ unknown: true })).toBeNull();
});

test("extracts multiple concatenated events", () => {
  expect(parseKiroEvents('framing{"content":"one"}noise{"followupPrompt":"two"}')).toEqual({
    events: [
      { type: "content", data: "one" },
      { type: "followupPrompt", data: "two" },
    ],
    remaining: "",
  });
});

test("skips brace-balanced invalid JSON", () => {
  expect(parseKiroEvents('{"content":invalid}{"content":"valid"}')).toEqual({
    events: [{ type: "content", data: "valid" }],
    remaining: "",
  });
});

test("recovers an event whose prefix is split after framing bytes", () => {
  const first = parseKiroEvents('\x00\x00framing{"cont');
  const second = parseKiroEvents(first.remaining + 'ent":"hello"}');

  expect(first.events).toEqual([]);
  expect(second).toEqual({ events: [{ type: "content", data: "hello" }], remaining: "" });
});

test("bounds retained framing-only noise across calls", () => {
  let remaining = "";
  for (let i = 0; i < 20; i++) {
    remaining = parseKiroEvents(remaining + "\x00".repeat(256)).remaining;
  }

  expect(remaining).toHaveLength(25);
});

test("raises rather than discarding an oversized unterminated event", () => {
  // The cap is a memory bound, not a protocol limit, so exceeding it is
  // reported to the caller. Silently dropping the buffer would truncate output
  // or trigger an empty-response retry.
  expect(() => parseKiroEvents('{"content":"' + "x".repeat(1_048_576))).toThrow(
    /exceeded 1048576 characters/,
  );
});

test("incrementally parses tiny chunks with nested and escaped JSON", () => {
  const parser = new KiroEventParser();
  const content = 'brace { and } with "quote" and \\path';
  const input = { nested: { value: "\\path" } };
  const payload = `\x00frame${JSON.stringify({ content })}${JSON.stringify({
    name: "tool",
    toolUseId: "id",
    input,
    stop: true,
  })}`;
  const events = [];
  for (const character of payload) events.push(...parser.push(character));

  expect(events).toEqual([
    { type: "content", data: content },
    {
      type: "toolUse",
      data: { name: "tool", toolUseId: "id", input: JSON.stringify(input), stop: true },
    },
  ]);
  expect(parser.remaining).toBe("");
});

test("stateful parser skips malformed events and still enforces overflow", () => {
  const parser = new KiroEventParser();
  expect(parser.push('{"content":invalid}')).toEqual([]);
  expect(parser.push('{"content":"valid"}')).toEqual([{ type: "content", data: "valid" }]);
  expect(() => parser.push('{"content":"' + "x".repeat(1_048_576))).toThrow(/exceeded 1048576 characters/);
});

test("scans dense concatenated events with a linear operation bound", () => {
  const parser = new KiroEventParser();
  const eventCount = 2_000;
  const originalIndexOf = String.prototype.indexOf;
  let indexOfCalls = 0;
  String.prototype.indexOf = function (searchString: string, position?: number): number {
    indexOfCalls++;
    return originalIndexOf.call(this, searchString, position);
  };

  try {
    const events = parser.push('{"content":"x"}'.repeat(eventCount));
    expect(events).toHaveLength(eventCount);
  } finally {
    String.prototype.indexOf = originalIndexOf;
  }

  // One common-prefix scan per event plus the terminating search. This is an
  // operation count, rather than a timing assertion, so it remains stable on
  // slow or loaded CI runners.
  expect(indexOfCalls).toBeLessThanOrEqual(eventCount + 1);
  expect(parser.remaining).toBe("");
});

test("ignores empty pushes without allocating open-event segments", () => {
  const parser = new KiroEventParser();
  const internal = parser as unknown as { open: { segments: Array<{ length: number }> } | null };

  expect(parser.push("")).toEqual([]);
  expect(internal.open).toBeNull();
  parser.push('{"content":"partial');
  const segmentCount = internal.open?.segments.length;
  for (let i = 0; i < 100; i++) expect(parser.push("")).toEqual([]);
  expect(internal.open?.segments).toHaveLength(segmentCount!);
});

test("coalesces one-byte input into bounded slabs and joins only at completion", () => {
  const parser = new KiroEventParser();
  // The complete JSON event is exactly one MiB, including its JSON envelope.
  const eventSize = 1_048_576;
  const prefix = '{"content":"';
  const suffix = '"}';
  const content = "x".repeat(eventSize - prefix.length - suffix.length);
  const event = `${prefix}${content}${suffix}`;
  const internal = parser as unknown as {
    open: { segments: Array<{ length: number }>; length: number } | null;
    completedEventJoinCount: number;
    completedEventJoinedCharacters: number;
  };

  for (const character of event.slice(0, -1)) parser.push(character);

  // One-byte transport chunks must not mean one retained object per byte.
  // Every slab remains bounded, and the event has not been assembled yet.
  expect(internal.open?.length).toBe(eventSize - 1);
  expect(internal.open?.segments.length).toBeLessThanOrEqual(Math.ceil(eventSize / 4096));
  expect(internal.open?.segments.every((segment) => segment.length <= 4096)).toBe(true);
  expect(internal.completedEventJoinCount).toBe(0);
  expect(internal.completedEventJoinedCharacters).toBe(0);

  expect(parser.push("}")).toEqual([{ type: "content", data: content }]);
  expect(internal.completedEventJoinCount).toBe(1);
  expect(internal.completedEventJoinedCharacters).toBe(eventSize);
  expect(parser.remaining).toBe("");
});

test("continues at the source offset after a completion in the same chunk", () => {
  const parser = new KiroEventParser();
  expect(parser.push('{"content":"first')).toEqual([]);
  expect(parser.push('"}{"content":"second"}')).toEqual([
    { type: "content", data: "first" },
    { type: "content", data: "second" },
  ]);
  expect(parser.remaining).toBe("");
});

test("rejects a completed event over the retained-event bound", () => {
  const parser = new KiroEventParser();
  expect(() => parser.push(JSON.stringify({ content: "x".repeat(1_048_576) }))).toThrow(
    /exceeded 1048576 characters/,
  );
});

test("rejects a recognized event cut off at EOF", () => {
  const parser = new KiroEventParser();
  parser.push('{"content":"partial');
  expect(() => parser.finish()).toThrow("Kiro stream ended with an incomplete event");
});
