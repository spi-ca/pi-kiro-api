import { expect, test } from "bun:test";
import { findJsonEnd, parseKiroEvent, parseKiroEvents } from "../src/kiro/event-parser.ts";

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
