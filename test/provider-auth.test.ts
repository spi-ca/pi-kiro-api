import { describe, expect, test } from "bun:test";
import type { ApiKeyCredential, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  DEFAULT_KIRO_REGION,
  KIRO_PROVIDER_ID,
  createKiroProvider,
  resolveKiroRegion,
} from "../src/kiro/provider-auth.ts";

const MODEL_LIST = {
  models: [
    {
      modelId: "claude-sonnet-4.6",
      modelName: "Claude Sonnet 4.6",
      supportedInputTypes: ["TEXT"],
      tokenLimits: { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
    },
  ],
};

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

function credential(key = "stored-key", region = "eu-central-1"): ApiKeyCredential {
  return { type: "api_key", key, env: { KIRO_API_REGION: region } };
}

function refreshContext(
  credentialValue: ApiKeyCredential | undefined = credential(),
  options: Partial<RefreshModelsContext> = {},
): RefreshModelsContext {
  return {
    credential: credentialValue,
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async ({ update }) => {
      update?.();
      return true;
    },
    ...options,
  };
}

describe("Kiro native provider authentication", () => {
  test("uses the default region and rejects unsafe region values", () => {
    expect(resolveKiroRegion(undefined)).toBe(DEFAULT_KIRO_REGION);
    expect(resolveKiroRegion("  eu-central-1  ")).toBe("eu-central-1");
    expect(() => resolveKiroRegion("https://example.test")).toThrow("Invalid Kiro API region");
    expect(() => resolveKiroRegion("us_east_1")).toThrow("Invalid Kiro API region");
  });

  test("uses Pi's native ApiKeyCredential/AuthResult resolution precedence", async () => {
    const provider = createKiroProvider();
    const result = await provider.auth.apiKey?.resolve({
      credential: credential("stored-key", "eu-central-1"),
      signal: new AbortController().signal,
      ctx: {
        env: async (name) => ({ KIRO_API_KEY: "environment-key", KIRO_API_REGION: "us-west-2" })[name],
        fileExists: async () => false,
      },
    });
    expect(result).toEqual({
      auth: { apiKey: "stored-key" },
      env: { KIRO_API_REGION: "eu-central-1" },
      source: "stored Kiro API key",
    });
  });

  test("login immediately installs its validated catalog", async () => {
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => {
        const provider = createKiroProvider();
        const answers = ["ksk_login-key", "eu-central-1"];
        await provider.auth.apiKey?.login?.({
          signal: new AbortController().signal,
          notify: () => {},
          prompt: async () => answers.shift() ?? "",
        });
        expect(provider.getModels()).toHaveLength(2); // Kiro's derived -1m companion is included.
        expect(provider.getModels().every((model) => model.provider === KIRO_PROVIDER_ID)).toBe(true);
      },
    );
  });

  test("login catalog is persisted by matching offline refresh and restores after restart", async () => {
    const provider = createKiroProvider();
    let loginCredential: ApiKeyCredential | undefined;
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => {
        const answers = ["ksk_login-sync-key", "eu-central-1"];
        loginCredential = await provider.auth.apiKey?.login?.({
          signal: new AbortController().signal,
          notify: () => {},
          prompt: async () => answers.shift() ?? "",
        });
      },
    );
    if (!loginCredential) throw new Error("login did not return a credential");

    let persisted: ModelsStoreEntry | undefined;
    let publications = 0;
    await provider.refreshModels?.(
      refreshContext(loginCredential, {
        allowNetwork: false,
        publish: async ({ persist, update }) => {
          publications++;
          persisted = persist ?? undefined;
          update?.();
          return true;
        },
      }),
    );
    expect(publications).toBe(1);
    expect(persisted).toEqual(
      expect.objectContaining({
        etag: expect.stringMatching(/^kiro-catalog-scope-sha256:[a-f0-9]{64}$/),
        models: provider.getModels(),
      }),
    );

    // A matching valid stored catalog is already synchronized, so ordinary
    // cache-only refreshes do not keep republishing it.
    await provider.refreshModels?.(
      refreshContext(loginCredential, {
        allowNetwork: false,
        stored: persisted,
        publish: async () => {
          publications++;
          return true;
        },
      }),
    );
    expect(publications).toBe(1);

    const restarted = createKiroProvider();
    await restarted.refreshModels?.(
      refreshContext(loginCredential, { allowNetwork: false, stored: persisted }),
    );
    expect(restarted.getModels()).toEqual(provider.getModels());
  });

  test("offline refresh retains a live catalog and does not fetch", async () => {
    const provider = createKiroProvider();
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => provider.refreshModels?.(refreshContext()),
    );
    const live = provider.getModels();
    let fetched = false;
    await withMockFetch(
      async () => {
        fetched = true;
        throw new Error("must not fetch offline");
      },
      async () => provider.refreshModels?.(refreshContext(credential(), { allowNetwork: false })),
    );
    expect(fetched).toBe(false);
    expect(provider.getModels()).toEqual(live);
  });

  test("offline scope change clears an ambient catalog before considering a different credential", async () => {
    const oldKey = process.env.KIRO_API_KEY;
    const oldRegion = process.env.KIRO_API_REGION;
    const oldOffline = process.env.PI_OFFLINE;
    process.env.KIRO_API_KEY = "ambient-key";
    process.env.KIRO_API_REGION = "us-east-1";
    delete process.env.PI_OFFLINE;
    try {
      const provider = createKiroProvider();
      await withMockFetch(
        async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
        () => provider.preloadAmbientCatalog(),
      );
      let publications = 0;
      await provider.refreshModels?.(
        refreshContext(credential("explicit-key", "eu-central-1"), {
          allowNetwork: false,
          publish: async ({ update }) => {
            publications++;
            update?.();
            return true;
          },
        }),
      );
      expect(publications).toBe(1);
      expect(provider.getModels()).toEqual([]);
    } finally {
      if (oldKey === undefined) delete process.env.KIRO_API_KEY;
      else process.env.KIRO_API_KEY = oldKey;
      if (oldRegion === undefined) delete process.env.KIRO_API_REGION;
      else process.env.KIRO_API_REGION = oldRegion;
      if (oldOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = oldOffline;
    }
  });

  test("same-scope network failure retains its live catalog", async () => {
    const provider = createKiroProvider();
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => provider.refreshModels?.(refreshContext()),
    );
    const live = provider.getModels();
    await withMockFetch(
      async () => {
        throw new Error("offline");
      },
      async () => {
        await expect(provider.refreshModels?.(refreshContext())).rejects.toThrow(
          "Kiro model discovery failed: offline",
        );
      },
    );
    expect(provider.getModels()).toEqual(live);
  });

  test("different-scope network failure clears the mismatched live catalog", async () => {
    const provider = createKiroProvider();
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => provider.refreshModels?.(refreshContext(credential("old-key"))),
    );
    let publications = 0;
    await withMockFetch(
      async () => {
        throw new Error("offline");
      },
      async () => {
        await expect(
          provider.refreshModels?.(
            refreshContext(credential("new-key"), {
              publish: async ({ update }) => {
                publications++;
                update?.();
                return true;
              },
            }),
          ),
        ).rejects.toThrow("Kiro model discovery failed: offline");
      },
    );
    expect(publications).toBe(1);
    expect(provider.getModels()).toEqual([]);
  });

  test("rejected generation publications cannot change catalog or allowlist", async () => {
    const provider = createKiroProvider();
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => provider.refreshModels?.(refreshContext()),
    );
    const before = provider.getModels();
    let fetchCalls = 0;
    await withMockFetch(
      async () => {
        fetchCalls++;
        return new Response(JSON.stringify(MODEL_LIST), { status: 200 });
      },
      async () =>
        provider.refreshModels?.(
          refreshContext(credential("new-key"), {
            publish: async () => false,
          }),
        ),
    );
    expect(fetchCalls).toBe(0);
    expect(provider.getModels()).toEqual(before);
  });

  test("a rejected fresh publication cannot install a superseded allowlist", async () => {
    const provider = createKiroProvider();
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => provider.refreshModels?.(refreshContext()),
    );
    let publications = 0;
    await withMockFetch(
      async () =>
        new Response(
          JSON.stringify({ models: [{ modelId: "claude-opus-4.6", supportedInputTypes: ["TEXT"] }] }),
          { status: 200 },
        ),
      async () =>
        provider.refreshModels?.(
          refreshContext(credential("new-key"), {
            publish: async ({ update }) => {
              publications++;
              if (publications === 1) {
                update?.();
                return true;
              }
              return false;
            },
          }),
        ),
    );
    expect(publications).toBe(2);
    expect(provider.getModels()).toEqual([]);
  });

  test("restores only a persisted catalog bound to the exact effective key and region", async () => {
    const source = createKiroProvider();
    let persisted: ModelsStoreEntry | undefined;
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () =>
        source.refreshModels?.(
          refreshContext(credential("scope-key", "eu-central-1"), {
            publish: async ({ update, persist }) => {
              persisted = persist ?? undefined;
              update?.();
              return true;
            },
          }),
        ),
    );
    expect(persisted?.etag).toMatch(/^kiro-catalog-scope-sha256:[a-f0-9]{64}$/);

    const matching = createKiroProvider();
    await matching.refreshModels?.(
      refreshContext(credential("scope-key", "eu-central-1"), {
        allowNetwork: false,
        stored: persisted,
      }),
    );
    expect(matching.getModels()).toHaveLength(2);

    const mismatching = createKiroProvider();
    await mismatching.refreshModels?.(
      refreshContext(credential("other-key", "eu-central-1"), {
        allowNetwork: false,
        stored: persisted,
      }),
    );
    expect(mismatching.getModels()).toEqual([]);
  });

  test("a failed ambient preload permits matching stored-cache offline recovery", async () => {
    const source = createKiroProvider();
    let persisted: ModelsStoreEntry | undefined;
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () =>
        source.refreshModels?.(
          refreshContext(credential("stored-key", "eu-central-1"), {
            publish: async ({ update, persist }) => {
              persisted = persist ?? undefined;
              update?.();
              return true;
            },
          }),
        ),
    );

    const oldKey = process.env.KIRO_API_KEY;
    const oldRegion = process.env.KIRO_API_REGION;
    const oldOffline = process.env.PI_OFFLINE;
    process.env.KIRO_API_KEY = "invalid-ambient-key";
    process.env.KIRO_API_REGION = "eu-central-1";
    delete process.env.PI_OFFLINE;
    try {
      const provider = createKiroProvider();
      await withMockFetch(
        async () => new Response("denied", { status: 403 }),
        () => provider.preloadAmbientCatalog(),
      );
      expect(provider.getModels()).toEqual([]);

      let fetchCalls = 0;
      await withMockFetch(
        async () => {
          fetchCalls++;
          throw new Error("cache-only refresh must not fetch");
        },
        async () => {
          await provider.refreshModels?.(
            refreshContext(credential("stored-key", "eu-central-1"), {
              allowNetwork: false,
              stored: persisted,
            }),
          );
        },
      );
      expect(fetchCalls).toBe(0);
      expect(provider.getModels()).toHaveLength(2);
    } finally {
      if (oldKey === undefined) delete process.env.KIRO_API_KEY;
      else process.env.KIRO_API_KEY = oldKey;
      if (oldRegion === undefined) delete process.env.KIRO_API_REGION;
      else process.env.KIRO_API_REGION = oldRegion;
      if (oldOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = oldOffline;
    }
  });

  test("a runtime-like mismatched key clears models cache-only without a network call", async () => {
    const provider = createKiroProvider();
    let persisted: ModelsStoreEntry | undefined;
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () =>
        provider.refreshModels?.(
          refreshContext(credential("stored-key", "eu-central-1"), {
            publish: async ({ update, persist }) => {
              persisted = persist ?? undefined;
              update?.();
              return true;
            },
          }),
        ),
    );
    expect(provider.getModels()).toHaveLength(2);

    let fetchCalls = 0;
    await withMockFetch(
      async () => {
        fetchCalls++;
        throw new Error("cache-only refresh must not fetch");
      },
      async () => {
        // A Pi --api-key-like runtime credential has no matching catalog
        // scope, so intentionally fail closed instead of exposing old models.
        await provider.refreshModels?.(
          refreshContext(credential("runtime-override-key", "eu-central-1"), {
            allowNetwork: false,
            stored: persisted,
          }),
        );
      },
    );
    expect(fetchCalls).toBe(0);
    expect(provider.getModels()).toEqual([]);
  });

  test("rejects a matching-scope cache with an unsafe endpoint", async () => {
    const source = createKiroProvider();
    let persisted: ModelsStoreEntry | undefined;
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () =>
        source.refreshModels?.(
          refreshContext(credential("scope-key", "eu-central-1"), {
            publish: async ({ update, persist }) => {
              persisted = persist ?? undefined;
              update?.();
              return true;
            },
          }),
        ),
    );
    const unsafe = {
      ...persisted!,
      models: persisted!.models.map((model) => ({ ...model, baseUrl: "https://evil.example/" })),
    };
    const restored = createKiroProvider();
    await restored.refreshModels?.(
      refreshContext(credential("scope-key", "eu-central-1"), { allowNetwork: false, stored: unsafe }),
    );
    expect(restored.getModels()).toEqual([]);
  });

  test("ambient preload discovers and atomically installs its catalog", async () => {
    const oldKey = process.env.KIRO_API_KEY;
    const oldRegion = process.env.KIRO_API_REGION;
    const oldOffline = process.env.PI_OFFLINE;
    process.env.KIRO_API_KEY = "ambient-key";
    process.env.KIRO_API_REGION = "ap-northeast-1";
    delete process.env.PI_OFFLINE;
    try {
      const provider = createKiroProvider();
      let fetchCalls = 0;
      await withMockFetch(
        async (input, init) => {
          fetchCalls++;
          expect(input).toBe("https://q.ap-northeast-1.amazonaws.com/");
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ambient-key");
          return new Response(JSON.stringify(MODEL_LIST), { status: 200 });
        },
        async () => provider.preloadAmbientCatalog(),
      );
      expect(fetchCalls).toBe(1);
      expect(provider.getModels()).toHaveLength(2);
      expect(provider.getModels().every((model) => model.provider === KIRO_PROVIDER_ID)).toBe(true);
    } finally {
      if (oldKey === undefined) delete process.env.KIRO_API_KEY;
      else process.env.KIRO_API_KEY = oldKey;
      if (oldRegion === undefined) delete process.env.KIRO_API_REGION;
      else process.env.KIRO_API_REGION = oldRegion;
      if (oldOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = oldOffline;
    }
  });

  test("PI_OFFLINE skips ambient preload without preventing registration", async () => {
    const oldKey = process.env.KIRO_API_KEY;
    const oldOffline = process.env.PI_OFFLINE;
    process.env.KIRO_API_KEY = "ambient-key";
    process.env.PI_OFFLINE = "1";
    try {
      let fetched = false;
      const provider = createKiroProvider();
      await withMockFetch(
        async () => {
          fetched = true;
          throw new Error("must not fetch offline");
        },
        () => provider.preloadAmbientCatalog(),
      );
      expect(fetched).toBe(false);
      expect(provider.getModels()).toEqual([]);
    } finally {
      if (oldKey === undefined) delete process.env.KIRO_API_KEY;
      else process.env.KIRO_API_KEY = oldKey;
      if (oldOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = oldOffline;
    }
  });

  test("stream dispatch rejects key/region mismatches and accepts the catalog credential", async () => {
    const provider = createKiroProvider();
    let fetchCalls = 0;
    await withMockFetch(
      async (input, init) => {
        fetchCalls++;
        if (fetchCalls === 1) return new Response(JSON.stringify(MODEL_LIST), { status: 200 });
        expect(input).toBe("https://q.eu-central-1.amazonaws.com/");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer validated-key");
        return new Response("denied", { status: 400 });
      },
      async () => {
        await provider.refreshModels?.(refreshContext(credential("validated-key", "eu-central-1")));
        const model = provider.getModels()[0]!;

        const keyMismatch = await provider.stream(
          model,
          { messages: [], tools: [] },
          { apiKey: "other-key", env: { KIRO_API_REGION: "eu-central-1" } },
        ).result();
        const regionMismatch = await provider.streamSimple(
          model,
          { messages: [], tools: [] },
          { apiKey: "validated-key", env: { KIRO_API_REGION: "us-west-2" } },
        ).result();
        const matching = await provider.streamSimple(
          model,
          { messages: [], tools: [] },
          { apiKey: "validated-key", env: { KIRO_API_REGION: "eu-central-1" } },
        ).result();

        for (const result of [keyMismatch, regionMismatch]) {
          expect(result.stopReason).toBe("error");
          expect(result.errorMessage).toBe("Kiro request credentials do not match the active catalog.");
          expect(result.errorMessage).not.toContain("validated-key");
          expect(result.errorMessage).not.toContain("other-key");
        }
        expect(matching.stopReason).toBe("error");
      },
    );
    // Discovery plus only the matching generation request.
    expect(fetchCalls).toBe(2);
  });

  test("stream dispatch uses the installed canonical endpoint, not caller model fields", async () => {
    const provider = createKiroProvider();
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => provider.refreshModels?.(refreshContext(credential("stream-key", "eu-central-1"))),
    );
    const crafted = {
      ...provider.getModels()[0]!,
      baseUrl: "https://evil.example/",
      provider: "evil-provider",
    };
    await withMockFetch(
      async (input, init) => {
        expect(input).toBe("https://q.eu-central-1.amazonaws.com/");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer stream-key");
        expect(init?.redirect).toBe("error");
        return new Response("denied", { status: 400 });
      },
      async () => {
        const result = await provider.streamSimple(
          crafted,
          { messages: [], tools: [] },
          { apiKey: "stream-key" },
        ).result();
        expect(result.stopReason).toBe("error");
      },
    );
  });

  test("unauthorized stream requests return terminal error streams", async () => {
    const provider = createKiroProvider();
    await withMockFetch(
      async () => new Response(JSON.stringify(MODEL_LIST), { status: 200 }),
      async () => provider.refreshModels?.(refreshContext()),
    );
    const unauthorized = { ...provider.getModels()[0]!, id: "not-published" };

    for (const stream of [
      provider.stream(unauthorized, { messages: [], tools: [] }, { apiKey: "stored-key" }),
      provider.streamSimple(unauthorized, { messages: [], tools: [] }, { apiKey: "stored-key" }),
    ]) {
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events).toEqual([
        expect.objectContaining({
          type: "error",
          reason: "error",
          error: expect.objectContaining({
            stopReason: "error",
            errorMessage: "Unknown or unauthorized Kiro model ID: not-published",
          }),
        }),
      ]);
    }
  });
});
