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

## Automatic CI compatibility matrix

Push and pull-request CI runs `bun run ci`, `bun pm pack --dry-run`, and a provider-free tarball smoke; it passes no provider credentials and does not invoke Kiro/network acceptance. The smoke installs the tarball with lifecycle scripts disabled in an isolated temporary consumer, adds exact Pi runtime peers, imports it, and invokes only a registration stub with `KIRO_API_KEY` removed and `PI_OFFLINE=1`. Each lane logs the selected Bun version and the available `cc` compiler.

| Lane | Bun | Pi development graph | Install |
| --- | --- | --- | --- |
| locked baseline | 1.3.14 (`packageManager`) | `pi-ai` and `pi-coding-agent` exact 0.84.4 lockfile graph | `bun install --frozen-lockfile` |
| current compatibility | 1.4.2 | both declared Pi devDependencies selected exactly at 0.85.1 in an ephemeral graph | `bun install --no-save` |

Each lane's repository-install graph verifier recursively checks hoisted links and Bun `.bun` nested symlinks against the selected exact Pi stack mapping: `0.84.4` for the locked baseline and `0.85.1` for compatibility. Every package in that selected mapping must be installed at its exact version. Separately, the tarball smoke deliberately injects the complete selected exact Pi graph and declared non-Pi peers into its isolated consumer as a deterministic compatibility harness against wildcard or transitive drift; it is not a minimal-peer-install proof. The compatibility lane does not let optional `*` peers select a latest package: it temporarily selects every declared Pi development package at exact `0.85.1`, restores the manifest, and checks that neither it nor the lockfile changed. This describes hosted-CI configuration, not a locally performed reinstall or live-provider result.
