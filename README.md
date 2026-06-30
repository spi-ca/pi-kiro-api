# pi-kiro-api

A [pi](https://pi.dev) provider that talks to Kiro using a `KIRO_API_KEY`
instead of the OAuth login flow.

It vendors the Kiro streaming core from
[pi-kiro](https://github.com/hongyilyu/pi-kiro) (MIT) and adapts it for
API-key auth, so the package has **no runtime dependencies**. pi loads the
TypeScript source directly — there's no build step.

## Install

```bash
# from npm (once published)
pi install npm:pi-kiro-api

# from git
pi install git:github.com/satiyap/pi-kiro-api

# from a local checkout
pi install /path/to/pi-kiro-api
```

Add `-l` to write to project settings instead of user settings.

## Configure

Set the API key before starting pi:

```bash
export KIRO_API_KEY="..."
```

The provider defaults to the `us-east-1` Kiro endpoint. To target another
region:

```bash
export KIRO_API_REGION="eu-central-1"
```

Optional logging:

```bash
export KIRO_LOG=debug          # error | warn | info | debug (default: warn)
export KIRO_LOG_FILE=./kiro.log  # redirect logs to a file
```

## Use

After installing and setting `KIRO_API_KEY`, list models:

```bash
pi --list-models
```

Look for the `Kiro (API Key)` provider. Model IDs use pi's dash form, for
example `claude-opus-4-8`, `claude-sonnet-4-6`, and `auto`.

## How it differs from pi-kiro

- Authenticates with `KIRO_API_KEY` (sends the `tokentype: API_KEY` header
  and the `AI_EDITOR` origin) instead of OAuth bearer tokens.
- Posts to the Kiro service root with `X-Amz-Target` rather than the
  `/generateAssistantResponse` path.
- Drops the OAuth `profileArn` (ListAvailableProfiles) pre-flight lookup,
  which API-key auth doesn't use. The old patch-based version had to
  monkeypatch `globalThis.fetch` and `console.warn` to work around that;
  this version owns the stream code, so no global patching is needed.

## Attribution

The files under `src/kiro/` are derived from pi-kiro by Hongyi Lyu, MIT
licensed. See [NOTICE](./NOTICE) for the per-file breakdown and the original
license text.

## License

MIT. See [LICENSE](./LICENSE).
