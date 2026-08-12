# Configuration and authentication

Install this fork with `pi install git:github.com/spi-ca/pi-kiro-api`, then
restart Pi or reload packages as appropriate for the active session.

## Interactive login

Run Pi's native login flow, then select a model in the interactive UI:

```text
/login kiro-api-key
/model
```

Pi prompts for a Kiro API key and AWS region. Login validates the pair through
Kiro model discovery and immediately makes that discovered catalog selectable.
The default region is `us-east-1`. `pi --list-models` is useful to verify a
headless/scripted installation; it does not replace `/model` for interactive
selection.

Pi stores provider credentials in its auth store (normally
`~/.pi/agent/auth.json` with owner-only permissions). The stored credential
includes the API key and its `KIRO_API_REGION`; run `/login kiro-api-key` again
to replace either value.

## Headless environments

Set environment variables before Pi starts:

```bash
export KIRO_API_KEY="ksk_xxxxxxxx"
export KIRO_API_REGION="eu-central-1" # optional
pi --list-models
```

The async extension factory performs one bounded Kiro model-discovery request
for this ambient key and validated region before native registration. A
successful request atomically installs the catalog and request allowlist, so
`pi --list-models` sees the catalog immediately. This preload cannot inspect
Pi's auth store and is only an environment-startup optimization: an invalid or
stale ambient key (including an invalid ambient region) leaves an empty
provider but does **not** prevent registration. Pi then performs native
credential resolution, where a stored credential takes precedence over the
environment and a matching persisted catalog may be restored during a
cache-only/offline refresh. `PI_OFFLINE=1` (or Pi's `--offline`) skips the
ambient network preload and still registers the provider.

`KIRO_API_REGION` must be an AWS-region-shaped value such as `us-east-1` or
`eu-central-1`. Invalid values are rejected instead of being interpolated into
an endpoint.

## Credential and region precedence

For native provider credential resolution, a stored provider credential in
`auth.json` takes precedence over `KIRO_API_KEY`. Region precedence remains:

1. `KIRO_API_REGION` saved with the stored `auth.json` credential.
2. Environment `KIRO_API_REGION`.
3. `us-east-1`.

Blank values are ignored. A key can be valid only in its issued region; a
region mismatch commonly yields an access-denied discovery error.

### `--api-key` limitation in Pi 0.84.1

Do not use Pi's `--api-key` as first-time configuration for this dynamic
provider. In Pi 0.84.1 it cannot bootstrap `ListAvailableModels` before the
provider is registered, so `--api-key` alone does not produce an initial Kiro
catalog. Use `/login kiro-api-key` (recommended) or set `KIRO_API_KEY` before
Pi starts.

A runtime `--api-key` may happen to work only when Pi already has a persisted
catalog matching that exact key and region. It is not a supported bootstrap
path and should not be relied on. If it changes from the key that scoped the
live or cached catalog, the provider intentionally clears the models rather
than exposing another key's catalog (fail closed).

## Catalog cache and refresh semantics

Kiro's remote `ListAvailableModels` response is the authority for normal
network refreshes and successful ambient environment startup. A successful
login installs its result immediately; Pi's following matching cache-only
refresh persists that already validated catalog for offline restart. Ambient
preload failure is non-fatal; final native credential resolution and cache
restoration retain stored credential precedence. The live catalog, its
model-ID dispatch map, and its request allowlist are bound atomically to a
non-secret SHA-256 digest of the effective key and region.

Pi may restore a persisted catalog during offline/cache-only refresh **only**
when that digest matches the exact effective key and region and every cached
model has the expected HTTPS regional Kiro endpoint. Once that stored catalog
also matches the live catalog, later offline refreshes reuse it without another
persistence publication. A live catalog for a different credential scope is
cleared through Pi's accepted publication before cache restoration; it never
crosses a key or region change.

For a normal network refresh in the **same** scope, the previous live catalog
and persisted cache remain available if discovery has a transient failure. No
replacement is published until discovery succeeds. A scope change is
fail-closed for live requests: mismatched live models are cleared before the
new lookup, and a failed lookup remains empty for that new scope. The old
persisted entry is not deleted preemptively, but its digest prevents it from
being reused by the new scope.

Kiro also accepts a derived `-1m` long-context companion (for example,
`claude-sonnet-4.6-1m`) when its discovered base model is available, even
though that literal companion may not be returned by `ListAvailableModels`.
No other static IDs are added.

## Diagnostics and security

`KIRO_LOG=error|warn|info|debug` controls diagnostic metadata (default:
`warn`). Set `KIRO_LOG_FILE=./kiro.log` to write it to a file. Log files are
created/forced to owner-only `0600` and symlink/non-regular targets are
rejected where supported.

Raw stream chunks, events, and service response bodies can contain prompts or
responses. They stay disabled even with `KIRO_LOG=debug`; enable them only for
short-lived local debugging with the separately explicit
`KIRO_UNSAFE_DEBUG_PAYLOADS=1`. Never use that flag or a shared log path in
production. Sanitization applies to HTTP service-response diagnostics only:
normal discovery and stream HTTP errors expose status plus a bounded stable
service code; arbitrary service message and `errorMessage` fields are omitted.
It does not sanitize arbitrary application logs or payloads.

- Treat `KIRO_API_KEY` as a secret. Do not commit it, put it in shell history,
  or paste it into logs or issue reports.
- Use `/login` for local interactive work. In CI, inject keys from the platform
  secret manager rather than checking in an auth file.
- Revoke or rotate a key under your organization's policy if it may be exposed.
