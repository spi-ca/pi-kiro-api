import { expect, spyOn, test } from "bun:test";
import type { Message, Model } from "@earendil-works/pi-ai";
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function withFakeClock<T>(run: (clock: { advance: (ms: number) => void }) => Promise<T>): Promise<T> {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { callback: TimerHandler; args: unknown[]; dueAt: number }>();

  Date.now = () => now;
  globalThis.setTimeout = ((callback: TimerHandler, ms = 0, ...args: unknown[]) => {
    const id = nextTimerId++;
    timers.set(id, { callback, args, dueAt: now + ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as typeof clearTimeout;

  try {
    return await run({
      advance(ms) {
        const target = now + ms;
        while (true) {
          const next = [...timers.entries()]
            .filter(([, timer]) => timer.dueAt <= target)
            .sort(([, a], [, b]) => a.dueAt - b.dueAt)[0];
          if (!next) break;
          const [id, timer] = next;
          now = timer.dueAt;
          timers.delete(id);
          if (typeof timer.callback === "function") timer.callback(...timer.args);
        }
        now = target;
      },
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
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

test("retries framing-only bytes before a Kiro event", async () => {
  const originalFetch = globalThis.fetch;
  const noise = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    let reads = 0;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads === 1) return { done: false, value: noise };
            return new Promise<never>(() => {});
          },
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    expect(fetchCalls).toBeGreaterThan(1);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(["done", "error"]).toContain(String(events.at(-1)?.type));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not extend the first-token deadline for framing-only chunks", async () => {
  const originalFetch = globalThis.fetch;
  const noise = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
  let fetchCalls = 0;
  let reads = 0;
  let resolveRead: ((result: { done: boolean; value?: Uint8Array }) => void) | undefined;
  let resolveReadStarted: (() => void) | undefined;
  let cancelled = false;
  const readStarted = (target: number) =>
    new Promise<void>((resolve) => {
      if (reads >= target) resolve();
      else resolveReadStarted = resolve;
    });

  globalThis.fetch = (async () => {
    fetchCalls++;
    if (fetchCalls > 1) {
      return new Response('{"content":"after deadline"}{"contextUsagePercentage":1}', { status: 200 });
    }
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            reads++;
            resolveReadStarted?.();
            return new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              resolveRead = resolve;
            });
          },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const events = await withFakeClock(async (clock) => {
      const eventsPromise = collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" }));
      await readStarted(1);
      for (let chunk = 1; chunk <= 4; chunk++) {
        clock.advance(20_000);
        resolveRead!({ done: false, value: noise });
        await readStarted(chunk + 1);
      }

      clock.advance(10_000);
      await flushMicrotasks();
      expect(cancelled).toBe(true);
      clock.advance(1_000);
      return await eventsPromise;
    });

    expect(fetchCalls).toBe(2);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries with a fresh first-token deadline before accepting a Kiro event", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let fetchCalls = 0;
  let firstAttemptCancelled = false;
  let secondAttemptCancelled = false;
  let resolveFirstReadStarted: (() => void) | undefined;
  let resolveSecondReadStarted: (() => void) | undefined;
  let resolveSecondRead: ((result: { done: boolean; value?: Uint8Array }) => void) | undefined;
  const firstReadStarted = new Promise<void>((resolve) => {
    resolveFirstReadStarted = resolve;
  });
  const secondReadStarted = new Promise<void>((resolve) => {
    resolveSecondReadStarted = resolve;
  });

  globalThis.fetch = (async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: () => {
              resolveFirstReadStarted?.();
              return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
            },
            cancel: async () => {
              firstAttemptCancelled = true;
            },
          }),
        },
      } as unknown as Response;
    }

    let reads = 0;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            reads++;
            if (reads > 1) return Promise.resolve({ done: true });
            resolveSecondReadStarted?.();
            return new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              resolveSecondRead = resolve;
            });
          },
          cancel: async () => {
            secondAttemptCancelled = true;
          },
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const events = await withFakeClock(async (clock) => {
      const eventsPromise = collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" }));
      await firstReadStarted;
      clock.advance(90_000);
      await flushMicrotasks();
      expect(firstAttemptCancelled).toBe(true);
      clock.advance(1_000);
      await secondReadStarted;

      clock.advance(89_999);
      await flushMicrotasks();
      expect(secondAttemptCancelled).toBe(false);
      resolveSecondRead!({ done: false, value: encoder.encode('{"content":"fresh deadline"}') });
      return await eventsPromise;
    });

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    const terminal = events.at(-1) as unknown as { message: { content: Array<{ type: string; text?: string }> } };
    expect(terminal.message.content).toEqual([expect.objectContaining({ type: "text", text: "fresh deadline" })]);
  } finally {
    globalThis.fetch = originalFetch;
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

test("cache points are opt-in and mark only the stable history prefix", async () => {
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.KIRO_CACHE_POINTS;
  const messages: Message[] = [
    { role: "user", content: "first", timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "kiro-api",
      provider: "kiro-api-key",
      model: "claude-sonnet-4-6",
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
    { role: "user", content: "second", timestamp: 0 },
  ];

  async function capture(): Promise<any> {
    let body: any;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response('{"content":"ok"}{"contextUsagePercentage":5}', { status: 200 });
    }) as typeof fetch;
    await collectEvents(streamKiro(MODEL, { messages, tools: [] }, { apiKey: "test-key" }));
    return body;
  }

  try {
    delete process.env.KIRO_CACHE_POINTS;
    const disabled = await capture();
    expect(JSON.stringify(disabled)).not.toContain("cachePoint");

    process.env.KIRO_CACHE_POINTS = "1";
    const enabled = await capture();
    const history = enabled.conversationState.history as any[];
    const marked = history.filter((entry) => entry.assistantResponseMessage?.cachePoint);

    expect(marked).toHaveLength(1);
    expect(marked[0].assistantResponseMessage.cachePoint).toEqual({ type: "default" });
    expect(enabled.conversationState.currentMessage.userInputMessage.cachePoint).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.KIRO_CACHE_POINTS;
    else process.env.KIRO_CACHE_POINTS = originalFlag;
  }
});

test("identical adjacent content frames are preserved", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      '{"content":"- "}{"content":"- "}{"content":"item"}{"contextUsagePercentage":10}',
      { status: 200 },
    )) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    const terminal = events.at(-1) as unknown as {
      type: string;
      message: { content: Array<{ type: string; text?: string }> };
    };

    expect(terminal.type).toBe("done");
    expect(terminal.message.content).toEqual([
      expect.objectContaining({ type: "text", text: "- - item" }),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("drops followup prompts while preserving normal content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      '{"content":"hello"}{"followupPrompt":"this must not appear in the assistant response"}{"content":" world"}',
      { status: 200 },
    )) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    const terminal = events.at(-1) as unknown as {
      type: string;
      message: { stopReason: string; content: Array<{ type: string; text?: string }> };
    };

    expect(terminal.type).toBe("done");
    expect(terminal.message.stopReason).not.toBe("error");
    expect(terminal.message.content).toEqual([expect.objectContaining({ type: "text", text: "hello world" })]);
    expect(JSON.stringify(terminal.message.content)).not.toContain("this must not appear in the assistant response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a literal thinking tag inside prose stays visible text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        content:
          "Kiro replays reasoning as <thinking>...</thinking> in the stream, so quoting it must stay text.",
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key", reasoning: "low" })),
    );

    expect(events.filter((event) => event.type === "thinking_start")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("done");
    const terminal = events.at(-1) as unknown as { message: { content: Array<{ type: string; text?: string }> } };
    expect(terminal.message.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Kiro replays reasoning as <thinking>...</thinking> in the stream, so quoting it must stay text.",
      }),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sanitizes cross-provider history before sending Kiro request body", async () => {
  const originalFetch = globalThis.fetch;
  const codexToolCallId =
    "call_e94N00RInNHYopGvSJ49bbMu|fc_097faed57d5fbcf0016a7c371cfbac81919b3ce873bab9ad00";
  const messages: Message[] = [
    { role: "user", content: "start", timestamp: 0 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private signed reasoning" },
        { type: "text", text: "I will run a command." },
        { type: "toolCall", id: codexToolCallId, name: "bash", arguments: { command: "true" } },
      ],
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
      toolCallId: codexToolCallId,
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    },
    { role: "user", content: "continue", timestamp: 0 },
  ];
  let requestBody: unknown;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response('{"content":"done"}', { status: 200 });
  }) as typeof fetch;

  try {
    const events = await collectEvents(streamKiro(MODEL, { messages, tools: [] }, { apiKey: "test-key" }));
    expect(events.at(-1)?.type).toBe("done");

    const body = requestBody as {
      conversationState: {
        currentMessage: { userInputMessage: { content: string } };
        history: Array<{
          assistantResponseMessage?: { content: string; toolUses?: Array<{ toolUseId: string }> };
          userInputMessage?: { userInputMessageContext?: { toolResults?: Array<{ toolUseId: string }> } };
        }>;
      };
    };
    const serialized = JSON.stringify(body);
    const toolUseId = body.conversationState.history[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId;
    const toolResultId =
      body.conversationState.history[2]?.userInputMessage?.userInputMessageContext?.toolResults?.[0]
        ?.toolUseId;

    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("continue");
    expect(toolUseId).toBe(toolResultId);
    expect(toolUseId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(toolUseId!.length).toBeLessThanOrEqual(64);
    expect(serialized).not.toContain("|");
    expect(serialized).not.toContain("private signed reasoning");
    expect(serialized).not.toContain("<thinking>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports malformed tool call arguments without discarding preceding text", async () => {
  const originalFetch = globalThis.fetch;
  const malformedInput = '{"q":';
  globalThis.fetch = (async () =>
    new Response(
      '{"content":"visible text"}{"name":"lookup","toolUseId":"call-1","input":"{\\"q\\":","stop":true}',
      { status: 200 },
    )) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    const terminal = events.at(-1) as unknown as {
      type: string;
      error: {
        stopReason: string;
        errorMessage: string;
        content: Array<{ type: string; text?: string }>;
      };
    };

    expect(terminal.type).toBe("error");
    expect(terminal.error.stopReason).toBe("error");
    expect(terminal.error.errorMessage).toContain('tool "lookup" returned unusable JSON arguments');
    expect(terminal.error.errorMessage).not.toContain(malformedInput);
    expect(terminal.error.content).toEqual([expect.objectContaining({ type: "text", text: "visible text" })]);
    // The text block must be closed exactly once: the clean-EOF path and the
    // catch handler both finalize, so an unflagged inline close would emit a
    // second text_end for the same block.
    expect(events.filter((event) => event.type === "text_end")).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects tool call arguments that parse to a non-object", async () => {
  const originalFetch = globalThis.fetch;
  // Each of these is valid JSON but not a record, which is the shape pi's
  // ToolCall.arguments requires.
  for (const input of ["null", "[1,2]", '\\"hi\\"', "42"]) {
    globalThis.fetch = (async () =>
      new Response(`{"name":"lookup","toolUseId":"c1","input":"${input}","stop":true}`, {
        status: 200,
      })) as unknown as typeof fetch;

    try {
      const events = await withImmediateTimers(() =>
        collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
      );
      const terminal = events.at(-1) as unknown as {
        type: string;
        error: { stopReason: string; errorMessage: string; content: Array<{ type: string }> };
      };

      expect(terminal.type).toBe("error");
      expect(terminal.error.stopReason).toBe("error");
      expect(terminal.error.errorMessage).toContain("unusable JSON arguments");
      expect(terminal.error.content.filter((c) => c.type === "toolCall")).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("does not retry a malformed tool call behind a stream error", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    // First attempt: an unusable tool call followed by a normally retryable
    // stream error. Retrying would let the clean second attempt report `stop`
    // and bury the dropped action.
    if (fetchCalls === 1) {
      return new Response(
        '{"name":"lookup","toolUseId":"c1","input":"{bad","stop":true}{"error":"temporary","message":"m"}',
        { status: 200 },
      );
    }
    return new Response('{"content":"clean"}{"contextUsagePercentage":5}', { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    const terminal = events.at(-1) as unknown as {
      type: string;
      error: { stopReason: string; errorMessage: string };
    };

    expect(fetchCalls).toBe(1);
    expect(terminal.type).toBe("error");
    expect(terminal.error.errorMessage).toContain("unusable JSON arguments");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the tool call reason when the reader fails afterwards", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  // A later transport failure must not replace an already-detected unusable
  // tool call: that would hide the dropped action all over again.
  globalThis.fetch = (async () => {
    let reads = 0;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads === 1) {
              return {
                done: false,
                value: encoder.encode('{"name":"lookup","toolUseId":"c1","input":"{bad","stop":true}'),
              };
            }
            throw new Error("reader exploded");
          },
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    const terminal = events.at(-1) as unknown as {
      type: string;
      error: { errorMessage: string };
    };

    expect(terminal.type).toBe("error");
    expect(terminal.error.errorMessage).toContain("unusable JSON arguments");
    expect(terminal.error.errorMessage).not.toContain("reader exploded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts empty tool call arguments as an empty object", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      '{"name":"lookup","toolUseId":"call-1","input":"   ","stop":true}{"contextUsagePercentage":10}',
      { status: 200 },
    )) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    const terminal = events.at(-1) as unknown as {
      type: string;
      message: { content: Array<{ type: string; name?: string; id?: string; arguments?: unknown }> };
    };

    expect(terminal.type).toBe("done");
    expect(terminal.message.content).toEqual([
      expect.objectContaining({ type: "toolCall", name: "lookup", id: "call-1", arguments: {} }),
    ]);
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
