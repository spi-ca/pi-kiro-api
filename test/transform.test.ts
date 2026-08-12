import { expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { buildHistory, getContentText, ToolUseIdMapper } from "../src/kiro/transform.ts";

test("history conversion drops provider-internal thinking blocks", () => {
  const messages: Message[] = [
    { role: "user", content: "first", timestamp: 0 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "signed or UI-formatted hidden reasoning" },
        { type: "text", text: "visible answer" },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "other-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
    { role: "user", content: "next", timestamp: 0 },
  ];

  const { history } = buildHistory(messages, "claude-opus-5");

  expect(history).toHaveLength(2);
  expect(history[1]?.assistantResponseMessage?.content).toBe("visible answer");
  expect(JSON.stringify(history)).not.toContain("thinking");
  expect(JSON.stringify(history)).not.toContain("hidden reasoning");
});

test("tool use IDs are normalized consistently for Kiro history", () => {
  const id = "call_e94N00RInNHYopGvSJ49bbMu|fc_097faed57d5fbcf0016a7c371cfbac81919b3ce873bab9ad00";
  const messages: Message[] = [
    { role: "user", content: "run", timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "bash", arguments: { command: "true" } }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    },
    { role: "user", content: "next", timestamp: 0 },
  ];

  const { history } = buildHistory(messages, "claude-opus-5");
  const toolUseId = history[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId;
  const toolResultId = history[2]?.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId;

  expect(toolUseId).toBe(toolResultId);
  expect(toolUseId).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(toolUseId!.length).toBeLessThanOrEqual(64);
  expect(toolUseId).not.toContain("|");
});

test("tool use ID mapping avoids collisions after sanitization", () => {
  const mapper = new ToolUseIdMapper();
  const first = mapper.map("a|b");
  const second = mapper.map("a_b");

  expect(mapper.map("a|b")).toBe(first);
  expect(first).not.toBe(second);
  expect(first).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(second).toMatch(/^[a-zA-Z0-9_-]+$/);
});

function assistant(content: Message["content"], stopReason: "stop" | "toolUse" = "stop"): Message {
  return {
    role: "assistant",
    content,
    api: "kiro-api",
    provider: "kiro-api-key",
    model: "claude-opus-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  } as Message;
}

test("consecutive assistant turns merge to preserve Kiro alternation", () => {
  const messages: Message[] = [
    { role: "user", content: "go", timestamp: 0 },
    assistant([{ type: "text", text: "first" }]),
    assistant([{ type: "text", text: "second" }]),
    { role: "user", content: "next", timestamp: 0 },
  ];

  const { history } = buildHistory(messages, "claude-opus-5");

  expect(history).toHaveLength(2);
  expect(history[0]?.userInputMessage).toBeDefined();
  expect(history[1]?.assistantResponseMessage?.content).toBe("first\n\nsecond");
});

test("unanswered tool uses are closed with synthetic results", () => {
  const messages: Message[] = [
    { role: "user", content: "go", timestamp: 0 },
    assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }], "toolUse"),
    { role: "user", content: "never mind", timestamp: 0 },
    { role: "user", content: "continue", timestamp: 0 },
  ];

  const { history } = buildHistory(messages, "claude-opus-5");
  const uses = history.flatMap((entry) => entry.assistantResponseMessage?.toolUses ?? []);
  const results = history.flatMap(
    (entry) => entry.userInputMessage?.userInputMessageContext?.toolResults ?? [],
  );

  expect(uses.map((use) => use.toolUseId)).toEqual(["call-1"]);
  expect(results.map((result) => result.toolUseId)).toEqual(["call-1"]);
  expect(results[0]?.status).toBe("error");

  let previous: string | undefined;
  for (const entry of history) {
    const kind = entry.userInputMessage ? "user" : "assistant";
    expect(kind).not.toBe(previous);
    previous = kind;
  }
});

test("content text extraction ignores thinking blocks", () => {
  expect(
    getContentText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "public" },
      ],
      api: "kiro-api",
      provider: "kiro-api-key",
      model: "claude-opus-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    }),
  ).toBe("public");
});
