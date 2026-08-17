import { describe, expect, test } from "bun:test";
import { discoverKiroModels } from "../src/kiro/discover.ts";
import { toKiroModelId } from "../src/kiro/models.ts";
import { createKiroProvider } from "../src/kiro/provider-auth.ts";

const BASE_URL = "https://q.eu-central-1.amazonaws.com/";

async function withMockFetch<T>(
  mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("Kiro model discovery", () => {
  test("maps the discovery response and sends the API-key request contract", async () => {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const models = await withMockFetch(
      async (input, init) => {
        request = { input, init };
        return new Response(
          JSON.stringify({
            defaultModel: { modelId: "claude-sonnet-4.6" },
            models: [
              {
                modelId: "claude-sonnet-4.6",
                modelName: "Claude Sonnet 4.6",
                supportedInputTypes: ["TEXT", "IMAGE"],
                tokenLimits: { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
              },
            ],
          }),
          { status: 200 },
        );
      },
      () => discoverKiroModels("ksk_test-key", BASE_URL),
    );

    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 8_192,
          baseUrl: BASE_URL,
        }),
      ]),
    );
    expect(request?.input).toBe(BASE_URL);
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer ksk_test-key");
    expect(headers.get("tokentype")).toBe("API_KEY");
    expect(headers.get("X-Amz-Target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
    expect(headers.get("Content-Type")).toBe("application/x-amz-json-1.0");
    expect(headers.get("x-amzn-codewhisperer-optout")).toBe("true");
    expect(request?.init?.redirect).toBe("error");
    expect(JSON.parse(String(request?.init?.body))).toEqual({ origin: "AI_EDITOR" });
    // Kiro accepts this derived companion although ListAvailableModels only
    // returned the base ID; no unrelated static model is introduced.
    expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6-1m"]);
    expect(toKiroModelId("unrelated-9-9")).toBe("unrelated-9.9");
  });

  test("is pure: discovery does not publish a catalog or allowlist", async () => {
    const provider = createKiroProvider();
    await withMockFetch(
      async () =>
        new Response(
          JSON.stringify({ models: [{ modelId: "claude-sonnet-4.6", supportedInputTypes: ["TEXT"] }] }),
          { status: 200 },
        ),
      async () => discoverKiroModels("ksk_test-key", BASE_URL),
    );
    expect(provider.getModels()).toEqual([]);
    const stream = provider.streamSimple(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "kiro-api",
        provider: "kiro-api-key",
        baseUrl: BASE_URL,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      { messages: [], tools: [] },
      { apiKey: "ksk_test-key" },
    );
    expect(await stream.result()).toEqual(
      expect.objectContaining({
        stopReason: "error",
        errorMessage: "Unknown or unauthorized Kiro model ID: claude-sonnet-4-6",
      }),
    );
  });

  test("surfaces rateMultiplier in the model display name", async () => {
    const models = await withMockFetch(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                modelId: "claude-opus-4.6",
                modelName: "Claude Opus 4.6",
                rateMultiplier: 5,
                supportedInputTypes: ["TEXT"],
              },
              {
                modelId: "claude-sonnet-4.6",
                modelName: "Claude Sonnet 4.6",
                rateMultiplier: 1,
                supportedInputTypes: ["TEXT"],
              },
              {
                modelId: "deepseek-3.2",
                modelName: "DeepSeek 3.2",
                supportedInputTypes: ["TEXT"],
              },
            ],
          }),
          { status: 200 },
        ),
      () => discoverKiroModels("ksk_test-key", BASE_URL),
    );

    const opus = models.find((m) => m.id === "claude-opus-4-6");
    expect(opus?.name).toBe("Claude Opus 4.6 (5x credits)");

    // rateMultiplier === 1 is the baseline; not surfaced.
    const sonnet = models.find((m) => m.id === "claude-sonnet-4-6");
    expect(sonnet?.name).toBe("Claude Sonnet 4.6");

    // undefined rateMultiplier is treated the same as 1.
    const deepseek = models.find((m) => m.id === "deepseek-3-2");
    expect(deepseek?.name).toBe("DeepSeek 3.2");
  });

  test("rejects empty and all-invalid discovery responses", async () => {
    await withMockFetch(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
      async () => {
        await expect(discoverKiroModels("ksk_test-key", BASE_URL)).rejects.toThrow(
          "returned no models",
        );
      },
    );

    await withMockFetch(
      async () =>
        new Response(JSON.stringify({ models: [{}, { modelId: "" }, { modelId: 42 }] }), {
          status: 200,
        }),
      async () => {
        await expect(discoverKiroModels("ksk_test-key", BASE_URL)).rejects.toThrow(
          "returned no valid models",
        );
      },
    );
  });

  test("surfaces status and stable code without service message fields", async () => {
    const secret = "account=private-user-token";
    const serviceMessage = "key rejected";
    await withMockFetch(
      async () =>
        new Response(JSON.stringify({ code: "AccessDeniedException", message: serviceMessage, errorMessage: secret }), {
          status: 403,
        }),
      async () => {
        await expect(discoverKiroModels("ksk_test-key", BASE_URL)).rejects.toThrow(
          "HTTP 403 (code=AccessDeniedException)",
        );
        await expect(discoverKiroModels("ksk_test-key", BASE_URL)).rejects.not.toThrow(secret);
        await expect(discoverKiroModels("ksk_test-key", BASE_URL)).rejects.not.toThrow(serviceMessage);
      },
    );
  });
});
