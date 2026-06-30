# pi-kiro-api

A [pi](https://pi.dev) provider that talks to Kiro using a `KIRO_API_KEY`
instead of the interactive OAuth login flow.

It vendors the Kiro streaming core from
[pi-kiro](https://github.com/hongyilyu/pi-kiro) (MIT) and adapts it for
API-key auth. pi loads the TypeScript source directly, so there's no build
step.

## Dependencies

None at runtime. The package ships only its own TypeScript source.

- No `dependencies`. Installing this package pulls nothing.
- `@earendil-works/pi-ai` is a `peerDependency` (`*`). pi bundles it and
  supplies it to the extension at load time as a virtual module, so it is
  never installed.
- The streaming code under `src/kiro/` is vendored from pi-kiro rather than
  imported, which is why there's no `pi-kiro` dependency either.

`devDependencies` (`@earendil-works/pi-ai`, `typescript`, `jiti`,
`@types/node`) are only for local typechecking and never reach users.

## What is `KIRO_API_KEY`?

`KIRO_API_KEY` is a long-lived Kiro credential (prefixed `ksk_`) used for
headless, non-interactive auth. Setting it lets pi reach Kiro without the
browser-based `kiro-cli login` flow.

API keys are available to Kiro Pro, Pro+, Pro Max, and Power subscribers. If
your subscription is managed by an admin, they may need to enable API key
generation first.

### Generate a key

1. Sign in to [app.kiro.dev](https://app.kiro.dev) with your Kiro account.
2. Open the API Keys section.
3. Create a key and copy it. The full value is shown only at creation time.

See the Kiro docs for details:
[Authenticate with an API key](https://kiro.dev/docs/cli/authentication/#authenticate-with-an-api-key-headless-mode).

Keys are long-lived secrets. Store them securely, keep them out of source
control, and rotate or revoke them per your org's policy.

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

Set the API key in your shell before starting pi:

```bash
export KIRO_API_KEY="ksk_xxxxxxxx"
```

To persist it, add that line to your shell profile (`~/.zshrc`,
`~/.bashrc`, etc.). For CI, set it as a secret environment variable rather
than committing it.

The provider defaults to the `us-east-1` Kiro endpoint. To target another
region:

```bash
export KIRO_API_REGION="eu-central-1"
```

Optional logging:

```bash
export KIRO_LOG=debug            # error | warn | info | debug (default: warn)
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
  which API-key auth doesn't use. The earlier patch-based version had to
  monkeypatch `globalThis.fetch` and `console.warn` to work around that;
  this version owns the stream code, so no global patching is needed.

## Attribution

The files under `src/kiro/` are derived from pi-kiro by Hongyi Lyu, MIT
licensed. See [NOTICE](./NOTICE) for the per-file breakdown and the original
license text.

## License

MIT. See [LICENSE](./LICENSE).
