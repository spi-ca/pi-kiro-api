// Vendored from pi-kiro (MIT, Copyright (c) 2026 Hongyi Lyu) and extended for
// API-key auth. See NOTICE.

import type { Model } from "@earendil-works/pi-ai";

// Kiro model catalog + ID conversion + region mapping.

/** Convert pi's dash form to Kiro's dot form (e.g. 4-6 → 4.6).
 *
 * Authorization deliberately does not live here. Each provider instance owns
 * an atomically published discovered allowlist so one instance cannot change
 * another instance's request permissions.
 */
export function toKiroModelId(modelId: string): string {
  return modelId.replace(/(\d)-(\d)/g, "$1.$2");
}

/** Default Kiro API-key endpoint (service root, not the OAuth path). */
const BASE_URL = "https://q.us-east-1.amazonaws.com/";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Fields every Kiro model shares. Spread into each literal below. */
const KIRO_DEFAULTS = {
  api: "kiro-api" as const,
  provider: "kiro-api-key" as const,
  baseUrl: BASE_URL,
  cost: ZERO_COST,
} as const;

type Input = ("text" | "image")[];
const MULTIMODAL: Input = ["text", "image"];
const TEXT_ONLY: Input = ["text"];

export type KiroModel = Model<"kiro-api"> & {
  /** Optional per-model override for the first-token timeout (ms). */
  firstTokenTimeout?: number;
  /**
   * Upstream hides reasoning from clients — no `<thinking>` tags, no native
   * reasoning event. We emit a redacted ThinkingContent shim so downstream
   * UIs can surface a "reasoning hidden" marker. Also disables the
   * `<thinking_mode>` system-prompt directive, which the provider ignores.
   */
  reasoningHidden?: boolean;
};

export const kiroModels: KiroModel[] = [
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    reasoningHidden: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    firstTokenTimeout: 180_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    reasoningHidden: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    firstTokenTimeout: 180_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6-1m",
    name: "Claude Opus 4.6 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6-1m",
    name: "Claude Sonnet 4.6 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5-1m",
    name: "Claude Sonnet 4.5 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "deepseek-3-2",
    name: "DeepSeek 3.2",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "kimi-k2-5",
    name: "Kimi K2.5",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-5",
    name: "MiniMax M2.5",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-1",
    name: "MiniMax M2.1",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-4-7",
    name: "GLM 4.7",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-4-7-flash",
    name: "GLM 4.7 Flash",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 256_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "qwen3-coder-480b",
    name: "Qwen3 Coder 480B",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "agi-nova-beta-1m",
    name: "AGI Nova Beta (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "auto",
    name: "Auto",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
];
