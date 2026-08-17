// Vendored from pi-kiro (MIT, Copyright (c) 2026 Hongyi Lyu) and adapted for
// API-key auth. See NOTICE.
//
// Kiro streaming orchestrator. Builds the CodeWhisperer request, enforces
// retry/timeout policies, and translates Kiro's JSON event stream into pi's
// AssistantMessageEvent protocol.
//
// API-key adaptations vs. the OAuth-based upstream:
//   - sends the `tokentype: API_KEY` header
//   - uses the `AI_EDITOR` origin (see transform.KIRO_ORIGIN)
//   - posts to the service root with X-Amz-Target (baseUrl is "…/")
//   - drops the OAuth profileArn (ListAvailableProfiles) pre-flight lookup,
//     which API-key auth neither uses nor supports

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { log, previewChunk } from "./debug.ts";
import {
  readResponseTextBounded,
  sanitizeKiroError,
  sanitizeKiroStreamEventError,
} from "./errors.ts";
import { parseKiroEvents } from "./event-parser.ts";
import type { KiroModel } from "./models.ts";
import { kiroModels, toKiroModelId } from "./models.ts";
import { ThinkingTagParser } from "./thinking-parser.ts";
import { resolveThinkingBudget, resolveThinkingLevel } from "./thinking.ts";
import { countTokens } from "./tokenizer.ts";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  extractImages,
  getContentText,
  KIRO_ORIGIN,
  ToolUseIdMapper,
  applyCachePoints,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroUserInputMessage,
  normalizeMessages,
  parseToolArgs,
  TOOL_RESULT_LIMIT,
  truncate,
} from "./transform.ts";

// ---- Retry / timeout constants -----------------------------------------

const FIRST_TOKEN_TIMEOUT_DEFAULT_MS = 90_000;
const IDLE_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 10_000;

const CAPACITY_MAX_RETRIES = 3;

/**
 * Prompt caching is opt-in: Kiro accepts `cachePoint` on this API-key path,
 * but its response stream reports no cache-hit accounting, so the only
 * available signal is a time-to-first-token comparison.
 */
function cachePointsEnabled(): boolean {
  const raw = globalThis.process?.env?.KIRO_CACHE_POINTS;
  return raw === "1" || raw?.toLowerCase() === "true";
}
const CAPACITY_BASE_DELAY_MS = 5_000;
const CAPACITY_MAX_DELAY_MS = 30_000;

const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long", "Improperly formed"];
const NON_RETRYABLE_BODY_PATTERNS = ["MONTHLY_REQUEST_COUNT"];
const CAPACITY_PATTERN = "INSUFFICIENT_MODEL_CAPACITY";

function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

function isTooBigError(status: number, body: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => body.includes(p)));
}

function isNonRetryableBodyError(body: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some((p) => body.includes(p));
}

function isCapacityError(body: string): boolean {
  return body.includes(CAPACITY_PATTERN);
}

function firstTokenTimeoutForModel(modelId: string): number {
  const m = kiroModels.find((x) => x.id === modelId) as KiroModel | undefined;
  return m?.firstTokenTimeout ?? FIRST_TOKEN_TIMEOUT_DEFAULT_MS;
}

/**
 * Placeholder surfaced to downstream UIs during the deliberation window
 * on models that hide reasoning (e.g. Claude Opus 4.7+ with
 * adaptive-thinking `display: "omitted"`). Emitted as a `thinking_delta`
 * only after the countdown elapses without any real output — fast
 * responses produce no delta at all.
 */
const HIDDEN_REASONING_PLACEHOLDER = "Reasoning hidden by provider";

/**
 * How long to wait after `thinking_start` before emitting the user-visible
 * marker delta. Shorter than a typical user's "is this hung?" threshold so
 * the marker appears exactly when the wait starts feeling palpable, but
 * long enough that fast responses never flash the marker.
 */
export const HIDDEN_REASONING_COUNTDOWN_MS = 2000;

function emitHiddenReasoningStart(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): number {
  const contentIndex = output.content.length;
  const block: ThinkingContent = {
    type: "thinking",
    thinking: "",
    redacted: true,
  };
  output.content.push(block);
  stream.push({ type: "thinking_start", contentIndex, partial: output });
  return contentIndex;
}

function emitHiddenReasoningMarker(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  contentIndex: number,
): void {
  const block = output.content[contentIndex];
  if (block && block.type === "thinking") {
    block.thinking = HIDDEN_REASONING_PLACEHOLDER;
  }
  stream.push({
    type: "thinking_delta",
    contentIndex,
    delta: HIDDEN_REASONING_PLACEHOLDER,
    partial: output,
  });
}

function closeHiddenReasoning(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  contentIndex: number,
): void {
  stream.push({
    type: "thinking_end",
    contentIndex,
    content: "",
    partial: output,
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// ---- Request body shape ------------------------------------------------

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  agentMode?: string;
}

interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

/**
 * Emit a completed tool call, or return the reason it could not be emitted.
 *
 * Returns `null` on success and a short, payload-free reason on failure. A
 * malformed tool call must not be swallowed: the model asked to act, and
 * reporting `stop` instead would tell the caller the turn finished normally.
 */
function emitToolCall(
  state: KiroToolCallState,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): string | null {
  if (!state.input.trim()) state.input = "{}";

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(state.input) as unknown;
    // Valid JSON is not enough: pi's ToolCall.arguments is a record, and
    // `null`, arrays, strings, and numbers all parse cleanly. Passing one
    // through would hand the tool-execution layer a shape it cannot use.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("tool arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch (e) {
    // The parse exception text can quote the offending input, so it stays
    // behind the unsafe-payload gate like every other raw payload.
    if (log.isUnsafeDebugPayloadEnabled()) {
      log.debug("toolcall.parse.payload", {
        toolUseId: state.toolUseId,
        name: state.name,
        input: state.input,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    const reason = `tool "${state.name}" returned unusable JSON arguments`;
    log.warn(`${reason} (${state.toolUseId})`);
    return reason;
  }

  const contentIndex = output.content.length;
  const toolCall: ToolCall = { type: "toolCall", id: state.toolUseId, name: state.name, arguments: args };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: state.input, partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
  return null;
}

// ---- Main entry --------------------------------------------------------

export function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
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
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Live index of the currently-open redacted-thinking block, if any.
    // Hoisted above the try/catch so the terminal error path can close it
    // to prevent downstream UIs from hanging on an orphan live indicator.
    let hiddenThinkingIndex: number | null = null;
    let hiddenMarkerTimer: ReturnType<typeof setTimeout> | null = null;
    let hiddenMarkerEmitted = false;
    // Assigned while consuming a response so unexpected reader failures can
    // close that attempt's live blocks before the terminal error event.
    let closeActiveAttempt: (() => void) | undefined;

    // The Pi stream protocol has one lifecycle start for the whole logical
    // request, not one for each transport retry.
    stream.push({ type: "start", partial: output });

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(
          "Kiro API key not set. Run /login kiro-api-key or set KIRO_API_KEY in your environment.",
        );
      }

      const endpoint = model.baseUrl || "https://q.us-east-1.amazonaws.com/";
      const kiroModelId = toKiroModelId(model.id);
      // pi hands a session thinking level here, or undefined when thinking is
      // off. Clamp it against the model's own ladder so a level the model
      // marks unsupported cannot pick a budget the UI never offered.
      const thinkingLevel = resolveThinkingLevel(model, options?.reasoning);
      const thinkingEnabled = !!options?.reasoning || model.reasoning;
      // Kiro models where upstream hides reasoning entirely (no `<thinking>`
      // tags in the text stream, no native reasoning event). We surface a
      // redacted ThinkingContent shim so downstream UIs can show a
      // "reasoning hidden" marker via the standard pi-ai contract.
      const reasoningHidden = !!(model as KiroModel).reasoningHidden;

      log.debug("request.init", {
        endpoint,
        model: model.id,
        kiroModelId,
        contextWindow: model.contextWindow,
        thinkingEnabled,
        thinkingLevel,
        reasoningHidden,
        reasoning: options?.reasoning,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        hasSystemPrompt: !!context.systemPrompt,
        sessionId: options?.sessionId,
      });

      let systemPrompt = context.systemPrompt ?? "";
      // Skip the `<thinking_mode>` directive when the provider hides
      // reasoning — the directive is a no-op there and costs prompt tokens.
      if (thinkingEnabled && !reasoningHidden) {
        const budget = resolveThinkingBudget(model, options?.reasoning);
        systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${
          systemPrompt ? `\n${systemPrompt}` : ""
        }`;
      }

      const conversationId = options?.sessionId ?? crypto.randomUUID();
      let retryCount = 0;

      while (retryCount <= MAX_RETRIES) {
        if (options?.signal?.aborted) throw options.signal.reason;

        const normalized = normalizeMessages(context.messages);
        const toolUseIds = new ToolUseIdMapper();
        const {
          history,
          systemPrepended,
          currentMsgStartIdx,
        } = buildHistory(normalized, kiroModelId, systemPrompt, toolUseIds);
        const useCachePoints = cachePointsEnabled();
        if (useCachePoints) applyCachePoints(history);

        const currentMessages = normalized.slice(currentMsgStartIdx);
        const firstMsg = currentMessages[0];
        let currentContent = "";
        const currentToolResults: KiroToolResult[] = [];
        let currentImages: KiroImage[] | undefined;

        if (firstMsg?.role === "assistant") {
          const am = firstMsg;
          let armContent = "";
          const armToolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
          if (Array.isArray(am.content)) {
            for (const b of am.content) {
              if (b.type === "text") {
                armContent += (b as TextContent).text;
              } else if (b.type === "toolCall") {
                const tc = b as ToolCall;
                armToolUses.push({
                  name: tc.name,
                  toolUseId: toolUseIds.map(tc.id),
                  input: parseToolArgs(tc.arguments),
                });
              }
            }
          }
          if (armContent || armToolUses.length > 0) {
            const last = history[history.length - 1];
            if (last && !last.userInputMessage && last.assistantResponseMessage) {
              last.assistantResponseMessage.content += `\n\n${armContent}`;
              if (armToolUses.length > 0) {
                last.assistantResponseMessage.toolUses = [
                  ...(last.assistantResponseMessage.toolUses ?? []),
                  ...armToolUses,
                ];
              }
            } else {
              history.push({
                assistantResponseMessage: {
                  content: armContent,
                  ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
                },
              });
            }
          }

          const toolResultImages: ImageContent[] = [];
          for (let i = 1; i < currentMessages.length; i++) {
            const m = currentMessages[i];
            if (m?.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
                status: trm.isError ? "error" : "success",
                toolUseId: toolUseIds.map(trm.toolCallId),
              });
              if (Array.isArray(trm.content)) {
                for (const c of trm.content) {
                  if (c.type === "image") toolResultImages.push(c as ImageContent);
                }
              }
            }
          }
          if (toolResultImages.length > 0) {
            const converted = convertImagesToKiro(toolResultImages);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Please proceed with the task.";
        } else if (firstMsg?.role === "toolResult") {
          const toolResultImages: ImageContent[] = [];
          for (const m of currentMessages) {
            if (m?.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
                status: trm.isError ? "error" : "success",
                toolUseId: toolUseIds.map(trm.toolCallId),
              });
              if (Array.isArray(trm.content)) {
                for (const c of trm.content) {
                  if (c.type === "image") toolResultImages.push(c as ImageContent);
                }
              }
            }
          }
          if (toolResultImages.length > 0) {
            const converted = convertImagesToKiro(toolResultImages);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = "Tool results provided.";
        } else if (firstMsg?.role === "user") {
          currentContent = typeof firstMsg.content === "string" ? firstMsg.content : getContentText(firstMsg);
          if (systemPrompt && !systemPrepended) {
            currentContent = `${systemPrompt}\n\n${currentContent}`;
          }
        }

        let uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } | undefined;
        if (currentToolResults.length > 0 || (context.tools && context.tools.length > 0)) {
          uimc = {};
          if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
          if (context.tools?.length) {
            uimc.tools = convertToolsToKiro(context.tools);
          }
        }

        if (firstMsg?.role === "user") {
          const imgs = extractImages(firstMsg);
          if (imgs.length > 0) currentImages = convertImagesToKiro(imgs);
        }

        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            agentTaskType: "vibe",
            conversationId,
            currentMessage: {
              userInputMessage: {
                content: currentContent,
                modelId: kiroModelId,
                origin: KIRO_ORIGIN,
                ...(currentImages ? { images: currentImages } : {}),
                ...(uimc ? { userInputMessageContext: uimc } : {}),
              },
            },
            ...(history.length > 0 ? { history } : {}),
          },
          agentMode: "vibe",
        };

        // -- HTTP request with capacity-retry inner loop -----------------
        // Emit the hidden-reasoning indicator before the fetch so the live
        // indicator covers the server-side deliberation window (which is
        // where the wait actually happens on reasoning models).
        if (reasoningHidden && thinkingEnabled && hiddenThinkingIndex === null) {
          hiddenThinkingIndex = emitHiddenReasoningStart(output, stream);
          hiddenMarkerEmitted = false;
          const idx = hiddenThinkingIndex;
          hiddenMarkerTimer = setTimeout(() => {
            hiddenMarkerTimer = null;
            if (hiddenThinkingIndex === idx && !hiddenMarkerEmitted) {
              emitHiddenReasoningMarker(output, stream, idx);
              hiddenMarkerEmitted = true;
            }
          }, HIDDEN_REASONING_COUNTDOWN_MS);
        }

        let response!: Response;
        let capacityRetryCount = 0;
        while (true) {
          const mid = crypto.randomUUID().replace(/-/g, "");
          const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;

          log.debug("request.send", {
            attempt: retryCount,
            capacityAttempt: capacityRetryCount,
            historyLen: history.length,
            currentContentLen: currentContent.length,
            hasImages: !!currentImages,
            toolResultCount: currentToolResults.length,
          });

          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-amz-json-1.0",
              Accept: "application/json",
              Authorization: `Bearer ${apiKey}`,
              tokentype: "API_KEY",
              "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
              "x-amzn-codewhisperer-optout": "true",
              "amz-sdk-invocation-id": crypto.randomUUID(),
              "amz-sdk-request": "attempt=1; max=1",
              "x-amzn-kiro-agent-mode": "vibe",
              "x-amz-user-agent": ua,
              "user-agent": ua,
            },
            body: JSON.stringify(request),
            // Do not forward an API key if a service endpoint redirects.
            redirect: "error",
            signal: options?.signal,
          });

          if (response.ok) break;

          const errText = await readResponseTextBounded(response).catch(() => "");
          if (log.isUnsafeDebugPayloadEnabled()) {
            log.debug("response.error.payload", { status: response.status, body: errText });
          }
          const safeError = sanitizeKiroError(response.status, response.statusText, errText);

          if (isCapacityError(errText) && capacityRetryCount < CAPACITY_MAX_RETRIES) {
            capacityRetryCount++;
            const delayMs = exponentialBackoff(
              capacityRetryCount - 1,
              CAPACITY_BASE_DELAY_MS,
              CAPACITY_MAX_DELAY_MS,
            );
            log.warn(
              `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${CAPACITY_MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, options?.signal);
            continue;
          }

          if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
            throw new Error(`Kiro API error: ${safeError}`);
          }
          if (isTooBigError(response.status, errText)) {
            throw new Error(`Kiro API error: context_length_exceeded (${safeError})`);
          }
          if (response.status === 401 || response.status === 403) {
            throw new Error(
              `Kiro API error: API key rejected (${response.status}) — run /login kiro-api-key or check KIRO_API_KEY.`,
            );
          }
          throw new Error(`Kiro API error: ${safeError}`);
        }

        if (capacityRetryCount > 0) {
          log.info(`recovered from capacity pressure after ${capacityRetryCount} retries`);
        }

        // -- Consume response stream -------------------------------------
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let totalContent = "";
        let sawContentEvent = false;
        let usageEvent: { inputTokens?: number; outputTokens?: number } | null = null;
        let receivedContextUsage = false;
        let chunkSeq = 0;
        let eventSeq = 0;

        // ThinkingTagParser is disabled for reasoningHidden models since
        // no `<thinking>` tags will ever appear in the stream.
        // This is deliberately per transport attempt. A retry may discard
        // only a completely invisible attempt; once a provider event has
        // reached the caller, its content is part of the logical response.
        let providerContentEmitted = false;
        const thinkingParser =
          thinkingEnabled && !reasoningHidden
            ? new ThinkingTagParser(output, stream, () => {
                providerContentEmitted = true;
              })
            : null;
        let textBlockIndex: number | null = null;
        let emittedToolCalls = 0;
        let sawAnyToolCalls = false;
        let currentToolCall: KiroToolCallState | null = null;
        // A tool call the model intended but whose arguments could not be
        // parsed. Recorded rather than dropped so the turn fails loudly
        // instead of reporting a normal stop with a missing action.
        let toolCallError: string | null = null;
        const flushToolCall = () => {
          if (!currentToolCall) return;
          const failure = emitToolCall(currentToolCall, output, stream);
          if (failure) {
            toolCallError ??= failure;
            // Stop reading. The turn has already failed, and any later
            // transport outcome — a reader rejection, a timeout, an overflow —
            // would otherwise replace this reason with its own and hide the
            // dropped action again.
            void reader.cancel().catch(() => {});
          } else {
            emittedToolCalls++;
            providerContentEmitted = true;
          }
          currentToolCall = null;
        };

        const cancelHiddenMarkerTimer = () => {
          if (hiddenMarkerTimer) {
            clearTimeout(hiddenMarkerTimer);
            hiddenMarkerTimer = null;
          }
        };

        const closeHiddenBreadcrumb = () => {
          cancelHiddenMarkerTimer();
          if (hiddenThinkingIndex !== null) {
            closeHiddenReasoning(output, stream, hiddenThinkingIndex);
            hiddenThinkingIndex = null;
          }
        };

        let providerBlocksClosed = false;
        const closeOpenProviderBlocks = () => {
          if (providerBlocksClosed) return;
          providerBlocksClosed = true;
          if (thinkingParser) {
            thinkingParser.finalize();
            textBlockIndex = thinkingParser.getTextBlockIndex();
          }
          if (textBlockIndex !== null) {
            const block = output.content[textBlockIndex] as TextContent | undefined;
            if (block) {
              stream.push({
                type: "text_end",
                contentIndex: textBlockIndex,
                content: block.text,
                partial: output,
              });
            }
          }
        };

        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleCancelled = false;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleCancelled = true;
            void reader.cancel().catch(() => {});
          }, IDLE_TIMEOUT_MS);
        };
        closeActiveAttempt = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          closeOpenProviderBlocks();
        };

        // "First token" means the first *parsed event*, not the first bytes
        // off the socket. Kiro wraps its JSON events in an AWS Event Stream
        // envelope, so a stalled response can deliver framing bytes that
        // contain no event. Treating those as a first token would retire the
        // first-token guard and leave the request waiting for the much longer
        // idle timeout.
        //
        // The deadline is absolute per attempt so that repeated framing-only
        // chunks cannot extend the budget by re-arming a fresh timer.
        let gotFirstToken = false;
        let firstTokenTimedOut = false;
        let streamError: string | null = null;
        const attemptStartedAt = Date.now();
        const firstTokenDeadline = attemptStartedAt + firstTokenTimeoutForModel(model.id);
        const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");
        type ReadResult = { done: boolean; value?: Uint8Array };

        while (true) {
          let readResult: ReadResult;
          if (!gotFirstToken) {
            const readPromise = reader.read() as Promise<ReadResult>;
            let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
            const remainingMs = Math.max(0, firstTokenDeadline - Date.now());
            const result = await Promise.race([
              readPromise,
              new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) => {
                firstTokenTimer = setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), remainingMs);
              }),
            ]);
            // Always clear the timer — otherwise the happy path keeps the
            // event loop alive for firstTokenTimeout ms after the stream
            // ends, which is user-visible as a hang before a short-lived
            // CLI exits.
            if (firstTokenTimer) clearTimeout(firstTokenTimer);
            if (result === FIRST_TOKEN_SENTINEL) {
              readPromise.catch(() => {});
              void reader.cancel().catch(() => {});
              firstTokenTimedOut = true;
              break;
            }
            readResult = result as ReadResult;
          } else {
            readResult = (await reader.read()) as ReadResult;
          }

          const { done, value } = readResult;
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;
          if (log.isUnsafeDebugPayloadEnabled()) {
            log.debug("stream.chunk.payload", {
              seq: chunkSeq++,
              bytes: value?.byteLength ?? 0,
              decodedLen: decoded.length,
              preview: previewChunk(decoded),
            });
          }
          const { events, remaining } = parseKiroEvents(buffer);
          buffer = remaining;
          resetIdle();

          if (!gotFirstToken && events.length > 0) {
            gotFirstToken = true;
            // Cache effectiveness has no wire accounting, so log TTFT to make
            // an opt-in comparison measurable.
            log.info("stream.firstToken", {
              ms: Date.now() - attemptStartedAt,
              cachePoints: useCachePoints,
              historyLen: history.length,
            });
          }

          if (log.isUnsafeDebugPayloadEnabled() && events.length > 0) {
            for (const ev of events) {
              log.debug("stream.event.payload", { seq: eventSeq++, event: ev });
            }
          }

          for (const event of events) {
            switch (event.type) {
              case "contextUsage": {
                const pct = event.data.contextUsagePercentage;
                output.usage.input = Math.round((pct / 100) * model.contextWindow);
                receivedContextUsage = true;
                break;
              }
              case "content": {
                // Do not drop a frame just because it repeats the previous
                // one. Identical adjacent frames are normal for list markers,
                // indentation, and repeated words, so value-based dedupe
                // silently deletes real output.
                if (event.data === "") break;
                sawContentEvent = true;
                totalContent += event.data;
                // Close the live indicator before the first real text so
                // the breadcrumb finalizes adjacent to — not overlapping —
                // the text block.
                closeHiddenBreadcrumb();
                if (thinkingParser) {
                  thinkingParser.processChunk(event.data);
                } else {
                  if (textBlockIndex === null) {
                    textBlockIndex = output.content.length;
                    output.content.push({ type: "text", text: "" });
                    providerContentEmitted = true;
                    stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                  }
                  const block = output.content[textBlockIndex] as TextContent | undefined;
                  if (block) {
                    block.text += event.data;
                    stream.push({
                      type: "text_delta",
                      contentIndex: textBlockIndex,
                      delta: event.data,
                      partial: output,
                    });
                  }
                }
                break;
              }
              case "toolUse": {
                const tc = event.data;
                // Close the live indicator before any tool-call events so
                // the breadcrumb finalizes above the tool execution.
                closeHiddenBreadcrumb();
                sawAnyToolCalls = true;
                if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                  flushToolCall();
                  currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
                }
                currentToolCall.input += tc.input || "";
                if (tc.input) totalContent += tc.input;
                if (tc.stop) flushToolCall();
                break;
              }
              case "toolUseInput": {
                if (currentToolCall) currentToolCall.input += event.data.input || "";
                if (event.data.input) totalContent += event.data.input;
                break;
              }
              case "toolUseStop": {
                if (event.data.stop) flushToolCall();
                break;
              }
              case "usage": {
                usageEvent = event.data;
                break;
              }
              case "error": {
                streamError = sanitizeKiroStreamEventError(event.data.error, event.data.message);
                void reader.cancel().catch(() => {});
                break;
              }
              case "followupPrompt": {
                // Kiro suggests a follow-up question for its own chat UI.
                // pi's AssistantMessage has no field for suggested prompts,
                // and injecting it as text would put words in the model's
                // mouth. Drop it deliberately rather than implicitly.
                break;
              }
              default: {
                // Exhaustiveness guard: a new KiroStreamEvent variant must be
                // handled or explicitly ignored above, not silently dropped.
                const unhandled: never = event;
                void unhandled;
                break;
              }
            }
            if (streamError || toolCallError) break;
          }
          if (toolCallError) break;
        }

        if (idleTimer) clearTimeout(idleTimer);

        // A malformed tool call is a property of the response, not of the
        // transport, so it is decided before any retry. Retrying would let a
        // clean second attempt report `stop` while the dropped action from the
        // first attempt goes unmentioned.
        if (toolCallError) {
          closeOpenProviderBlocks();
          throw new Error(`Kiro API error: ${toolCallError}`);
        }

        if (firstTokenTimedOut || idleCancelled || streamError) {
          if (!providerContentEmitted && retryCount < MAX_RETRIES) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
            log.warn(
              `stream ${firstTokenTimedOut ? "first-token timed out" : idleCancelled ? "idle timed out" : `error: ${streamError}`} — retrying (${retryCount}/${MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, options?.signal);
            // Synthetic hidden-reasoning UI may be discarded with an
            // otherwise invisible attempt; provider content never is.
            closeHiddenBreadcrumb();
            output.content = [];
            textBlockIndex = null;
            continue;
          }
          if (providerContentEmitted) closeOpenProviderBlocks();
          if (streamError) {
            throw new Error(
              `Kiro API stream error${providerContentEmitted ? " after provider output" : " after max retries"}: ${streamError}`,
            );
          }
          throw new Error(
            `Kiro API error: ${firstTokenTimedOut ? "first token" : "idle"} timeout${providerContentEmitted ? " after provider output" : " after max retries"}`,
          );
        }

        // Stream ended cleanly. If we saw any real output, close the
        // block now. If not, defer until we know whether we'll retry so
        // terminal-empty responses still close the block exactly once.
        const gotAnyOutput = sawContentEvent || sawAnyToolCalls;
        if (gotAnyOutput) {
          closeHiddenBreadcrumb();
        }

        flushToolCall();
        // Same finalize-and-close-text sequence as the error paths, routed
        // through the shared helper so its idempotence flag is set. Closing it
        // inline here would let a later closeActiveAttempt() emit a second
        // text_end for the same block.
        closeOpenProviderBlocks();

        // The trailing flushToolCall() above can be the first to see a
        // malformed call, so this is checked again after the pre-retry gate.
        // Not retried: the caller is told the turn failed rather than
        // receiving a `stop` that hides a dropped action.
        if (toolCallError) throw new Error(`Kiro API error: ${toolCallError}`);

        if (usageEvent?.inputTokens !== undefined) output.usage.input = usageEvent.inputTokens;
        output.usage.output = usageEvent?.outputTokens ?? countTokens(totalContent);
        output.usage.totalTokens = output.usage.input + output.usage.output;
        try {
          calculateCost(model, output.usage);
        } catch {
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }

        const textBlock =
          textBlockIndex !== null
            ? (output.content[textBlockIndex] as TextContent | undefined)
            : undefined;
        const hasText = !!textBlock && textBlock.text.length > 0;
        if (!hasText && !sawAnyToolCalls && !providerContentEmitted) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
            log.warn(`empty response — retrying (${retryCount}/${MAX_RETRIES})`);
            closeHiddenBreadcrumb();
            output.content = [];
            textBlockIndex = null;
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          log.warn(`empty response persisted after ${MAX_RETRIES} retries`);
          closeHiddenBreadcrumb();
        }

        // Stop reason classification: toolUse when tools were called; length
        // when no contextUsage event was received AND no tool calls (treated
        // as a truncation signal); stop otherwise.
        if (!receivedContextUsage && emittedToolCalls === 0) {
          output.stopReason = "length";
        } else {
          output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
        }

        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        log.debug("response.done", {
          stopReason: output.stopReason,
          emittedToolCalls,
          sawAnyToolCalls,
          usage: output.usage,
        });
        stream.end();
        return;
      }
    } catch (error) {
      // A rejecting reader bypasses the normal stream-finalization path.
      // Clear its timer and balance externally visible provider blocks before
      // exposing the terminal partial response.
      closeActiveAttempt?.();
      closeActiveAttempt = undefined;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      log.debug("response.caught", { stopReason: output.stopReason, error: output.errorMessage });
      // Close any still-open live-indicator block before the error event so
      // downstream UIs don't hang on an orphan thinking_start.
      if (hiddenMarkerTimer) {
        clearTimeout(hiddenMarkerTimer);
        hiddenMarkerTimer = null;
      }
      if (hiddenThinkingIndex !== null) {
        closeHiddenReasoning(output, stream, hiddenThinkingIndex);
        hiddenThinkingIndex = null;
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    try {
      stream.end();
    } catch {
      // ignore
    }
  });

  return stream;
}
