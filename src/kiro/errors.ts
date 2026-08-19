const MAX_ERROR_BODY_BYTES = 4_096;
const MAX_ERROR_CODE_LENGTH = 120;

/** Read no more than `limit` bytes so error handling cannot buffer an attacker-controlled body. */
export async function readResponseTextBounded(
  response: Response,
  limit = MAX_ERROR_BODY_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) break;
      const remaining = limit - bytes;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    // Do not await cancellation here: a non-conforming or stalled body must
    // not outlive the caller's request deadline.
    void reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Accept only compact provider identifiers, never arbitrary service prose. */
function stableCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  return /^[A-Za-z0-9._:-]+$/.test(code) ? code.slice(0, MAX_ERROR_CODE_LENGTH) : undefined;
}

/**
 * Render a service-supplied identifier for a user-facing message or log line.
 *
 * Tool names and IDs come off the wire, so they can carry newlines, terminal
 * escapes, or prompt text. Anything outside the identifier shape is replaced
 * rather than echoed: a forged log line or an ANSI sequence in a console
 * message is not worth the extra specificity.
 */
export function safeIdentifier(value: unknown, fallback = "unknown"): string {
  return stableCode(value) ?? fallback;
}

function stableType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const fragment = value.includes("#") ? value.split("#").pop() : value;
  return stableCode(fragment);
}

/**
 * Expose only stable, bounded diagnostics. Do not include an arbitrary raw
 * service body: it can contain request details, account data, or HTML.
 */
export function sanitizeKiroError(status: number, _statusText: string, body: string): string {
  let code: string | undefined;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    code = stableCode(parsed.code ?? parsed.errorCode ?? parsed.type) ?? stableType(parsed.__type);
    reason = stableCode(parsed.reason);
  } catch {
    // A non-JSON body supplies no safe provider diagnostic.
  }

  const details = [code ? `code=${code}` : undefined, reason ? `reason=${reason}` : undefined]
    .filter(Boolean)
    .join(", ");
  return `HTTP ${status}${details ? ` (${details})` : ""}`;
}

/** Streaming frames expose a stable code only, never arbitrary service prose. */
export function sanitizeKiroStreamEventError(code: unknown, _message: unknown): string {
  return `code=${stableCode(code) ?? "unknown"}`;
}
