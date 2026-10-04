# Development

## Setup

Use the Bun version declared in `package.json`.

```bash
bun install --frozen-lockfile
```

Bun is the project's package manager and command runner. Do not use npm, Node,
or npx for development commands.

## Commands

```bash
bun run check  # TypeScript type check
bun run test   # non-network Bun tests
bun run ci     # check followed by test
bun pm pack --dry-run
```

`bun pm pack --dry-run` verifies the publish file list without creating or
publishing a release. Its output should include `extension.ts`, `src/`,
`README.md`, `CHANGELOG.md`, `docs/`, `LICENSE`, and `NOTICE`. The latter two
are required for the package's license and vendored-code attribution.

## Structure

```text
extension.ts             Pi package entrypoint: native-provider registration,
                         the `kiro-api` pi-ai compat stream, and the optional
                         `pi-blackhole:provider-streams` bridge
src/kiro/provider-auth.ts native API-key login, resolution, and model refresh
src/kiro/discover.ts     Kiro ListAvailableModels request and response mapping
src/kiro/thinking.ts     thinking-level ladder and max_thinking_length budgets
src/kiro/event-parser.ts Kiro JSON event extraction from the AWS Event Stream
                         envelope
src/kiro/stream.ts       vendored streaming implementation
test/                    Bun contract and unit tests
docs/                    user and maintainer documentation
```

All three registrations in `extension.ts` are load-bearing. The compat stream
and the blackhole bridge exist so consolidation agents running under a separate
pi-ai compat registry can still dispatch through the native provider; removing
either breaks those callers rather than the primary path.

## Test strategy

Network-facing tests mock `fetch`; the rest are pure unit tests. Nothing in the
suite requires a Kiro key or a network connection. Coverage spans the public
entrypoint registration contract, credential precedence and edge cases, regional
request headers, discovery response/model mapping, cache-only versus
authoritative refresh behavior, generation-rejected publications, event-stream
parsing with split frames and bounded buffering, tool-call failure handling, and
sanitized error/log-file safety. Transcript regressions use actual
`normalizeContext` output with initial/later sections and tool deltas, verify
tool replay and current-turn boundaries, and freeze the incoming context.
Instrumentation tests cover replacement (including falsy values), metadata
before body reads, ordered parsed events before normalization, callback
rejection, late completion/rejection, caller abort, bounded hanging hooks, and
payload mutation isolation from caller-owned schemas/arguments. Live Kiro
acceptance is intentionally outside CI and routine verification scope.

## Automatic CI compatibility matrix

Push and pull-request CI runs `bun run ci`, `bun pm pack --dry-run`, and a provider-free tarball smoke; it passes no provider credentials and does not invoke Kiro/network acceptance. The smoke installs the tarball with lifecycle scripts disabled in an isolated temporary consumer, adds exact Pi runtime peers, imports it, and invokes only a registration stub with `KIRO_API_KEY` removed and `PI_OFFLINE=1`. Each lane logs the selected Bun version and the available `cc` compiler.

| Lane | Bun | Pi development graph | Install |
| --- | --- | --- | --- |
| locked baseline | 1.3.14 (`packageManager`) | `pi-ai` and `pi-coding-agent` exact 1.0.2 lockfile graph | `bun install --frozen-lockfile` |
| older transcript compatibility | 1.4.2 | complete exact 0.87.1 runtime graph in an ephemeral install | `bun install --no-save` |

The 1.0.2 expected runtime map contains `chord`, `pi-agent-core`, `pi-ai`,
`pi-codemode`, `pi-coding-agent`, `pi-mcp`, `pi-telemetry`, and `pi-tui`, all
under `@earendil-works`. The 0.87.1 map has the same packages except codemode
and MCP, which are not runtime dependencies in that version. Neither lane has
obsolete `pi-client`/`pi-protocol` runtime dependencies. The recursive verifier
checks scoped packages, nested `node_modules`, and cyclic Bun store symlinks;
its self-test also rejects missing, unexpected, and mismatched `chord`.

Every expected package must be present at exactly the selected version.
The compatibility lane temporarily pins the entire runtime map, then restores
the manifest and verifies that neither it nor the lockfile changed. The
tarball smoke injects that same complete map and declared non-Pi peers in an
isolated consumer: it is a deterministic compatibility harness, not a
minimal-peer-install proof.

0.85.1 is no longer supported because it lacks `getCurrentSystemPrompt` and
`getCurrentTools`. 0.87.1 supplies the transcript helpers but predates the
host's `onProviderStreamEvent` callback. A private stream-options type mirrors
that optional 1.0.2 contract; there is no runtime version detection, fallback
implementation, or compatibility shim. Wildcard host peers follow Pi package
conventions, not an unrestricted support promise.

To run the helpers locally, set `PI_GRAPH_EXPECTED` to the selected lane's JSON
map in `.github/workflows/ci.yml`:

```bash
bun .github/scripts/verify-pi-graph.ts
bun .github/scripts/verify-pi-graph.ts --self-test
bun .github/scripts/package-smoke.ts --self-test
PI_OFFLINE=1 bun .github/scripts/package-smoke.ts --existing
PI_OFFLINE=1 bun .github/scripts/package-smoke.ts
```

The smoke helper isolates HOME/cache/environment and omits credentials.
Package-registry access is needed to install the smoke consumer; no Kiro
service call is made. Local migration verification used Bun 1.4.2, not the
hosted baseline's Bun 1.3.14. Hosted CI itself and live Kiro acceptance were
not run locally.
