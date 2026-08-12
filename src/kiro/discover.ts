// Dynamic model discovery against Kiro's ListAvailableModels operation.
//
// The model catalog in models.ts is a static snapshot; it cannot reflect
// models scoped to a specific org or entitlement. This module asks the API
// what *this* key can actually reach and builds the provider's model list
// from the response.
//
// Discovery is authoritative: if the call fails we surface the error rather
// than silently falling back to the static catalog. A stale fallback would
// both offer models the org cannot use and hide ones it can, which is the
// exact failure mode dynamic discovery exists to prevent.

import { log } from "./debug.ts";
import { readResponseTextBounded, sanitizeKiroError } from "./errors.ts";
import { KIRO_ORIGIN } from "./transform.ts";
import { kiroModels, type KiroModel } from "./models.ts";

/**
 * Note the service prefix: the list operation lives on
 * `AmazonCodeWhispererService`, NOT the `AmazonCodeWhispererStreamingService`
 * used for GenerateAssistantResponse. The streaming prefix answers this
 * target with UnknownOperationException.
 */
const LIST_TARGET = "AmazonCodeWhispererService.ListAvailableModels";

/** Discovery blocks startup, so it gets a tight bound of its own. */
const LIST_TIMEOUT_MS = 15_000;

/** Shape of the subset of ListAvailableModels we consume. */
interface ApiModel {
  modelId: string;
  modelName?: string;
  description?: string;
  supportedInputTypes?: string[];
  rateMultiplier?: number;
  tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
}

interface ListResponse {
  defaultModel?: ApiModel;
  models?: ApiModel[];
}

function buildUserAgent(): string {
  const mid = crypto.randomUUID().replace(/-/g, "");
  return `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
}

/**
 * Static per-model behavior flags the API does not report. Keyed by Kiro's
 * dot-form ID. `reasoningHidden` and `firstTokenTimeout` are client-side
 * concerns discovered empirically, so they stay hand-maintained and are
 * merged onto whatever the API returns.
 */
const BEHAVIOR_BY_KIRO_ID: Record<string, Partial<KiroModel>> = Object.fromEntries(
  kiroModels.map((m) => [
    m.id.replace(/(\d)-(\d)/g, "$1.$2"),
    {
      ...(m.reasoningHidden ? { reasoningHidden: true } : {}),
      ...(m.firstTokenTimeout ? { firstTokenTimeout: m.firstTokenTimeout } : {}),
    },
  ]),
);

/**
 * Long-context variants are a client-side convention: the API advertises
 * e.g. `claude-sonnet-4.6` but also accepts the derived
 * `claude-sonnet-4.6-1m` form, which the list response never mentions. This
 * is Kiro's `-1m` exception to literal response IDs. Derive it only when the
 * API confirmed the base model, preserving the entitlement boundary for every
 * other ID.
 */
const ONE_M_SUFFIX = "-1m";
const ONE_M_CONTEXT = 1_000_000;

/** Convert a Kiro dot-form ID to pi's dash form (4.6 → 4-6). */
function toPiId(kiroId: string): string {
  return kiroId.replace(/(\d)\.(\d)/g, "$1-$2");
}

function toKiroModel(api: ApiModel, baseUrl: string): KiroModel {
  const piId = toPiId(api.modelId);
  const types = api.supportedInputTypes ?? ["TEXT"];
  const input: ("text" | "image")[] = types.some((t) => t.toUpperCase() === "IMAGE")
    ? ["text", "image"]
    : ["text"];

  return {
    id: piId,
    name: api.modelName ?? piId,
    api: "kiro-api",
    provider: "kiro",
    baseUrl,
    // The API reports no reasoning capability flag. Treat every model as
    // reasoning-capable: stream.ts gates the `<thinking_mode>` directive on
    // this, and an unnecessary directive is far cheaper than suppressing
    // reasoning on a model that supports it.
    reasoning: true,
    input,
    // Kiro bills in credits via rateMultiplier, not per-token USD. There is
    // no token price to report, so cost stays zero and the multiplier is
    // surfaced in the model name instead.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: api.tokenLimits?.maxInputTokens ?? 200_000,
    maxTokens: api.tokenLimits?.maxOutputTokens ?? 8_192,
    ...BEHAVIOR_BY_KIRO_ID[api.modelId],
  };
}

/** Build the `-1m` companions for base models the API confirmed. */
function deriveLongContextVariants(discovered: KiroModel[], baseUrl: string): KiroModel[] {
  const present = new Set(discovered.map((m) => m.id));
  const out: KiroModel[] = [];

  for (const staticModel of kiroModels) {
    if (!staticModel.id.endsWith(ONE_M_SUFFIX)) continue;
    if (present.has(staticModel.id)) continue;

    const baseId = staticModel.id.slice(0, -ONE_M_SUFFIX.length);
    const base = discovered.find((m) => m.id === baseId);
    if (!base) continue;

    out.push({
      ...base,
      id: staticModel.id,
      name: `${base.name} (1M)`,
      contextWindow: ONE_M_CONTEXT,
      ...BEHAVIOR_BY_KIRO_ID[staticModel.id.replace(/(\d)-(\d)/g, "$1.$2")],
    });
  }
  return out;
}

/**
 * Ask Kiro which models this API key may use. Throws on any failure —
 * callers must not substitute a static list (see module header).
 */
export async function discoverKiroModels(
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<KiroModel[]> {
  const ua = buildUserAgent();
  const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  log.debug("discover.request", { baseUrl, origin: KIRO_ORIGIN });

  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        tokentype: "API_KEY",
        "X-Amz-Target": LIST_TARGET,
        "x-amzn-codewhisperer-optout": "true",
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
        "x-amz-user-agent": ua,
        "user-agent": ua,
      },
      // `origin` filters the result server-side and must match what
      // stream.ts sends on GenerateAssistantResponse, or we would advertise
      // models the chat path cannot actually use.
      body: JSON.stringify({ origin: KIRO_ORIGIN }),
      // API-key requests must not follow a redirect to an attacker-controlled
      // origin carrying the Authorization header.
      redirect: "error",
      signal: combined,
    });
  } catch (err) {
    const reason = timeout.aborted
      ? `timed out after ${LIST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`Kiro model discovery failed: ${reason}`);
  }

  if (!response.ok) {
    const detail = await readResponseTextBounded(response).catch(() => "");
    const safe = sanitizeKiroError(response.status, response.statusText, detail);
    if (log.isUnsafeDebugPayloadEnabled()) {
      log.debug("discover.error.payload", { status: response.status, body: detail });
    }
    throw new Error(`Kiro model discovery failed: ${safe}`);
  }

  const payload = (await response.json()) as ListResponse;
  const apiModels = payload.models ?? [];
  if (apiModels.length === 0) {
    throw new Error(
      "Kiro model discovery returned no models for this API key. " +
        "The key may lack model entitlements, or be scoped to another region.",
    );
  }

  const discovered = apiModels
    .filter((m) => typeof m.modelId === "string" && m.modelId.length > 0)
    .map((m) => toKiroModel(m, baseUrl));
  if (discovered.length === 0) {
    throw new Error(
      "Kiro model discovery returned no valid models for this API key. " +
        "The response did not contain a usable model ID.",
    );
  }

  const models = [...discovered, ...deriveLongContextVariants(discovered, baseUrl)];

  log.info("discover.ok", {
    count: models.length,
    discovered: discovered.map((m) => m.id),
    derived: models.length - discovered.length,
    defaultModel: payload.defaultModel?.modelId,
  });

  return models;
}
