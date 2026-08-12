// Thinking-level → thinking-budget resolution for the Kiro API.
//
// Kiro has no reasoning wire field. The public Q CLI Smithy client serializes
// exactly these `userInputMessage` keys — content, userInputMessageContext,
// userIntent, origin, images, modelId, cachePoint, clientCacheConfig — and
// `ListAvailableModels` reports no reasoning capability. So the only channel
// for reasoning strength is the `<max_thinking_length>` system-prompt hint,
// which is advisory: upstream may or may not honor it.
//
// pi models the strength ladder with `thinkingLevelMap`. For built-in APIs
// pi-ai maps the level to a provider value inside its own adapter, but a
// provider that owns its `stream` must do that mapping itself. We therefore
// treat the map value as the token budget for the prompt hint, which also
// makes the ladder configurable through settings `modelOverrides`.

import type { Api, Model, ModelThinkingLevel, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Default ladder for Kiro models. Values are `<max_thinking_length>` token
 * budgets in string form, matching `ThinkingLevelMap`'s value type.
 *
 * `off` is deliberately absent: an absent key means "provider default", and
 * a `null` here would tell pi that thinking cannot be disabled. Defining
 * `xhigh` and `max` is what makes pi offer those extended levels at all —
 * pi hides them unless the map has a non-undefined entry.
 */
export const KIRO_THINKING_LEVEL_MAP: ThinkingLevelMap = Object.freeze({
  minimal: "4000",
  low: "10000",
  medium: "20000",
  high: "30000",
  xhigh: "50000",
  max: "64000",
});

/**
 * Ladder for models whose reasoning upstream hides. `stream.ts` skips the
 * `<thinking_mode>` directive for those, so no budget can reach the model.
 * Extended levels are marked unsupported rather than advertised as knobs
 * that change nothing; standard levels stay visible because pi always shows
 * `off` through `high` for a reasoning-capable model.
 */
export const KIRO_HIDDEN_THINKING_LEVEL_MAP: ThinkingLevelMap = Object.freeze({
  xhigh: null,
  max: null,
});

/**
 * Budget used when a caller enables thinking without naming a level, which is
 * also what pi sends when the session has thinking off. Preserves the
 * pre-ladder behavior for that case exactly.
 */
const DEFAULT_BUDGET = 10_000;

/**
 * Upper bound for a configured budget. The hint is advisory, so an absurd
 * value is a configuration mistake rather than a useful request; clamping
 * keeps it from crowding out the prompt it is attached to.
 */
const MAX_BUDGET = 200_000;

/**
 * Accept only a bare positive integer. Deliberately stricter than
 * `Number.parseInt`, which would take the `4000` out of `"4000<junk>"` and
 * let the rest of a hand-edited value pass validation unnoticed.
 */
function parseBudget(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return Math.min(parsed, MAX_BUDGET);
}

/**
 * Keep only well-formed entries so a hand-edited settings override cannot put
 * junk into the prompt. Values must be positive integers in string form, or
 * `null` to mark a level unsupported. Returns undefined when nothing survives,
 * which reads to pi as "no map".
 */
export function sanitizeThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const out: ThinkingLevelMap = {};
  let kept = 0;

  for (const level of levels) {
    const entry = (value as Record<string, unknown>)[level];
    if (entry === null) {
      out[level] = null;
      kept++;
      continue;
    }
    if (parseBudget(typeof entry === "string" ? entry : undefined) !== undefined) {
      out[level] = entry as string;
      kept++;
    }
  }

  return kept > 0 ? out : undefined;
}

/**
 * Clamp a requested level to what this model actually exposes. Mirrors what
 * pi's session layer does, so a budget stays consistent even when a caller
 * passes a level the model's map marks unsupported.
 */
export function resolveThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  requested: ThinkingLevel | undefined,
): ModelThinkingLevel {
  if (!requested) return "off";
  return clampThinkingLevel(model, requested);
}

/**
 * Token budget for the `<max_thinking_length>` hint.
 *
 * Resolution order: the model's `thinkingLevelMap` entry for the clamped
 * level, then the built-in ladder, then `DEFAULT_BUDGET`.
 *
 * The budget is deliberately not clamped against `maxTokens`. The directive is
 * an advisory prompt hint rather than an output allocation, and scaling it to
 * the output ceiling would collapse several rungs onto one value on models
 * with a small `maxTokens` — leaving the UI offering levels that all behave
 * identically.
 */
export function resolveThinkingBudget<TApi extends Api>(
  model: Model<TApi>,
  requested: ThinkingLevel | undefined,
): number {
  const level = resolveThinkingLevel(model, requested);
  if (level === "off") return DEFAULT_BUDGET;
  const fromModel = parseBudget(model.thinkingLevelMap?.[level]);
  const fromDefaults = parseBudget(KIRO_THINKING_LEVEL_MAP[level]);
  return fromModel ?? fromDefaults ?? DEFAULT_BUDGET;
}
