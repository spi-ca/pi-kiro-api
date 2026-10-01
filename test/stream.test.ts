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

async function withFakeClock<T>(
  run: (clock: { advance: (ms: number) => void; pending: () => number }) => Promise<T>,
): Promise<T> {
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
      pending() {
        return timers.size;
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

test("times out stalled fetches before headers and clears deadline timers", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    if (fetchCalls === 1) return new Promise<Response>(() => {});
    return new Response('{"content":"after headers"}{"contextUsagePercentage":1}', { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const events = await withFakeClock(async (clock) => {
      const eventsPromise = collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" }));
      await flushMicrotasks();
      clock.advance(90_000);
      await flushMicrotasks();
      clock.advance(1_000);
      const result = await eventsPromise;
      expect(clock.pending()).toBe(0);
      return result;
    });

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cleans attempt deadlines when response body acquisition throws synchronously", async () => {
  const originalFetch = globalThis.fetch;

  try {
    for (const failurePoint of ["body", "getReader"] as const) {
      const controller = new AbortController();
      const signal = controller.signal;
      const originalAddEventListener = signal.addEventListener;
      const originalRemoveEventListener = signal.removeEventListener;
      let abortListenersAdded = 0;
      let abortListenersRemoved = 0;
      signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === "abort") abortListenersAdded++;
        return originalAddEventListener.call(signal, type, listener, options);
      }) as typeof signal.addEventListener;
      signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        if (type === "abort") abortListenersRemoved++;
        return originalRemoveEventListener.call(signal, type, listener, options);
      }) as typeof signal.removeEventListener;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          get body() {
            if (failurePoint === "body") throw new Error("body getter exploded");
            return {
              getReader() {
                if (failurePoint === "getReader") throw new Error("getReader exploded");
                throw new Error("unreachable");
              },
            };
          },
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        await withFakeClock(async (clock) => {
          const events = await collectEvents(
            streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key", signal }),
          );
          expect(events.at(-1)).toEqual(expect.objectContaining({ type: "error" }));
          // The first-event timer was armed before fetch and must be removed
          // even when either synchronous getter throws.
          expect(clock.pending()).toBe(0);
        });
        expect(abortListenersAdded).toBe(1);
        expect(abortListenersRemoved).toBe(1);
      } finally {
        signal.addEventListener = originalAddEventListener;
        signal.removeEventListener = originalRemoveEventListener;
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("removes retry-delay abort listeners after a successful timer", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAddEventListener = signal.addEventListener;
  const originalRemoveEventListener = signal.removeEventListener;
  let added = 0;
  let removed = 0;
  signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "abort") added++;
    return originalAddEventListener.call(signal, type, listener, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "abort") removed++;
    return originalRemoveEventListener.call(signal, type, listener, options);
  }) as typeof signal.removeEventListener;

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(
      fetchCalls === 1 ? "" : '{"content":"after retry"}{"contextUsagePercentage":1}',
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  try {
    const events = await withFakeClock(async (clock) => {
      const eventsPromise = collectEvents(
        streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key", signal }),
      );
      await flushMicrotasks();
      clock.advance(1_000);
      await flushMicrotasks();
      return await eventsPromise;
    });

    // Two first-event deadlines and one successful retry delay each attach
    // and remove exactly one listener.
    expect(fetchCalls).toBe(2);
    expect(added).toBe(3);
    expect(removed).toBe(3);
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    signal.addEventListener = originalAddEventListener;
    signal.removeEventListener = originalRemoveEventListener;
    globalThis.fetch = originalFetch;
  }
});

test("preserves caller aborts during a stalled pre-header request", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;

  try {
    const eventsPromise = collectEvents(
      streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key", signal: controller.signal }),
    );
    await flushMicrotasks();
    controller.abort(new Error("caller stopped request"));
    const events = await eventsPromise;

    expect(fetchCalls).toBe(1);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "error", reason: "aborted" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves caller aborts after the first event", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let cancelled = false;
  let reads = 0;
  let secondReadStarted: (() => void) | undefined;
  const secondRead = new Promise<void>((resolve) => {
    secondReadStarted = resolve;
  });
  globalThis.fetch = (async () =>
    ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads === 1) return { done: false, value: encoder.encode('{"content":"visible"}') };
            secondReadStarted?.();
            return new Promise<never>(() => {});
          },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    }) as unknown as Response) as unknown as typeof fetch;

  try {
    const eventsPromise = collectEvents(
      streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key", signal: controller.signal }),
    );
    await secondRead;
    controller.abort(new Error("caller stopped after first event"));
    const events = await eventsPromise;

    expect(cancelled).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text_delta", delta: "visible" }),
        expect.objectContaining({ type: "error", reason: "aborted" }),
      ]),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settles post-first-event idle timeout when reader cancellation never settles", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let reads = 0;
  let cancelCalls = 0;
  let secondReadStarted: (() => void) | undefined;
  const secondRead = new Promise<void>((resolve) => {
    secondReadStarted = resolve;
  });
  globalThis.fetch = (async () =>
    ({
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            reads++;
            if (reads === 1) return Promise.resolve({ done: false, value: encoder.encode('{"content":"visible"}') });
            secondReadStarted?.();
            return new Promise<never>(() => {});
          },
          // Deliberately non-conforming: neither cancel nor the pending read
          // resolve. The idle deadline must still settle the stream.
          cancel: () => {
            cancelCalls++;
            return new Promise<never>(() => {});
          },
        }),
      },
    }) as unknown as Response) as unknown as typeof fetch;

  try {
    const events = await withFakeClock(async (clock) => {
      const eventsPromise = collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" }));
      await secondRead;
      clock.advance(300_000);
      await flushMicrotasks();
      const result = await eventsPromise;
      expect(clock.pending()).toBe(0);
      return result;
    });

    expect(cancelCalls).toBe(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text_delta", delta: "visible" }),
        expect.objectContaining({ type: "error", reason: "error" }),
      ]),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not reset idle timeout for repeated zero-byte reads", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let reads = 0;
  let cancelCalls = 0;
  let resolveRead: ((result: { done: boolean; value?: Uint8Array }) => void) | undefined;
  let resolveReadStarted: (() => void) | undefined;
  const readStarted = (target: number) =>
    new Promise<void>((resolve) => {
      if (reads >= target) resolve();
      else resolveReadStarted = resolve;
    });

  globalThis.fetch = (async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: () => {
          reads++;
          if (reads === 1) return Promise.resolve({ done: false, value: encoder.encode('{"content":"visible"}') });
          resolveReadStarted?.();
          return new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
            resolveRead = resolve;
          });
        },
        cancel: async () => {
          cancelCalls++;
        },
      }),
    },
  }) as unknown as Response) as unknown as typeof fetch;

  try {
    const events = await withFakeClock(async (clock) => {
      const eventsPromise = collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" }));
      await readStarted(2);
      // Each zero-byte read starts the next read, but none may move the
      // deadline armed by the initial content event.
      for (let i = 0; i < 3; i++) {
        resolveRead!({ done: false, value: new Uint8Array() });
        await readStarted(3 + i);
      }
      clock.advance(300_000);
      await flushMicrotasks();
      const result = await eventsPromise;
      expect(clock.pending()).toBe(0);
      return result;
    });

    expect(cancelCalls).toBe(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text_delta", delta: "visible" }),
        expect.objectContaining({ type: "error", reason: "error" }),
      ]),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("yields immediate empty reads so the first-event deadline can settle", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let reads = 0;
  let cancelCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            reads++;
            return Promise.resolve({ done: false, value: new Uint8Array() });
          },
          cancel: async () => {
            cancelCalls++;
          },
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );

    // The reader resolved synchronously thousands of times in the old loop,
    // preventing its deadline timer from firing at all.
    expect(reads).toBeGreaterThanOrEqual(64);
    expect(fetchCalls).toBe(4);
    expect(cancelCalls).toBe(4);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "error", reason: "error" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("times out stalled non-OK bodies before reading unbounded error data", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let cancelled = false;
  globalThis.fetch = (async () => {
    fetchCalls++;
    if (fetchCalls > 1) {
      return new Response('{"content":"after error body"}{"contextUsagePercentage":1}', { status: 200 });
    }
    return {
      ok: false,
      status: 503,
      statusText: "Unavailable",
      body: {
        getReader: () => ({
          read: () => new Promise<never>(() => {}),
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
      await flushMicrotasks();
      clock.advance(90_000);
      await flushMicrotasks();
      expect(cancelled).toBe(true);
      clock.advance(1_000);
      const result = await eventsPromise;
      expect(clock.pending()).toBe(0);
      return result;
    });

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    globalThis.fetch = originalFetch;
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

test("does not echo a hostile tool name into logs or the error message", async () => {
  const originalFetch = globalThis.fetch;
  const forged = "x\n[pi-kiro-api] ERROR forged line\u001b[31m";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ name: forged, toolUseId: "id\nfake", input: "{bad", stop: true }),
      { status: 200 },
    )) as unknown as typeof fetch;

  try {
    const events = await withImmediateTimers(() =>
      collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" })),
    );
    const terminal = events.at(-1) as unknown as { type: string; error: { errorMessage: string } };

    expect(terminal.type).toBe("error");
    // The wire-supplied name and ID fail the identifier allowlist, so neither
    // the newline nor the escape sequence can reach a console-formatted line.
    expect(terminal.error.errorMessage).toBe(
      'Kiro API error: tool "unknown" returned unusable JSON arguments',
    );
    expect(terminal.error.errorMessage).not.toContain("\n");
    expect(terminal.error.errorMessage).not.toContain("\u001b");
    expect(terminal.error.errorMessage).not.toContain("forged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancels the reader when parser finalization rejects an incomplete event", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let reads = 0;
  let cancelCalls = 0;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            reads++;
            return Promise.resolve(
              reads === 1
                ? { done: false, value: encoder.encode('{"content":"partial') }
                : { done: true },
            );
          },
          cancel: async () => {
            cancelCalls++;
          },
        }),
      },
    }) as unknown as Response) as unknown as typeof fetch;

  try {
    const events = await collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" }));
    expect(cancelCalls).toBe(1);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: "error", reason: "error", error: expect.objectContaining({ errorMessage: expect.stringContaining("incomplete event") }) }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a recognized incomplete event at EOF without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response('{"content":"partial', { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const events = await collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" }));
    const terminal = events.at(-1) as unknown as { type: string; error: { errorMessage: string } };

    expect(fetchCalls).toBe(1);
    expect(terminal.type).toBe("error");
    expect(terminal.error.errorMessage).toContain("incomplete event");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not emit a tool call when EOF arrives before its stop", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response('{"name":"lookup","toolUseId":"call-1","input":"{}"}', { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const events = await collectEvents(streamKiro(MODEL, { messages: [], tools: [] }, { apiKey: "test-key" }));
    const terminal = events.at(-1) as unknown as {
      type: string;
      error: { errorMessage: string; content: Array<{ type: string }> };
    };

    expect(fetchCalls).toBe(1);
    expect(terminal.type).toBe("error");
    expect(terminal.error.errorMessage).toContain("tool call ended before provider sent stop");
    expect(terminal.error.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
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

test("awaits payload replacement and response metadata before consuming the body", async () => {
  const order: string[] = [];
  let sent: unknown;
  let receivedResponse!: Response;
  const requestFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    order.push("fetch");
    sent = JSON.parse(String(init?.body));
    receivedResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"content":"ok"}{"contextUsagePercentage":1}'));
        controller.close();
      },
    }), { status: 200, headers: { "x-request-id": "test-id" } });
    return receivedResponse;
  };
  const result = await streamKiro(MODEL, { messages: [] }, {
    apiKey: "test-key",
    fetch: requestFetch as typeof fetch,
    async onPayload(payload, model) {
      expect(model).toBe(MODEL);
      expect(payload).toHaveProperty("conversationState");
      order.push("payload");
      await Promise.resolve();
      return { replacement: true };
    },
    async onResponse(metadata, model) {
      order.push("response");
      expect(model).toBe(MODEL);
      expect(metadata.status).toBe(200);
      expect(metadata.headers["x-request-id"]).toBe("test-id");
      expect(metadata).not.toHaveProperty("body");
      expect(receivedResponse.bodyUsed).toBe(false);
      expect(receivedResponse.body?.locked).toBe(false);
      await Promise.resolve();
      expect(receivedResponse.bodyUsed).toBe(false);
    },
    async onProviderStreamEvent(event, model) {
      order.push("event");
      expect(model).toBe(MODEL);
      await Promise.resolve();
      expect(event).toHaveProperty("type");
    },
  }).result();
  expect(sent).toEqual({ replacement: true });
  expect(order).toEqual(["payload", "fetch", "response", "event", "event"]);
  expect(result.content).toEqual([{ type: "text", text: "ok" }]);
});

test("payload hooks keep mutation on undefined and accept falsy replacements", async () => {
  for (const replacement of [undefined, null, false, 0, ""] as const) {
    let sent: unknown;
    await streamKiro(MODEL, { messages: [] }, {
      apiKey: "test-key",
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return new Response('{"content":"ok"}{"contextUsagePercentage":1}');
      }) as typeof fetch,
      onPayload(payload) {
        (payload as { agentMode: string }).agentMode = "mutated";
        return replacement;
      },
    }).result();
    if (replacement === undefined) expect(sent).toHaveProperty("agentMode", "mutated");
    else expect(sent).toBe(replacement);
  }
});

test("reports non-OK response metadata before reading its error body", async () => {
  let cancelled = false;
  const events = await collectEvents(streamKiro(MODEL, { messages: [] }, {
    apiKey: "test-key",
    fetch: (async () => new Response(new ReadableStream({
      pull() {},
      cancel() { cancelled = true; },
    }), { status: 403, headers: { "x-request-id": "rejected-id" } })) as unknown as typeof fetch,
    onResponse(metadata) {
      expect(metadata.status).toBe(403);
      expect(metadata.headers["x-request-id"]).toBe("rejected-id");
      throw new Error("observer failed before error body");
    },
  }));
  expect(cancelled).toBe(true);
  expect(events.at(-1)).toHaveProperty("error.errorMessage", "observer failed before error body");
  expect(events.filter((event) => event.type === "error")).toHaveLength(1);
});

test("observes parsed events in order before normalizing each block", async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observed: unknown[] = [];
  const delivered: string[] = [];
  const response = streamKiro(MODEL, { messages: [] }, {
    apiKey: "test-key",
    fetch: (async () => new Response('{"content":"first"}{"content":"second"}{"name":"lookup","toolUseId":"id","input":"{\\"items\\":[1,true]}","stop":true}{"usage":{"inputTokens":7,"outputTokens":3}}{"contextUsagePercentage":1}{"followupPrompt":"ignored"}')) as unknown as typeof fetch,
    async onProviderStreamEvent(event) {
      observed.push(event);
      if (observed.length === 1) {
        entered();
        await gate;
      }
    },
  });
  const collecting = (async () => {
    for await (const event of response) delivered.push(event.type);
  })();
  await enteredPromise;
  expect(delivered).not.toContain("text_start");
  expect(observed).toEqual([{ type: "content", data: "first" }]);
  release();
  await collecting;
  expect(observed).toEqual([
    { type: "content", data: "first" },
    { type: "content", data: "second" },
    { type: "toolUse", data: { name: "lookup", toolUseId: "id", input: '{"items":[1,true]}', stop: true } },
    { type: "usage", data: { inputTokens: 7, outputTokens: 3 } },
    { type: "contextUsage", data: { contextUsagePercentage: 1 } },
    { type: "followupPrompt", data: "ignored" },
  ]);
  const result = await response.result();
  expect(result.usage.input).toBe(7);
  expect(result.content).toEqual([
    { type: "text", text: "firstsecond" },
    { type: "toolCall", id: "id", name: "lookup", arguments: { items: [1, true] } },
  ]);
});

test("callback rejections terminate once, cancel bodies, and never retry", async () => {
  for (const phase of ["onPayload", "onResponse", "onProviderStreamEvent"] as const) {
    await withFakeClock(async (clock) => {
      let calls = 0;
      let cancelled = false;
      const response = streamKiro(MODEL, { messages: [] }, {
        apiKey: "test-key",
        fetch: (async () => {
          calls++;
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"content":"not yet normalized"}')); },
            cancel() { cancelled = true; },
          }));
        }) as unknown as typeof fetch,
        [phase]: async () => { throw new Error(`${phase} failed`); },
      });
      const events = await collectEvents(response);
      expect(calls).toBe(phase === "onPayload" ? 0 : 1);
      expect(cancelled).toBe(phase !== "onPayload");
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
      expect(events).not.toContainEqual(expect.objectContaining({ type: "done" }));
      expect((await response.result()).content).toEqual([]);
      expect((await response.result()).errorMessage).toBe(`${phase} failed`);
      expect(events.filter((event) => event.type === "start")).toHaveLength(phase === "onPayload" ? 0 : 1);
      expect(clock.pending()).toBe(0);
    });
  }
});

test("caller cancellation bounds hanging callbacks and ignores their late completion", async () => {
  for (const phase of ["onPayload", "onResponse", "onProviderStreamEvent"] as const) {
    await withFakeClock(async (clock) => {
      const controller = new AbortController();
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      let cancelled = false;
      const response = streamKiro(MODEL, { messages: [] }, {
        apiKey: "test-key", signal: controller.signal,
        fetch: (async () => {
          calls++;
          return new Response(new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode('{"content":"must not appear"}')); },
            cancel() { cancelled = true; },
          }));
        }) as unknown as typeof fetch,
        [phase]: () => { entered(); return gate; },
      });
      const collecting = collectEvents(response);
      await enteredPromise;
      controller.abort(new Error("cancel hook"));
      const events = await collecting;
      expect(events.at(-1)).toHaveProperty("reason", "aborted");
      expect((await response.result()).content).toEqual([]);
      expect(calls).toBe(phase === "onPayload" ? 0 : 1);
      expect(cancelled).toBe(phase !== "onPayload");
      expect(clock.pending()).toBe(0);
      const count = events.length;
      release();
      await flushMicrotasks();
      expect(events).toHaveLength(count);
    });
  }
});

test("first-event deadlines bound hanging payload/response hooks through all retries", async () => {
  for (const phase of ["onPayload", "onResponse"] as const) {
    await withFakeClock(async (clock) => {
      let entered = 0;
      let calls = 0;
      let cancellations = 0;
      const response = streamKiro(MODEL, { messages: [] }, {
        apiKey: "test-key",
        fetch: (async () => {
          calls++;
          return new Response(new ReadableStream({ cancel() { cancellations++; } }));
        }) as unknown as typeof fetch,
        [phase]: () => { entered++; return new Promise<void>(() => {}); },
      });
      const collecting = collectEvents(response);
      for (let attempt = 0; attempt < 4; attempt++) {
        for (let i = 0; i < 4; i++) await flushMicrotasks();
        expect(entered).toBe(attempt + 1);
        clock.advance(90_000);
        for (let i = 0; i < 4; i++) await flushMicrotasks();
        if (attempt < 3) clock.advance(1000 * 2 ** attempt);
      }
      const events = await collecting;
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
      expect((await response.result()).errorMessage).toContain("first token timeout");
      expect(calls).toBe(phase === "onPayload" ? 0 : 4);
      expect(cancellations).toBe(calls);
      expect(clock.pending()).toBe(0);
    });
  }
});

test("idle timeout retries invisible reader and first-observer stalls, then recovers", async () => {
  for (const stall of ["reader", "observer"] as const) {
    await withFakeClock(async (clock) => {
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      let cancellations = 0;
      const response = streamKiro(MODEL, { messages: [] }, {
        apiKey: "test-key",
        fetch: (async () => {
          calls++;
          if (calls === 2) return new Response('{"content":"recovered"}{"contextUsagePercentage":1}');
          let reads = 0;
          return {
            ok: true,
            body: {
              getReader: () => ({
                read() {
                  if (++reads === 1) return Promise.resolve({ done: false, value: new TextEncoder().encode(
                    stall === "reader" ? '{"contextUsagePercentage":1}' : '{"content":"discarded"}',
                  ) });
                  entered();
                  return new Promise<never>(() => {});
                },
                cancel() { cancellations++; return new Promise<never>(() => {}); },
              }),
            },
          } as unknown as Response;
        }) as unknown as typeof fetch,
        onProviderStreamEvent() {
          if (stall === "observer" && calls === 1) { entered(); return gate; }
        },
      });
      const collecting = collectEvents(response);
      await enteredPromise;
      // The parsed event disarms the first-event timer; idle is now the bound.
      clock.advance(300_000);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
      expect(calls).toBe(1);
      expect(cancellations).toBe(1);
      clock.advance(999);
      await flushMicrotasks();
      expect(calls).toBe(1);
      clock.advance(1);
      const events = await collecting;
      expect(calls).toBe(2);
      expect((await response.result()).content).toEqual([{ type: "text", text: "recovered" }]);
      expect(events.filter((event) => event.type === "start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "text_start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(events.filter((event) => event.type === "error")).toHaveLength(0);
      expect(clock.pending()).toBe(0);
      const count = events.length;
      release();
      await flushMicrotasks();
      expect(events).toHaveLength(count);
      expect((await response.result()).content).toEqual([{ type: "text", text: "recovered" }]);
    });
  }
});

test("invisible reader and first-observer idle stalls exhaust the same three retries", async () => {
  for (const stall of ["reader", "observer"] as const) {
    await withFakeClock(async (clock) => {
      let calls = 0;
      let entered = 0;
      let cancellations = 0;
      const response = streamKiro(MODEL, { messages: [] }, {
        apiKey: "test-key",
        fetch: (async () => {
          calls++;
          let reads = 0;
          return {
            ok: true,
            body: {
              getReader: () => ({
                read() {
                  if (++reads === 1) return Promise.resolve({ done: false, value: new TextEncoder().encode(
                    stall === "reader" ? '{"contextUsagePercentage":1}' : '{"content":"not normalized"}',
                  ) });
                  entered++;
                  return new Promise<never>(() => {});
                },
                cancel() { cancellations++; return new Promise<never>(() => {}); },
              }),
            },
          } as unknown as Response;
        }) as unknown as typeof fetch,
        onProviderStreamEvent() {
          if (stall === "observer") { entered++; return new Promise<void>(() => {}); }
        },
      });
      const collecting = collectEvents(response);
      for (let attempt = 0; attempt < 4; attempt++) {
        for (let i = 0; i < 4; i++) await flushMicrotasks();
        expect(calls).toBe(attempt + 1);
        expect(entered).toBe(attempt + 1);
        clock.advance(300_000);
        for (let i = 0; i < 4; i++) await flushMicrotasks();
        expect(cancellations).toBe(attempt + 1);
        if (attempt < 3) {
          // Preserve the established 1s, 2s, 4s retry backoff.
          clock.advance(1000 * 2 ** attempt - 1);
          await flushMicrotasks();
          expect(calls).toBe(attempt + 1);
          clock.advance(1);
        }
      }
      const events = await collecting;
      expect(calls).toBe(4);
      expect(events.filter((event) => event.type === "start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
      expect(events.filter((event) => event.type === "done")).toHaveLength(0);
      expect((await response.result()).content).toEqual([]);
      expect((await response.result()).errorMessage).toBe("Kiro API error: idle timeout after max retries");
      expect(clock.pending()).toBe(0);
    });
  }
});

test("idle deadline bounds a hanging parsed-event observer and closes visible text", async () => {
  await withFakeClock(async (clock) => {
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let observed = 0;
    let calls = 0;
    let cancelled = false;
    const response = streamKiro(MODEL, { messages: [] }, {
      apiKey: "test-key",
      fetch: (async () => {
        calls++;
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('{"content":"visible"}{"content":"blocked"}')); },
          cancel() { cancelled = true; },
        }));
      }) as unknown as typeof fetch,
      onProviderStreamEvent() {
        observed++;
        if (observed === 2) { entered(); return new Promise<void>(() => {}); }
      },
    });
    const collecting = collectEvents(response);
    await enteredPromise;
    clock.advance(300_000);
    const events = await collecting;
    expect(cancelled).toBe(true);
    expect(calls).toBe(1);
    expect((await response.result()).errorMessage).toBe("Kiro API error: idle timeout after provider output");
    expect((await response.result()).content).toEqual([{ type: "text", text: "visible" }]);
    expect(events.filter((event) => event.type === "text_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "text_end")).toHaveLength(1);
    expect(events.at(-1)).toHaveProperty("type", "error");
    expect(clock.pending()).toBe(0);
  });
});

test("a synchronously aborting hook cannot normalize events or leak a rejected promise", async () => {
  for (const phase of ["onPayload", "onResponse", "onProviderStreamEvent"] as const) {
    const controller = new AbortController();
    const response = streamKiro(MODEL, { messages: [] }, {
      apiKey: "test-key", signal: controller.signal,
      fetch: (async () => new Response('{"content":"must not appear"}')) as unknown as typeof fetch,
      [phase]: () => {
        controller.abort(new Error("sync hook abort"));
        return Promise.reject(new Error("late hook rejection"));
      },
    });
    const events = await collectEvents(response);
    expect(events.at(-1)).toHaveProperty("reason", "aborted");
    expect((await response.result()).content).toEqual([]);
    expect((await response.result()).errorMessage).toBe("sync hook abort");
    await flushMicrotasks();
  }
});

test("observes error frames before reducing them to safe Pi errors", async () => {
  const observed: unknown[] = [];
  const response = streamKiro(MODEL, { messages: [] }, {
    apiKey: "test-key",
    fetch: (async () => new Response('{"content":"visible"}{"error":"ServiceFailure","message":"private prose"}')) as unknown as typeof fetch,
    onProviderStreamEvent(event) { observed.push(event); },
  });
  await collectEvents(response);
  expect(observed).toEqual([
    { type: "content", data: "visible" },
    { type: "error", data: { error: "ServiceFailure", message: "private prose" } },
  ]);
  expect((await response.result()).errorMessage).toContain("ServiceFailure");
  expect((await response.result()).errorMessage).not.toContain("private prose");
});

test("payload mutation cannot modify caller-owned tool schemas or historical arguments", async () => {
  const args = Object.freeze({ items: Object.freeze(["original"]) });
  const parameters = Object.freeze({ type: "object", properties: Object.freeze({ value: Object.freeze({ type: "string" }) }) });
  const context = {
    tools: [{ name: "lookup", description: "lookup", parameters }],
    messages: [
      { role: "user", content: "question", timestamp: 0 },
      { role: "assistant", content: [{ type: "toolCall", id: "id", name: "lookup", arguments: args }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
      { role: "toolResult", toolCallId: "id", toolName: "lookup", content: [{ type: "text", text: "result" }], isError: false, timestamp: 2 },
    ] as Message[],
  };
  const snapshot = structuredClone(context);
  let sent: { conversationState: { history: Array<{ assistantResponseMessage?: { toolUses: Array<{ input: { items: string[] } }> } }> } } | undefined;
  const result = await streamKiro(MODEL, context, {
    apiKey: "test-key",
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response('{"content":"ok"}{"contextUsagePercentage":1}');
    }) as typeof fetch,
    onPayload(payload) {
      const request = payload as {
        conversationState: {
          history: Array<{ assistantResponseMessage?: { toolUses: Array<{ input: { items: string[] } }> } }>;
          currentMessage: { userInputMessage: { userInputMessageContext: { tools: Array<{ toolSpecification: { inputSchema: { json: { properties: { value: { type: string } } } } } }> } } };
        };
      };
      request.conversationState.history[1]!.assistantResponseMessage!.toolUses[0]!.input.items.push("hook");
      request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0]!.toolSpecification.inputSchema.json.properties.value.type = "number";
    },
  }).result();
  expect(result.stopReason).toBe("stop");
  expect(sent?.conversationState.history[1]?.assistantResponseMessage?.toolUses[0]?.input.items).toEqual(["original", "hook"]);
  expect(context).toEqual(snapshot);
});
