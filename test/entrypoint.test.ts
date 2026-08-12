import { expect, test } from "bun:test";
import type { Provider } from "@earendil-works/pi-ai";
import { getApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerKiroApiKeyProvider from "../extension.ts";
import { KIRO_PROVIDER_ID } from "../src/kiro/provider-auth.ts";

const MODEL_LIST = {
  models: [{ modelId: "claude-sonnet-4.6", supportedInputTypes: ["TEXT"] }],
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

function restoreEnv(name: "KIRO_API_KEY" | "KIRO_API_REGION" | "PI_OFFLINE", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("extension registers a native provider when no ambient key is configured", async () => {
  const oldKey = process.env.KIRO_API_KEY;
  const oldRegion = process.env.KIRO_API_REGION;
  delete process.env.KIRO_API_KEY;
  delete process.env.KIRO_API_REGION;
  try {
    const providers: Provider[] = [];
    await registerKiroApiKeyProvider({
      registerProvider: (provider: Provider) => providers.push(provider),
    } as unknown as ExtensionAPI);

    expect(providers).toHaveLength(1);
    expect(providers[0]).toEqual(
      expect.objectContaining({
        id: KIRO_PROVIDER_ID,
        name: "Kiro (API Key)",
        baseUrl: "https://q.us-east-1.amazonaws.com/",
        auth: expect.objectContaining({ apiKey: expect.any(Object) }),
        getModels: expect.any(Function),
        refreshModels: expect.any(Function),
        stream: expect.any(Function),
      }),
    );
    expect(providers[0]?.getModels()).toEqual([]);
  } finally {
    restoreEnv("KIRO_API_KEY", oldKey);
    restoreEnv("KIRO_API_REGION", oldRegion);
  }
});

test("extension registers Kiro streams for compat and blackhole bridge fallbacks", async () => {
  const oldKey = process.env.KIRO_API_KEY;
  const oldRegion = process.env.KIRO_API_REGION;
  const providerStreamsKey = Symbol.for("pi-blackhole:provider-streams");
  const oldProviderStreams = (globalThis as Record<symbol, unknown>)[providerStreamsKey];
  const providerStreams = new Map<string, Function>();
  delete process.env.KIRO_API_KEY;
  delete process.env.KIRO_API_REGION;
  (globalThis as Record<symbol, unknown>)[providerStreamsKey] = providerStreams;
  unregisterApiProviders(KIRO_PROVIDER_ID);
  try {
    await registerKiroApiKeyProvider({ registerProvider: () => {} } as unknown as ExtensionAPI);

    expect(getApiProvider("kiro-api")?.streamSimple).toBeFunction();
    expect(providerStreams.get("kiro-api")).toBeFunction();
  } finally {
    unregisterApiProviders(KIRO_PROVIDER_ID);
    if (oldProviderStreams === undefined) delete (globalThis as Record<symbol, unknown>)[providerStreamsKey];
    else (globalThis as Record<symbol, unknown>)[providerStreamsKey] = oldProviderStreams;
    restoreEnv("KIRO_API_KEY", oldKey);
    restoreEnv("KIRO_API_REGION", oldRegion);
  }
});

test("ambient startup discovers the catalog before provider registration", async () => {
  const oldKey = process.env.KIRO_API_KEY;
  const oldRegion = process.env.KIRO_API_REGION;
  const oldOffline = process.env.PI_OFFLINE;
  process.env.KIRO_API_KEY = "ambient-key";
  process.env.KIRO_API_REGION = "eu-central-1";
  delete process.env.PI_OFFLINE;
  try {
    const providers: Provider[] = [];
    const modelCountsAtRegistration: number[] = [];
    let fetchCalls = 0;
    await withMockFetch(
      async (input, init) => {
        fetchCalls++;
        expect(input).toBe("https://q.eu-central-1.amazonaws.com/");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ambient-key");
        return new Response(JSON.stringify(MODEL_LIST), { status: 200 });
      },
      () =>
        registerKiroApiKeyProvider({
          registerProvider: (provider: Provider) => {
            modelCountsAtRegistration.push(provider.getModels().length);
            providers.push(provider);
          },
        } as unknown as ExtensionAPI),
    );

    expect(fetchCalls).toBe(1);
    expect(providers).toHaveLength(1);
    expect(modelCountsAtRegistration).toEqual([2]);
    expect(providers[0]?.getModels()).toHaveLength(2);
  } finally {
    restoreEnv("KIRO_API_KEY", oldKey);
    restoreEnv("KIRO_API_REGION", oldRegion);
    restoreEnv("PI_OFFLINE", oldOffline);
  }
});

test("invalid ambient discovery still registers an empty provider", async () => {
  const oldKey = process.env.KIRO_API_KEY;
  const oldRegion = process.env.KIRO_API_REGION;
  const oldOffline = process.env.PI_OFFLINE;
  process.env.KIRO_API_KEY = "stale-ambient-key";
  process.env.KIRO_API_REGION = "eu-central-1";
  delete process.env.PI_OFFLINE;
  try {
    const providers: Provider[] = [];
    await withMockFetch(
      async () => new Response("denied", { status: 403 }),
      () =>
        registerKiroApiKeyProvider({
          registerProvider: (provider: Provider) => providers.push(provider),
        } as unknown as ExtensionAPI),
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]?.getModels()).toEqual([]);
  } finally {
    restoreEnv("KIRO_API_KEY", oldKey);
    restoreEnv("KIRO_API_REGION", oldRegion);
    restoreEnv("PI_OFFLINE", oldOffline);
  }
});

test("PI_OFFLINE=1 skips ambient discovery and still registers the provider", async () => {
  const oldKey = process.env.KIRO_API_KEY;
  const oldOffline = process.env.PI_OFFLINE;
  process.env.KIRO_API_KEY = "ambient-key";
  process.env.PI_OFFLINE = "1";
  try {
    const providers: Provider[] = [];
    let fetched = false;
    await withMockFetch(
      async () => {
        fetched = true;
        throw new Error("ambient discovery must not run offline");
      },
      () =>
        registerKiroApiKeyProvider({
          registerProvider: (provider: Provider) => providers.push(provider),
        } as unknown as ExtensionAPI),
    );
    expect(fetched).toBe(false);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.getModels()).toEqual([]);
  } finally {
    restoreEnv("KIRO_API_KEY", oldKey);
    restoreEnv("PI_OFFLINE", oldOffline);
  }
});
