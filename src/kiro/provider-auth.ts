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
import { type KiroModel, toPiModelId } from "./models.ts";
import { streamKiro } from "./stream.ts";
import { sanitizeThinkingLevelMap } from "./thinking.ts";

export const KIRO_PROVIDER_ID = "kiro-api-key";
export const DEFAULT_KIRO_REGION = "us-east-1";

const REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;
const CATALOG_SCOPE_PREFIX = "kiro-catalog-scope-sha256:";
const CATALOG_CACHE_PREFIX = "kiro-catalog-v2:";
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

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
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
type PlainDataRecord = Record<PropertyKey, unknown>;

/** Read only own data properties so hand-edited cache accessors never execute. */
function ownDataValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    // A proxy can make reflective operations throw. It is not valid persisted
    // JSON data, so treat it exactly like any other malformed cache value.
    return undefined;
  }
}

function hasOwnProperty(value: object, key: PropertyKey): boolean {
  try {
    return Object.hasOwn(value, key);
  } catch {
    return true;
  }
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isPlainDataRecord(value: unknown): value is PlainDataRecord {
  if (!value || typeof value !== "object" || isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** Copy an array through own data descriptors, rejecting holes and accessors. */
function dataArrayValues(value: unknown): unknown[] | undefined {
  if (!isArray(value)) return undefined;
  const length = ownDataValue(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined;

  const values: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const entry = ownDataValue(value, String(index));
    if (entry === undefined) return undefined;
    values.push(entry);
  }
  return values;
}

/**
 * Copy supported thinking-map values before sanitizing so sanitization cannot
 * invoke an accessor from caller-controlled persisted data.
 */
function storedThinkingLevelMap(value: unknown): unknown | undefined {
  if (value === undefined) return undefined;
  if (!isPlainDataRecord(value)) return undefined;

  const copied: Record<string, string | null> = {};
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const present = hasOwnProperty(value, level);
    const entry = ownDataValue(value, level);
    if (!present) continue;
    if (entry !== null && typeof entry !== "string") return undefined;
    copied[level] = entry;
  }
  return copied;
}

function canonicalModel(model: unknown, endpoint: string): Model<KiroApi> | undefined {
  if (!isPlainDataRecord(model)) return undefined;

  const api = ownDataValue(model, "api");
  const provider = ownDataValue(model, "provider");
  const id = ownDataValue(model, "id");
  const baseUrl = ownDataValue(model, "baseUrl");
  const name = ownDataValue(model, "name");
  const input = dataArrayValues(ownDataValue(model, "input"));
  const wireModelId = ownDataValue(model, "wireModelId");
  const contextWindow = ownDataValue(model, "contextWindow");
  const maxTokens = ownDataValue(model, "maxTokens");
  const reasoning = ownDataValue(model, "reasoning");
  const reasoningHidden = ownDataValue(model, "reasoningHidden");
  const firstTokenTimeout = ownDataValue(model, "firstTokenTimeout");
  const hasThinkingLevelMap = hasOwnProperty(model, "thinkingLevelMap");
  const thinkingLevelMap = storedThinkingLevelMap(ownDataValue(model, "thinkingLevelMap"));

  if (
    api !== "kiro-api" ||
    provider !== KIRO_PROVIDER_ID ||
    typeof id !== "string" ||
    id.length === 0 ||
    baseUrl !== endpoint ||
    typeof name !== "string" ||
    !input ||
    input.length === 0 ||
    !input.every((type) => type === "text" || type === "image") ||
    typeof wireModelId !== "string" ||
    wireModelId.length === 0 ||
    toPiModelId(wireModelId) !== id ||
    typeof contextWindow !== "number" ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    typeof maxTokens !== "number" ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    typeof reasoning !== "boolean" ||
    (hasOwnProperty(model, "reasoningHidden") && typeof reasoningHidden !== "boolean") ||
    (hasOwnProperty(model, "firstTokenTimeout") &&
      (typeof firstTokenTimeout !== "number" ||
        !Number.isSafeInteger(firstTokenTimeout) ||
        firstTokenTimeout <= 0)) ||
    (hasThinkingLevelMap && thinkingLevelMap === undefined)
  ) {
    return undefined;
  }

  // Sanitized rather than copied: a persisted catalog is caller-controlled
  // input, and these values are interpolated into the system prompt.
  const sanitizedThinkingLevelMap = sanitizeThinkingLevelMap(thinkingLevelMap);

  return {
    id,
    wireModelId,
    name: nonEmpty(name) ?? id,
    api: "kiro-api",
    provider: KIRO_PROVIDER_ID,
    baseUrl: endpoint,
    reasoning,
    ...(sanitizedThinkingLevelMap ? { thinkingLevelMap: sanitizedThinkingLevelMap } : {}),
    input,
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
    ...(reasoningHidden ? { reasoningHidden: true } : {}),
    ...(firstTokenTimeout !== undefined ? { firstTokenTimeout } : {}),
  } as KiroModel;
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
  candidateModels: unknown,
  scope: string,
  key: string,
  region: string,
): Catalog | undefined {
  const values = dataArrayValues(candidateModels);
  if (!values) return undefined;

  const endpoint = kiroBaseUrl(region);
  const models: Model<KiroApi>[] = [];
  const byId = new Map<string, Model<KiroApi>>();
  const wireIds = new Set<string>();
  for (const model of values) {
    const canonical = canonicalModel(model, endpoint);
    const wireModelId = (canonical as KiroModel | undefined)?.wireModelId;
    if (!canonical || !wireModelId || byId.has(canonical.id) || wireIds.has(wireModelId)) return undefined;
    models.push(canonical);
    byId.set(canonical.id, canonical);
    wireIds.add(wireModelId);
  }
  return models.length > 0 ? { models, byId, key, region, scope } : undefined;
}

function toProviderModels(models: readonly KiroModel[]): Model<KiroApi>[] {
  return models.map((model) => ({ ...model, provider: KIRO_PROVIDER_ID }));
}

async function validStoredCatalog(
  entry: Readonly<ModelsStoreEntry> | undefined,
  scope: string,
  key: string,
  region: string,
): Promise<Catalog | undefined> {
  if (!isPlainDataRecord(entry)) return undefined;
  const models = ownDataValue(entry, "models");
  const etag = ownDataValue(entry, "etag");
  if (!isArray(models) || typeof etag !== "string") return undefined;

  const restored = buildCatalog(models, scope, key, region);
  if (!restored) return undefined;
  // v1 scope-only entries have no content MAC. They are intentionally ignored:
  // cache-only/offline refresh remains network-free and a later online refresh
  // replaces them with a v2 entry.
  return etag === (await catalogCacheEtag(scope, key, restored.models)) ? restored : undefined;
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

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A non-secret digest binds the persisted catalog to the exact key and region. */
async function catalogScopeDigest(key: string, region: string): Promise<string> {
  const bytes = new TextEncoder().encode(`pi-kiro-api/catalog-scope/v1\0${key}\0${region}`);
  return CATALOG_SCOPE_PREFIX + hex(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Bind canonical catalog contents to its credential scope without persisting
 * the key. The cache is user-writable, so scope matching alone does not prove
 * that its public-ID → wire-ID allowlist was not modified after publication.
 */
async function catalogCacheEtag(scope: string, key: string, models: readonly Model<KiroApi>[]): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const contents = JSON.stringify(models);
  const signature = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(`pi-kiro-api/catalog-cache/v2\0${scope}\0${contents}`),
  );
  return `${CATALOG_CACHE_PREFIX}${scope.slice(CATALOG_SCOPE_PREFIX.length)}:${hex(signature)}`;
}

async function persistedCatalogEntry(catalog: Catalog): Promise<ModelsStoreEntry> {
  if (!catalog.scope || !catalog.key) throw new Error("Cannot persist an unscoped Kiro catalog.");
  return {
    models: [...catalog.models],
    etag: await catalogCacheEtag(catalog.scope, catalog.key, catalog.models),
  };
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
          const stored = await validStoredCatalog(context.stored, scope, key, region);
          if (stored && catalogsMatch(catalog, stored)) return;
          const live = catalog;
          await context.publish({
            persist: await persistedCatalogEntry(live),
            update: () => installCatalog(live),
          });
          return;
        }
        if (catalog.models.length > 0 || catalog.scope !== undefined) {
          if (!(await context.publish({ update: clearCatalog }))) return;
        }
        if (!scope || !key) return;

        const restored = await validStoredCatalog(context.stored, scope, key, region);
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
      await context.publish({ persist: await persistedCatalogEntry(fresh), update: () => installCatalog(fresh) });
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
