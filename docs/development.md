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
extension.ts             Pi package entrypoint and native-provider registration
src/kiro/provider-auth.ts native API-key login, resolution, and model refresh
src/kiro/discover.ts     Kiro ListAvailableModels request and response mapping
src/kiro/stream.ts       vendored streaming implementation
test/                    Bun contract and unit tests
docs/                    user and maintainer documentation
```

## Test strategy

Tests run entirely with mocked `fetch`; they do not require a Kiro key or a
network connection. They cover the public entrypoint registration contract,
credential precedence and edge cases, regional request headers, discovery
response/model mapping, cache-only versus authoritative refresh behavior,
generation-rejected publications, and sanitized error/log-file safety. Live Kiro acceptance
is intentionally outside CI and this repository's routine verification scope.
