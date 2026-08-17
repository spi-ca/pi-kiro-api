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

### Long-context `-1m` companions

Two ID forms are in play. Kiro's wire IDs use dots (`claude-sonnet-4.6`);
Pi exposes the dashed form (`claude-sonnet-4-6`). Everything you type — `/model`
selection and `modelOverrides` keys in `models.json` — uses the **dashed Pi
form**.

Kiro accepts a derived `-1m` long-context companion even though
`ListAvailableModels` does not return it. A companion is added only when both
of these hold:

1. It appears in this provider's static catalog (`src/kiro/models.ts`), and
2. discovery confirmed its base model for the active key.

The currently derivable companions are `claude-opus-4-6-1m`,
`claude-sonnet-4-6-1m`, `claude-sonnet-4-5-1m`, and `agi-nova-beta-1m`. A `-1m`
suffix is not synthesized for arbitrary discovered models, and no other static
IDs are added — the entitlement boundary from `ListAvailableModels` is
otherwise preserved exactly.

## Thinking levels

Kiro's API has no reasoning parameter. The public Amazon Q Developer CLI
Smithy client serializes exactly these `userInputMessage` keys — `content`,
`userInputMessageContext`, `userIntent`, `origin`, `images`, `modelId`,
`cachePoint`, `clientCacheConfig` — and `ListAvailableModels` reports no
reasoning capability. Reasoning strength therefore travels as a
`<max_thinking_length>` hint prepended to the system prompt, which is advisory
rather than an enforced limit.

Reasoning-capable models carry a `thinkingLevelMap` whose values are those
token budgets:

| Level | Budget |
|-------|--------|
| `minimal` | 4000 |
| `low` | 10000 |
| `medium` | 20000 |
| `high` | 30000 |
| `xhigh` | 50000 |
| `max` | 64000 |

Pi hides `xhigh` and `max` unless a model's map defines them, so this map is
what makes those two levels selectable. A requested level is clamped to what
the model's map actually exposes.

The budget is not scaled against `maxTokens`. The directive is a prompt hint
rather than an output allocation, and scaling it would collapse several rungs
onto one value on models with a small output limit.

Two behaviors are worth knowing. Selecting `off` does not disable reasoning:
the provider still sends the directive with the 10,000-token default, because
Kiro has no way to turn reasoning off per request. And models whose reasoning
upstream hides (`reasoningHidden`, currently Claude Opus 4.8 and 4.7) skip the
directive entirely, so no level changes their behavior — they mark `xhigh` and
`max` unsupported and surface a redacted "reasoning hidden" marker instead.

To change a ladder, override it per model in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "kiro-api-key": {
      "modelOverrides": {
        "claude-sonnet-4-6": {
          "thinkingLevelMap": { "xhigh": "40000", "max": null }
        }
      }
    }
  }
}
```

A `null` hides a level; a string sets its budget. Values must be bare positive
integers in string form — Pi's `ThinkingLevelMap` type is string-valued.
Malformed entries are discarded rather than interpolated into the prompt, and a
budget is capped at 200,000 tokens.

## Usage and cost reporting

Kiro bills in credits, not per-token USD, and its stream normally reports no
token counts. The footer and `/session` therefore usually show
approximations:

| Field | Source |
|---|---|
| `usage.input` | a `usage` event's `inputTokens` when present, otherwise derived from `contextUsageEvent` percentage × context window |
| `usage.output` | a `usage` event's `outputTokens` when present, otherwise estimated at ~4 characters per token |
| `usage.cacheRead` / `cacheWrite` | always `0`; Kiro reports no cache accounting |
| `usage.cost` | always `0`; there is no token price to apply |

The parser accepts a `usage` frame carrying `inputTokens`/`outputTokens`, and
when one arrives it takes precedence over both approximations. Treat that as
an opportunistic path rather than the norm: the API-key stream has not been
observed to emit it, so in practice both values are estimates.

The real charge arrives as a `meteringEvent` credit amount, which has no
representation in pi's `Usage` type: every field there is tokens or currency,
and the footer formats `cost` with a hard-coded `$`. Reporting credits as `cost`
would render them as dollars, so cost stays `0` rather than showing a confident
wrong number. Per-model credit rates are surfaced in the model name: a
discovered model whose `rateMultiplier` is greater than `1` is displayed as
`Claude Opus 4.6 (5x credits)`. The baseline rate (`1`, or an absent
multiplier) is not annotated.

For the account-level budget, ask Kiro directly — the
`AmazonCodeWhispererService.GetUsageLimits` operation returns plan, credits
used, and the reset date. This provider does not wrap it, to avoid adding a
command to every request's prompt.

## Prompt caching (opt-in)

`KIRO_CACHE_POINTS=1` sends a `cachePoint` marker on the last completed
assistant turn in history, which is the byte-stable prefix boundary. It is off
by default.

The field is accepted on this API-key path, but it showed no measurable effect.
Repeating the same large prefix returned a byte-identical `meteringEvent` credit
charge with and without the marker. Time-to-first-token differences also stayed
within run-to-run noise, and no event variant breaks out cache tokens, so
`usage.cacheRead` stays `0` either way.

It therefore stays off by default: the flag exists so the behavior can be
re-measured if Kiro starts reporting cache accounting, not because it is known
to help.

Set `KIRO_LOG=info` to compare yourself: each attempt logs `stream.firstToken`
with `ms`, `cachePoints`, and `historyLen`.

`clientCacheConfig` is intentionally not sent. Its Smithy model carries no
documentation, so `useClientCachingOnly` semantics are unclear.

## Diagnostics and security

`KIRO_LOG=error|warn|info|debug` controls diagnostic metadata (default:
`warn`). Set `KIRO_LOG_FILE=./kiro.log` to write it to a file. Log files are
opened with the symlink-following and blocking behaviors disabled where
supported, then validated on the opened descriptor: non-regular targets and
files not owned by the current user are rejected, and the file is forced to
owner-only `0600`.

Raw stream chunks, events, service response bodies, and malformed tool-call
arguments can contain prompts or responses. They stay disabled even with
`KIRO_LOG=debug`; enable them only for short-lived local debugging with the
separately explicit `KIRO_UNSAFE_DEBUG_PAYLOADS=1`. Never use that flag or a
shared log path in production.

Sanitization covers service-reported errors from both transports:

- HTTP errors from discovery and streaming expose the status plus a bounded
  stable service code (and `reason` when present).
- Streaming `error` frames are reduced to a bounded stable code.

In both cases arbitrary service `message` and `errorMessage` prose is omitted.
Sanitization does not extend to arbitrary application logs or payloads.

- Treat `KIRO_API_KEY` as a secret. Do not commit it, put it in shell history,
  or paste it into logs or issue reports.
- Use `/login` for local interactive work. In CI, inject keys from the platform
  secret manager rather than checking in an auth file.
- Revoke or rotate a key under your organization's policy if it may be exposed.
