import { expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ThinkingTagParser } from "../src/kiro/thinking-parser.ts";

function parse(chunks: string[]): AssistantMessage["content"] {
  const output = { role: "assistant", content: [] } as unknown as AssistantMessage;
  const stream = { push: () => {} } as unknown as AssistantMessageEventStream;
  const parser = new ThinkingTagParser(output, stream);
  for (const chunk of chunks) parser.processChunk(chunk);
  parser.finalize();
  return output.content;
}

test("splits a leading thinking block from trailing text", () => {
  expect(parse(["<thinking>", "abc", "</thinking>", "tail"])).toEqual([
    { type: "thinking", thinking: "abc" },
    { type: "text", text: "tail" },
  ]);
});

test("handles tags split across chunk boundaries", () => {
  expect(parse(["<think", "ing>", "abc", "</thin", "king>", "tail"])).toEqual([
    { type: "thinking", thinking: "abc" },
    { type: "text", text: "tail" },
  ]);
});

test("keeps text that only looks like a partial end tag", () => {
  expect(parse(["a</thin", "k b"])).toEqual([{ type: "text", text: "a</think b" }]);
});

test("supports alternate tag variants", () => {
  expect(parse(["<think>", "r", "</think>", "t"])).toEqual([
    { type: "thinking", thinking: "r" },
    { type: "text", text: "t" },
  ]);
});

test("closes an unterminated thinking block", () => {
  expect(parse(["<thinking>", "abc"])).toEqual([{ type: "thinking", thinking: "abc" }]);
});

test("drops the blank line that follows a thinking block", () => {
  expect(parse(["<thinking>x</thinking>\n\nbody"])).toEqual([
    { type: "thinking", thinking: "x" },
    { type: "text", text: "body" },
  ]);
});

test("streams plain text without a thinking block", () => {
  expect(parse(["plain ", "text"])).toEqual([{ type: "text", text: "plain text" }]);
});
