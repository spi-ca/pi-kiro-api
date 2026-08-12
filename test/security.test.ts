import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
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

test("file logging creates owner-only regular files and rejects symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-api-test-"));
  const logFile = join(dir, "kiro.log");
  writeSecureLogFile(logFile, "first");
  expect(readFileSync(logFile, "utf8")).toBe("first\n");
  expect(lstatSync(logFile).mode & 0o777).toBe(0o600);

  const target = join(dir, "target.log");
  const link = join(dir, "link.log");
  mkdirSync(join(dir, "nested"));
  symlinkSync(target, link);
  expect(() => writeSecureLogFile(link, "unsafe")).toThrow("regular non-symlink");
});
