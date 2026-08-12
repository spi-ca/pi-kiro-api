import type {
  ApiKeyCredential,
  AssistantMessage,
  AssistantMessageEventStream,
  AuthResult,
  Model,
  ModelsStoreEntry,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { discoverKiroModels } from "./discover.ts";
import { type KiroModel } from "./models.ts";
import { streamKiro } from "./stream.ts";
import { sanitizeThinkingLevelMap } from "./thinking.ts";

export const KIRO_PROVIDER_ID = "kiro-api-key";
export const DEFAULT_KIRO_REGION = "us-east-1";

const REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;
const CATALOG_SCOPE_PREFIX = "kiro-catalog-scope-sha256:";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

type KiroApi = "kiro-api";
type Catalog = {
  models: readonly Model<KiroApi>[];
  byId: ReadonlyMap<string, Model<KiroApi>>;
  /** In-memory only: the validated credential that authorized this catalog. */
  key?: string;
  /** In-memory only: the validated region that authorized this catalog. */
  region?: string;
  /** Persisted non-secret key/region binding for cache matching. */
  scope?: string;
};

export type KiroProvider = Provider<KiroApi> & {
  /** Validate and install the catalog for an ambient key before registration. */
  preloadAmbientCatalog(): Promise<void>;
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** Reject endpoint-hostile values while accepting current AWS region names. */
export function resolveKiroRegion(value: string | undefined): string {
  const region = nonEmpty(value) ?? DEFAULT_KIRO_REGION;
  if (!REGION_PATTERN.test(region) || region.length > 63) {
    throw new Error(
      `Invalid Kiro API region "${region}". Use an AWS region such as ${DEFAULT_KIRO_REGION}.`,
    );
  }
  return region;
}

export function kiroBaseUrl(region: string): string {
  return `https://q.${region}.amazonaws.com/`;
}

function rejectedKeyError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP (?:401|403)\b/.test(message)) {
    return new Error(
      "Kiro API key was rejected. Run /login kiro-api-key or check KIRO_API_KEY. " + message,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * Rebuild models from only the catalog fields this provider supports. In
 * particular, never retain a stored caller-controlled endpoint, headers, or
 * provider identity. The endpoint must already be the exact scoped service
 * root before a cached model can be accepted.
 */
function canonicalModel(model: Model<KiroApi>, endpoint: string): Model<KiroApi> | undefined {
  if (
    model.api !== "kiro-api" ||
    model.provider !== KIRO_PROVIDER_ID ||
    typeof model.id !== "string" ||
    model.id.length === 0 ||
    model.baseUrl !== endpoint
  ) {
    return undefined;
  }

  const input: ("text" | "image")[] = Array.isArray(model.input) &&
    model.input.length > 0 &&
    model.input.every((type) => type === "text" || type === "image")
    ? [...model.input]
    : ["text"];
  const contextWindow = Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : 200_000;
  const maxTokens = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 8_192;
  const kiro = model as KiroModel;
  // Sanitized rather than copied: a persisted catalog is caller-controlled
  // input, and these values are interpolated into the system prompt.
  const thinkingLevelMap = sanitizeThinkingLevelMap(model.thinkingLevelMap);

  return {
    id: model.id,
    name: nonEmpty(model.name) ?? model.id,
    api: "kiro-api",
    provider: KIRO_PROVIDER_ID,
    baseUrl: endpoint,
    reasoning: model.reasoning === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input,
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
    ...(kiro.reasoningHidden === true ? { reasoningHidden: true } : {}),
    ...(Number.isSafeInteger(kiro.firstTokenTimeout) && kiro.firstTokenTimeout! > 0
      ? { firstTokenTimeout: kiro.firstTokenTimeout }
      : {}),
  };
}

/**
 * Adopt the requested model's thinking ladder onto the canonical model.
 *
 * Requests always stream through the canonical catalog entry so a caller
 * cannot substitute an endpoint, identity, or unlisted model ID. But Pi
 * applies user `modelOverrides` to the model it hands us, and
 * `thinkingLevelMap` is the one field a user is expected to tune. Adopting
 * just that field — sanitized — keeps overrides working without widening the
 * request boundary.
 */
function withRequestedThinkingLevels(
  canonical: Model<KiroApi>,
  requested: Model<KiroApi>,
): Model<KiroApi> {
  const map = sanitizeThinkingLevelMap(requested.thinkingLevelMap);
  if (!map) return canonical;
  return { ...canonical, thinkingLevelMap: map };
}

function buildCatalog(
  candidateModels: readonly Model<KiroApi>[],
  scope: string,
  key: string,
  region: string,
): Catalog | undefined {
  const endpoint = kiroBaseUrl(region);
  const models: Model<KiroApi>[] = [];
  const byId = new Map<string, Model<KiroApi>>();
  for (const model of candidateModels) {
    const canonical = canonicalModel(model, endpoint);
    if (!canonical || byId.has(canonical.id)) return undefined;
    models.push(canonical);
    byId.set(canonical.id, canonical);
  }
  return models.length > 0 ? { models, byId, key, region, scope } : undefined;
}

function toProviderModels(models: readonly KiroModel[]): Model<KiroApi>[] {
  return models.map((model) => ({ ...model, provider: KIRO_PROVIDER_ID }));
}

function validStoredCatalog(
  entry: Readonly<ModelsStoreEntry> | undefined,
  scope: string,
  key: string,
  region: string,
): Catalog | undefined {
  if (entry?.etag !== scope || !Array.isArray(entry.models)) return undefined;
  return buildCatalog(entry.models as Model<KiroApi>[], scope, key, region);
}

/** Stored models are canonicalized before this comparison, so this is stable across restarts. */
function catalogsMatch(left: Catalog, right: Catalog): boolean {
  return JSON.stringify(left.models) === JSON.stringify(right.models);
}

function offlineModeEnabled(): boolean {
  const value = process.env.PI_OFFLINE;
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

/**
 * The runtime request must use the same secret and region that produced the
 * live allowlist. Do not use process.env as a fallback here: Pi has already
 * resolved request options, and ambient state may have changed since catalog
 * discovery.
 */
function requestMatchesCatalog(
  catalog: Catalog,
  options: { apiKey?: string; env?: Record<string, string> } | undefined,
): boolean {
  if (!catalog.key || !catalog.region || options?.apiKey !== catalog.key) return false;
  const requestedRegion = options.env?.KIRO_API_REGION;
  if (requestedRegion === undefined) return true;
  try {
    return resolveKiroRegion(requestedRegion) === catalog.region;
  } catch {
    return false;
  }
}

/** A non-secret digest binds the persisted catalog to the exact key and region. */
async function catalogScopeDigest(key: string, region: string): Promise<string> {
  const bytes = new TextEncoder().encode(`pi-kiro-api/catalog-scope/v1\0${key}\0${region}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return (
    CATALOG_SCOPE_PREFIX +
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Native Pi provider with provider-owned API-key auth and catalog state.
 * The catalog models, ID-to-model dispatch map, and credential scope are one
 * immutable state value, so a request can never observe a new allowlist with
 * an old endpoint (or vice versa).
 */
export function createKiroProvider(): KiroProvider {
  let catalog: Catalog = { models: [], byId: new Map() };
  let ambientCredential: ApiKeyCredential | undefined;

  const installCatalog = (next: Catalog): void => {
    catalog = next;
  };
  const clearCatalog = (): void => installCatalog({ models: [], byId: new Map() });

  const effectiveCredential = (
    credential: RefreshModelsContext["credential"],
  ): ApiKeyCredential | undefined =>
    credential?.type === "api_key" && nonEmpty(credential.key) ? credential : ambientCredential;

  const provider: KiroProvider = {
    id: KIRO_PROVIDER_ID,
    name: "Kiro (API Key)",
    baseUrl: kiroBaseUrl(DEFAULT_KIRO_REGION),
    auth: {
      apiKey: {
        name: "Kiro API key",
        async login(interaction): Promise<ApiKeyCredential> {
          const key = nonEmpty(
            await interaction.prompt({ type: "secret", message: "Kiro API key" }),
          );
          if (!key) {
            throw new Error("Kiro API key is required. Run /login kiro-api-key or set KIRO_API_KEY.");
          }
          const region = resolveKiroRegion(
            await interaction.prompt({
              type: "text",
              message: `Kiro API region (default: ${DEFAULT_KIRO_REGION})`,
              placeholder: DEFAULT_KIRO_REGION,
            }),
          );

          try {
            const discovered = await discoverKiroModels(key, kiroBaseUrl(region), interaction.signal);
            const scope = await catalogScopeDigest(key, region);
            const next = buildCatalog(toProviderModels(discovered), scope, key, region);
            if (!next) throw new Error("Kiro model discovery returned an invalid catalog.");
            installCatalog(next);
          } catch (error) {
            throw rejectedKeyError(error);
          }
          return { type: "api_key", key, env: { KIRO_API_REGION: region } };
        },
        async resolve({ ctx, credential }): Promise<AuthResult | undefined> {
          const storedKey = nonEmpty(credential?.key);
          const ambientKey = nonEmpty(await ctx.env("KIRO_API_KEY"));
          const key = storedKey ?? ambientKey;
          if (!key) return undefined;

          const storedRegion = nonEmpty(credential?.env?.KIRO_API_REGION);
          const ambientRegion = nonEmpty(await ctx.env("KIRO_API_REGION"));
          const region = resolveKiroRegion(storedRegion ?? ambientRegion);
          return {
            auth: { apiKey: key },
            env: { KIRO_API_REGION: region },
            source: storedKey ? "stored Kiro API key" : "KIRO_API_KEY",
          };
        },
      },
    },
    getModels: () => catalog.models,
    async refreshModels(context): Promise<void> {
      const credential = effectiveCredential(context.credential);
      const key = nonEmpty(credential?.key);
      // Match apiKey.resolve's per-field region composition when refresh is
      // handed an explicit runtime key that omits its optional region field.
      const region = resolveKiroRegion(
        nonEmpty(credential?.env?.KIRO_API_REGION) ?? process.env.KIRO_API_REGION,
      );
      const scope = key ? await catalogScopeDigest(key, region) : undefined;

      if (!context.allowNetwork) {
        // Pi first calls this cache-only phase. A live catalog is reusable only
        // for the exact effective key+region; changing credentials clears it
        // through an accepted publication before considering matching storage.
        // Login has already validated and installed a matching catalog, but
        // its auth callback has no ModelsStore context. Publish it here so
        // Pi persists that same scoped result for a future offline restart.
        if (catalog.scope === scope && catalog.models.length > 0 && key && scope) {
          const stored = validStoredCatalog(context.stored, scope, key, region);
          if (stored && catalogsMatch(catalog, stored)) return;
          const live = catalog;
          await context.publish({
            persist: { models: [...live.models], etag: scope },
            update: () => installCatalog(live),
          });
          return;
        }
        if (catalog.models.length > 0 || catalog.scope !== undefined) {
          if (!(await context.publish({ update: clearCatalog }))) return;
        }
        if (!scope || !key) return;

        const restored = validStoredCatalog(context.stored, scope, key, region);
        if (restored) await context.publish({ update: () => installCatalog(restored) });
        return;
      }

      // A same-scope network refresh is non-destructive until a replacement is
      // ready: transient discovery failures retain both the live catalog and
      // its persisted cache. A scope change is fail-closed for live requests,
      // but deliberately leaves the old persisted cache in place; its digest
      // prevents it from being restored for the new credential.
      if (catalog.scope !== scope && (catalog.models.length > 0 || catalog.scope !== undefined)) {
        if (!(await context.publish({ update: clearCatalog }))) return;
      }
      if (!key || !scope || context.signal.aborted) return;

      let discovered: KiroModel[];
      try {
        discovered = await discoverKiroModels(key, kiroBaseUrl(region), context.signal);
      } catch (error) {
        throw rejectedKeyError(error);
      }
      if (context.signal.aborted) return;

      const fresh = buildCatalog(toProviderModels(discovered), scope, key, region);
      if (!fresh) throw new Error("Kiro model discovery returned an invalid catalog.");
      const persist: ModelsStoreEntry = { models: [...fresh.models], etag: scope };
      await context.publish({ persist, update: () => installCatalog(fresh) });
    },
    stream(model, context, options) {
      const canonical = catalog.byId.get(model.id);
      if (!canonical) return unauthorizedModelStream(model);
      if (!requestMatchesCatalog(catalog, options)) return unauthorizedRequestStream(model);
      return streamKiro(withRequestedThinkingLevels(canonical, model), context, options);
    },
    streamSimple(model, context, options) {
      const canonical = catalog.byId.get(model.id);
      if (!canonical) return unauthorizedModelStream(model);
      if (!requestMatchesCatalog(catalog, options)) return unauthorizedRequestStream(model);
      return streamKiro(withRequestedThinkingLevels(canonical, model), context, options);
    },
    async preloadAmbientCatalog(): Promise<void> {
      if (offlineModeEnabled()) return;
      const key = nonEmpty(process.env.KIRO_API_KEY);
      if (!key) return;
      try {
        const region = resolveKiroRegion(process.env.KIRO_API_REGION);
        const discovered = await discoverKiroModels(key, kiroBaseUrl(region));
        const scope = await catalogScopeDigest(key, region);
        const next = buildCatalog(toProviderModels(discovered), scope, key, region);
        if (!next) throw new Error("Kiro model discovery returned an invalid catalog.");
        installCatalog(next);
        ambientCredential = { type: "api_key", key, env: { KIRO_API_REGION: region } };
      } catch {
        // Pre-registration ambient discovery cannot inspect Pi's auth store.
        // It is only an optimization for env-only startup, so an invalid or
        // stale environment value must not block later native stored-credential
        // resolution or matching cache restoration.
        ambientCredential = undefined;
        clearCatalog();
      }
    },
  };

  return provider;
}

function unauthorizedModelStream(model: Model<KiroApi>): AssistantMessageEventStream {
  return terminalErrorStream(model, `Unknown or unauthorized Kiro model ID: ${model.id}`);
}

function unauthorizedRequestStream(model: Model<KiroApi>): AssistantMessageEventStream {
  return terminalErrorStream(model, "Kiro request credentials do not match the active catalog.");
}

function terminalErrorStream(model: Model<KiroApi>, errorMessage: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error });
  stream.end();
  return stream;
}
