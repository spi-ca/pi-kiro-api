import { expect, spyOn, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { log } from "../src/kiro/debug.ts";
import { streamKiro } from "../src/kiro/stream.ts";

const MODEL: Model<"kiro-api"> = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "kiro-api",
  provider: "kiro-api-key",
  baseUrl: "https://q.us-east-1.amazonaws.com/",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

async function collectEvents(response: ReturnType<typeof streamKiro>) {
  const events = [] as Array<{ type: string; [key: string]: unknown }>;
  for await (const event of response) events.push(event);
  return events;
}

async function withImmediateTimers<T>(run: () => Promise<T>): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: TimerHandler, _ms?: number, ...args: unknown[]) =>
    originalSetTimeout(callback, 0, ...args)) as unknown as typeof setTimeout;
  try {
    return await run();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

test("a retried stream emits one start and one terminal done event", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let fetchCalls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls++;
    expect(init?.redirect).toBe("error");
    // An empty successful stream retries deterministically, then terminates
    // with done after MAX_RETRIES.
    return new Response("", { status: 200 });
  }) as typeof fetch;
  globalThis.setTimeout = ((callback: TimerHandler, _ms?: number, ...args: unknown[]) =>
    originalSetTimeout(callback, 0, ...args)) as unknown as typeof setTimeout;

  try {
    const events = [] as Array<{ type: string }>;
    for await (const event of streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })) {
      events.push(event);
    }
    expect(fetchCalls).toBe(4);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("retries a stream error before provider output with one logical start", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(fetchCalls === 1 ? '{"error":"temporary","message":"retry"}' : '{"content":"ok"}', {
      status: 200,
    });
  }) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    expect(fetchCalls).toBe(2);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry a clean thinking-only response", async () => {
  const originalFetch = globalThis.fetch;
  const warnSpy = spyOn(log, "warn");
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response('{"content":"<thinking>ponder</thinking>"}', { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key", reasoning: "low" })),
    );
    expect(fetchCalls).toBe(1);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "thinking_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(1);
    expect(events.filter((event) => event.type === "thinking_end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("empty response"));
  } finally {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  }
});

test("closes provider blocks when the response reader rejects after partial output", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let reads = 0;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads === 1) {
              return {
                done: false,
                value: encoder.encode(
                  '{"content":"<thinking>ponder</thinking>hello"}{"name":"lookup","toolUseId":"call-1","input":"{}","stop":true}',
                ),
              };
            }
            throw new Error("reader rejected");
          },
          cancel: async () => {},
        }),
      },
    }) as unknown as Response) as unknown as typeof fetch;

  try {
    const events = await collectEvents(
      streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key", reasoning: "low" }),
    );
    expect(reads).toBe(2);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "thinking_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "thinking_end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "text_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "text_end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          content: [
            expect.objectContaining({ type: "thinking", thinking: "ponder" }),
            expect.objectContaining({ type: "text", text: "hello" }),
            expect.objectContaining({ type: "toolCall", id: "call-1" }),
          ],
        }),
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry after externally visible provider text or tool output", async () => {
  const cases = [
    {
      body: '{"content":"hello"}{"error":"temporary","message":"retry"}',
      assertContent: (message: { content: Array<{ type: string; text?: string }> }) => {
        expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "hello" })]);
      },
      starts: "text_start",
      ends: "text_end",
    },
    {
      body: '{"name":"lookup","toolUseId":"call-1","input":"{\\"q\\":\\"x\\"}","stop":true}{"error":"temporary","message":"retry"}',
      assertContent: (message: { content: Array<{ type: string; name?: string; id?: string }> }) => {
        expect(message.content).toEqual([
          expect.objectContaining({ type: "toolCall", name: "lookup", id: "call-1" }),
        ]);
      },
      starts: "toolcall_start",
      ends: "toolcall_end",
    },
  ] as const;

  for (const scenario of cases) {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(scenario.body, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const events = await withImmediateTimers(() =>
        collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
      );
      expect(fetchCalls).toBe(1);
      expect(events.filter((event) => event.type === "start")).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("error");
      expect(events.filter((event) => event.type === scenario.starts)).toHaveLength(1);
      expect(events.filter((event) => event.type === scenario.ends)).toHaveLength(1);
      const terminal = events.at(-1) as unknown as { error: { content: Array<{ type: string }> } };
      scenario.assertContent(terminal.error as never);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});
