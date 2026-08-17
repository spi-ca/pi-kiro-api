# pi-kiro-api

A [Pi](https://pi.dev) native provider for Kiro API keys, built against Pi
**0.84.1+**, and verified against 0.84.2. It uses provider-owned
authentication and Kiro's
`ListAvailableModels` catalog for the active key and AWS region. The streaming
implementation under `src/kiro/` is vendored from
[pi-kiro](https://github.com/hongyilyu/pi-kiro) (MIT).

## Install

The supported distributable path is this Git fork:

```bash
pi install git:github.com/spi-ca/pi-kiro-api
# or, for development
pi install /path/to/pi-kiro-api
```

Add `-l` to install into the current project's Pi settings. This fork is not
advertised as an npm installation.

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

As of Pi 0.84.2, `--api-key` alone cannot bootstrap this dynamic provider's
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

## Attribution and license

See [NOTICE](./NOTICE) for the vendored-code attribution. This project is
licensed under [MIT](./LICENSE).
