# pi-kiro-api

A [Pi](https://pi.dev) native provider for Kiro API keys, targeting
Pi **1.1.0**, with an older transcript compatibility lane at
**0.87.1**. It uses provider-owned
authentication and Kiro's
`ListAvailableModels` catalog for the active key and AWS region. The streaming
implementation under `src/kiro/` is vendored from
[pi-kiro](https://github.com/hongyilyu/pi-kiro) (MIT).

## Install

The supported distributable path is this Git fork:

```bash
pi install git:github.com/spi-ca/pi-kiro-api@v20261001-1
# or, for local development
pi install /path/to/pi-kiro-api
```

Add `-l` to install into the current project's Pi settings. npm installation
is not supported.

## Quick start

In an interactive Pi session, authenticate and then choose the discovered
model:

```text
/login kiro-api-key
/model
```

`pi --list-models` is a verification command for scripted/headless setup; it
is not the interactive model-selection flow.

```bash
export KIRO_API_KEY="ksk_xxxxxxxx"
export KIRO_API_REGION="eu-central-1" # optional; defaults to us-east-1
pi --list-models
```

With `KIRO_API_KEY`, startup performs one bounded `ListAvailableModels`
validation before registering the provider, so `pi --list-models` receives the
validated catalog. If ambient discovery fails, Pi still registers an empty
provider and then performs native credential resolution; a stored `auth.json`
credential retains precedence over the environment. Set `PI_OFFLINE=1` (or use
Pi's `--offline`) to skip that ambient network preload while still registering
the provider.

`--api-key` alone is not a supported bootstrap path for this dynamic provider's
initial `ListAvailableModels` catalog. Use `/login kiro-api-key` (recommended)
or set `KIRO_API_KEY` before Pi starts. A changed `--api-key` also fails closed
by clearing a catalog scoped to a different key; an already matching cache may
work, but is not guaranteed.

Kiro API keys are long-lived secrets: keep them out of source control and pass
CI values through a secret manager.

## Documentation

- [Configuration and authentication](./docs/configuration.md) — `/login`,
  credential/region precedence, headless behavior, catalog cache semantics,
  thinking-level budgets, and diagnostic safety.
- [Development](./docs/development.md) — Bun setup, checks, packaging, and the
  non-network test strategy.
- [Documentation index](./docs/README.md)
- [Changelog](./CHANGELOG.md)

Pi 0.99.2 prompt sections and tool updates are replayed from the normalized
transcript. Kiro accepts only one leading prompt, so later system updates are
collapsed into that prompt before history and current-turn conversion. The
provider honors payload replacement, response metadata, and parsed-stream
observation hooks with cancellation and existing deadlines. Pi 0.87.1 does not
supply the parsed-event observation hook; 0.85.1 is no longer a supported lane
because it lacks the required transcript replay helpers. Wildcard host peers
are Pi's packaging convention, not a claim that every Pi version is supported.

## Attribution and license

See [NOTICE](./NOTICE) for the vendored-code attribution. This project is
licensed under [MIT](./LICENSE).
