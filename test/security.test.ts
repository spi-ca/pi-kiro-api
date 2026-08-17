import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecureLogFile } from "../src/kiro/debug.ts";
import { sanitizeKiroError, sanitizeKiroStreamEventError } from "../src/kiro/errors.ts";

test("sanitized errors expose only status and a stable bounded code", () => {
  const secret = "very-secret-credential";
  const serviceMessage = "retry later";
  const safe = sanitizeKiroError(
    500,
    "Internal Server Error",
    JSON.stringify({ errorCode: "InternalFailure", message: serviceMessage, errorMessage: secret }),
  );
  expect(safe).toBe("HTTP 500 (code=InternalFailure)");
  expect(safe).not.toContain(secret);
  expect(safe).not.toContain(serviceMessage);
  expect(sanitizeKiroStreamEventError("InternalFailure", secret)).toBe("code=InternalFailure");
  expect(sanitizeKiroStreamEventError("invalid code!", serviceMessage)).toBe("code=unknown");
});

test("sanitized Kiro validation errors expose stable reason and type fragment", () => {
  const safe = sanitizeKiroError(
    400,
    "Bad Request",
    JSON.stringify({
      __type: "com.amazon.kiro.runtimeservice#ValidationException",
      reason: "REQUEST_BODY_INVALID",
      message: "Invalid tool use format: call_x|fc_secret",
    }),
  );

  expect(safe).toBe("HTTP 400 (code=ValidationException, reason=REQUEST_BODY_INVALID)");
  expect(safe).not.toContain("call_x");
  expect(safe).not.toContain("fc_secret");
});

test("file logging creates owner-only regular files and rejects symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-api-test-"));
  try {
    const logFile = join(dir, "kiro.log");
    writeSecureLogFile(logFile, "first");
    expect(readFileSync(logFile, "utf8")).toBe("first\n");
    expect(lstatSync(logFile).mode & 0o777).toBe(0o600);

    const target = join(dir, "target.log");
    const link = join(dir, "link.log");
    mkdirSync(join(dir, "nested"));
    symlinkSync(target, link);
    expect(() => writeSecureLogFile(link, "unsafe")).toThrow("regular non-symlink");

    const directory = join(dir, "directory.log");
    mkdirSync(directory);
    expect(() => writeSecureLogFile(directory, "unsafe")).toThrow("regular non-symlink");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file logging rejects FIFOs without blocking", () => {
  if (process.platform === "win32") return;

  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-api-test-"));
  try {
    const fifo = join(dir, "kiro.log");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      // No mkfifo on this platform; the guarded behavior cannot be exercised.
      return;
    }

    // Without O_NONBLOCK the open would block until a reader attaches, so the
    // elapsed-time bound is part of what is being asserted.
    const startedAt = Date.now();
    expect(() => writeSecureLogFile(fifo, "unsafe")).toThrow("regular non-symlink");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
