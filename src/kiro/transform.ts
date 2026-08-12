// Vendored from pi-kiro (MIT, Copyright (c) 2026 Hongyi Lyu). See NOTICE.
//
// pi Message[] → Kiro history transformation.
//
// Kiro uses an alternating userInputMessage/assistantResponseMessage shape.
// We merge consecutive user messages (and tool-result entries) into the
// preceding user message to satisfy alternation without synthetic padding —
// the padding used to cause echo-loop bugs downstream.

import type {
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

/** Drop assistant messages that ended in error/aborted — partial turns
 *  shouldn't be replayed. */
export function normalizeMessages(messages: Message[]): Message[] {
  return messages.filter(
    (msg) =>
      msg.role !== "assistant" ||
      (msg.stopReason !== "error" && msg.stopReason !== "aborted"),
  );
}

// ---- Kiro wire format --------------------------------------------------

export interface KiroImage {
  format: string;
  source: { bytes: string };
}

export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}

export interface KiroToolSpec {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: string;
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}

export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}

export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

// ---- Utilities ---------------------------------------------------------

export const TOOL_RESULT_LIMIT = 250_000;
const KIRO_TOOL_USE_ID_MAX_LENGTH = 64;
const KIRO_TOOL_USE_ID_SAFE_CHARS = /[^a-zA-Z0-9_-]/g;

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function boundedToolUseId(base: string, suffix?: string): string {
  const safeBase = base.replace(KIRO_TOOL_USE_ID_SAFE_CHARS, "_") || "tool";
  const safeSuffix = suffix ? `_${suffix.replace(KIRO_TOOL_USE_ID_SAFE_CHARS, "_")}` : "";
  const maxBaseLength = KIRO_TOOL_USE_ID_MAX_LENGTH - safeSuffix.length;
  return `${safeBase.slice(0, Math.max(1, maxBaseLength))}${safeSuffix}`;
}

export class ToolUseIdMapper {
  private readonly byOriginal = new Map<string, string>();
  private readonly owners = new Map<string, string>();

  map(id: string): string {
    const existing = this.byOriginal.get(id);
    if (existing) return existing;

    const sanitized = id.replace(KIRO_TOOL_USE_ID_SAFE_CHARS, "_") || "tool";
    let candidate = sanitized.length <= KIRO_TOOL_USE_ID_MAX_LENGTH
      ? sanitized
      : boundedToolUseId(sanitized, stableHash(id));

    let collision = 0;
    while (this.owners.has(candidate) && this.owners.get(candidate) !== id) {
      collision++;
      candidate = boundedToolUseId(sanitized, `${stableHash(id)}_${collision}`);
    }

    this.byOriginal.set(id, candidate);
    this.owners.set(candidate, id);
    return candidate;
  }
}

/**
 * Origin tag sent on every userInputMessage. Kiro API-key auth requires the
 * `AI_EDITOR` origin; the OAuth-based CLI uses `KIRO_CLI`.
 */
export const KIRO_ORIGIN = "AI_EDITOR";

/** Middle-ellipsis truncation: preserve start and end. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

export function extractImages(msg: Message): ImageContent[] {
  if (msg.role === "toolResult" || typeof msg.content === "string") return [];
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function getContentText(msg: Message): string {
  if (msg.role === "toolResult") {
    return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((c) => {
      if (c.type === "text") return (c as TextContent).text;
      // Thinking blocks are provider-internal reasoning artifacts. Replaying
      // them into Kiro history can make cross-provider handoff requests
      // malformed, especially when the previous provider stored signatures or
      // UI-formatted hidden reasoning text. Preserve only user-visible text.
      return "";
    })
    .join("");
}

/**
 * Parse tool-call arguments defensively. Historical messages (including
 * those from other providers via cross-provider handoff) may carry args
 * that aren't valid JSON. Fall back to {} rather than crashing the stream.
 */
export function parseToolArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") return input as Record<string, unknown>;
  if (typeof input !== "string") return {};
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters as Record<string, unknown> },
    },
  }));
}

export function convertImagesToKiro(
  images: Array<{ mimeType: string; data: string }>,
): KiroImage[] {
  return images.map((img) => ({
    format: img.mimeType.split("/")[1] || "png",
    source: { bytes: img.data },
  }));
}

// ---- History builder ---------------------------------------------------

/**
 * Split messages into history + current turn. The current turn is the trailing
 * user message (+ any following tool results) or the trailing assistant
 * message when it carries tool calls. Everything before goes into history.
 *
 * System prompt is prepended to the first user message in history, not sent
 * as a separate field (Kiro doesn't have one).
 */
export function buildHistory(
  messages: Message[],
  modelId: string,
  systemPrompt?: string,
  toolUseIds = new ToolUseIdMapper(),
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;

  // Walk backwards to find where the "current turn" begins.
  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx]?.role === "toolResult") {
    currentMsgStartIdx--;
  }
  const anchor = messages[currentMsgStartIdx];
  if (anchor?.role === "assistant") {
    const hasToolCall =
      Array.isArray(anchor.content) && anchor.content.some((b) => b.type === "toolCall");
    if (!hasToolCall) currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    if (!msg) continue;

    if (msg.role === "user") {
      let content = typeof msg.content === "string" ? msg.content : getContentText(msg);
      if (systemPrompt && !systemPrepended) {
        content = `${systemPrompt}\n\n${content}`;
        systemPrepended = true;
      }
      const images = extractImages(msg);
      const uim: KiroUserInputMessage = {
        content,
        modelId,
        origin: KIRO_ORIGIN,
        ...(images.length > 0 ? { images: convertImagesToKiro(images) } : {}),
      };

      const prev = history[history.length - 1];
      if (prev?.userInputMessage) {
        // Merge into previous user message — Kiro alternates user/assistant.
        prev.userInputMessage.content += `\n\n${uim.content}`;
        if (uim.images) {
          prev.userInputMessage.images = [...(prev.userInputMessage.images ?? []), ...uim.images];
        }
      } else {
        history.push({ userInputMessage: uim });
      }
      continue;
    }

    if (msg.role === "assistant") {
      let armContent = "";
      const armToolUses: KiroToolUse[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            armContent += (block as TextContent).text;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            armToolUses.push({
              name: tc.name,
              toolUseId: toolUseIds.map(tc.id),
              input: parseToolArgs(tc.arguments),
            });
          }
        }
      }
      if (!armContent && armToolUses.length === 0) continue;
      const prevEntry = history[history.length - 1];
      if (prevEntry?.assistantResponseMessage) {
        // Kiro strictly alternates user/assistant. Consecutive assistant turns
        // (for example, a text-only reply followed by a tool-calling reply)
        // must merge instead of emitting two assistant entries in a row.
        const prevMessage = prevEntry.assistantResponseMessage;
        prevMessage.content = prevMessage.content && armContent
          ? `${prevMessage.content}\n\n${armContent}`
          : prevMessage.content || armContent;
        if (armToolUses.length > 0) {
          prevMessage.toolUses = [...(prevMessage.toolUses ?? []), ...armToolUses];
        }
        continue;
      }
      history.push({
        assistantResponseMessage: {
          content: armContent,
          ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
        },
      });
      continue;
    }

    // toolResult — batch consecutive results
    const trMsg = msg as ToolResultMessage;
    const toolResults: KiroToolResult[] = [
      {
        content: [{ text: truncate(getContentText(msg), TOOL_RESULT_LIMIT) }],
        status: trMsg.isError ? "error" : "success",
        toolUseId: toolUseIds.map(trMsg.toolCallId),
      },
    ];
    const trImages: ImageContent[] = [];
    if (Array.isArray(trMsg.content)) {
      for (const c of trMsg.content) if (c.type === "image") trImages.push(c as ImageContent);
    }

    let j = i + 1;
    while (j < historyMessages.length && historyMessages[j]?.role === "toolResult") {
      const next = historyMessages[j] as ToolResultMessage;
      toolResults.push({
        content: [{ text: truncate(getContentText(next), TOOL_RESULT_LIMIT) }],
        status: next.isError ? "error" : "success",
        toolUseId: toolUseIds.map(next.toolCallId),
      });
      if (Array.isArray(next.content)) {
        for (const c of next.content) if (c.type === "image") trImages.push(c as ImageContent);
      }
      j++;
    }
    i = j - 1;

    const prev = history[history.length - 1];
    if (prev?.userInputMessage) {
      // Merge tool results into previous user message to preserve alternation.
      prev.userInputMessage.content += "\n\nTool results provided.";
      if (trImages.length > 0) {
        prev.userInputMessage.images = [
          ...(prev.userInputMessage.images ?? []),
          ...convertImagesToKiro(trImages),
        ];
      }
      if (!prev.userInputMessage.userInputMessageContext) {
        prev.userInputMessage.userInputMessageContext = {};
      }
      prev.userInputMessage.userInputMessageContext.toolResults = [
        ...(prev.userInputMessage.userInputMessageContext.toolResults ?? []),
        ...toolResults,
      ];
    } else {
      history.push({
        userInputMessage: {
          content: "Tool results provided.",
          modelId,
          origin: KIRO_ORIGIN,
          ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages) } : {}),
          userInputMessageContext: { toolResults },
        },
      });
    }
  }

  closeUnansweredToolUses(history, modelId);

  return { history, systemPrepended, currentMsgStartIdx };
}

/**
 * Kiro rejects a history whose `toolUses` have no matching `toolResults`.
 * A session can end an assistant turn with tool calls that were aborted,
 * errored, or truncated before their results were recorded, so close those
 * with explicit synthetic results instead of sending an unpaired tool use.
 */
function closeUnansweredToolUses(history: KiroHistoryEntry[], modelId: string): void {
  const answered = new Set<string>();
  for (const entry of history) {
    for (const result of entry.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
      answered.add(result.toolUseId);
    }
  }

  for (let i = 0; i < history.length; i++) {
    const uses = history[i]?.assistantResponseMessage?.toolUses;
    if (!uses?.length) continue;
    const missing = uses.filter((use) => !answered.has(use.toolUseId));
    if (missing.length === 0) continue;

    const synthetic: KiroToolResult[] = missing.map((use) => {
      answered.add(use.toolUseId);
      return {
        content: [{ text: "Tool result unavailable." }],
        status: "error",
        toolUseId: use.toolUseId,
      };
    });

    const next = history[i + 1];
    if (next?.userInputMessage) {
      if (!next.userInputMessage.userInputMessageContext) {
        next.userInputMessage.userInputMessageContext = {};
      }
      next.userInputMessage.userInputMessageContext.toolResults = [
        ...synthetic,
        ...(next.userInputMessage.userInputMessageContext.toolResults ?? []),
      ];
      continue;
    }

    history.splice(i + 1, 0, {
      userInputMessage: {
        content: "Tool results provided.",
        modelId,
        origin: KIRO_ORIGIN,
        userInputMessageContext: { toolResults: synthetic },
      },
    });
    i++;
  }
}
