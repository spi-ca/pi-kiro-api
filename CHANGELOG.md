# Changelog

## v20261009-1

- Updated the Pi development dependencies, lockfile, and current CI graph to exact `1.1.0`; provider authentication and transcript contracts are unchanged.

## v20261004-1

- Synchronize exact Pi host development dependencies, lockfile, and baseline CI graph to `1.0.2`; provider dispatch, authentication, and transcript contracts are unchanged.

## v20261001-1

- Target Pi 0.99.2 with exact host development dependencies and a synchronized
  lockfile; retain wildcard host peers without bundling runtime dependencies.
- Replay normalized transcript system sections and tool additions/removals;
  collapse Kiro's single leading prompt before indexing history/current turns.
  Preserve shorthand `streamKiro` inputs and leave caller transcripts unchanged.
- Honor payload replacement, response metadata, and parsed-event observation
  callbacks with caller cancellation and existing first-event/idle deadlines.
  Use Pi's JSON tool-argument and pending-message types.
- Check the complete 0.99.2 runtime graph (including chord, codemode, and MCP),
  with no obsolete client/protocol runtime dependencies. Replace the 0.85.1
  compatibility lane with tested transcript-capable 0.87.1; that older host
  does not supply parsed-event instrumentation. No runtime compatibility shim.
- Add mocked transcript, tool replay, callback ordering/failure, and deadline
  regressions. Live Kiro acceptance is not part of these checks.

The streaming core remains derived from Hongyi Lyu's MIT-licensed pi-kiro.
Original attribution and license text are preserved in [NOTICE](./NOTICE)
and source headers.
