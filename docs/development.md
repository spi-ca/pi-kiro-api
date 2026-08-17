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
`README.md`, `docs/`, `LICENSE`, and `NOTICE`. The latter two are required for
the package's license and vendored-code attribution.

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
sanitized error/log-file safety. Live Kiro acceptance is intentionally outside
CI and this repository's routine verification scope.
