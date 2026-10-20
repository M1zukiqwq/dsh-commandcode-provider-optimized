# dsh-commandcode-provider-optimized

Command Code API provider for dsh — optimized fork of [jiesou/dsh-commandcode-go-provider](https://github.com/jiesou/dsh-commandcode-go-provider).

[简体中文](README.md)

## Background

Command Code subscriptions come in two flavors:

1. **Provider API**: standard OpenAI-compatible endpoints that plug into any agent harness directly.
2. **Go / GOAT / Pro / Max Plan**: the Provider API answers `403 upgrade_required`; these plans only work through Command Code's private CLI gateway `/alpha/generate`.

This plugin covers the second case: it streams over `/alpha/generate` through DSH's native `LlmAdapter`. Models are never hardcoded; the plugin reads the client view of the catalog, the same listing the official CLI uses:

```text
GET https://api.commandcode.ai/provider/v1/models?view=client
```

Beyond `id` / `context_length`, that view discloses:

- `minimumPlan`: the lowest plan that includes the model. Plans are ordered **Go < GOAT < Pro < Max** and higher plans include the lower tiers.
- `hidden`: models the service keeps out of clients.
- `reasoningEfforts` / `inputModalities` / `maxOutputTokens`: effort selectors, modalities, and output cap.

Plan membership and model capabilities therefore come from the API itself; the CLI's build-time `reference/models.md` is only a fallback.

## Changes from upstream

- **Catalog source is `?view=client`**: no more intersecting with the build-time `models.md`. Models shipped before the next CLI release (e.g. `minimax/minimax-m3.1-flash`, `reflection/beam:free`) were silently dropped upstream; here they appear immediately.
- **Go + GOAT by default**: configurable via `plans`, default `['individual-go', 'individual-goat']`. Add `individual-pro` / `individual-max` to serve higher tiers.
- **Refresh after scan**: the GUI loads its model catalog once on mount and rebuilds it only on `llm/adapters-updated`. Upstream just logged the finished scan, so a catalog loaded before the scan stayed stale until restart. This fork re-registers its routes to emit the event, plus one delayed re-announce 15s later.
- **Retry + periodic rescan**: failed scans retry with 15s → 5min exponential backoff; successful scans repeat every 30 minutes.
- **Modalities / efforts straight from the API**: the `TEXT_ONLY_MODELS` denylist is only used by the fallback path.
- **Diagnostic status file**: every scan writes `~/.dsh/commandcode-go-provider-status.json`.

## Install

From this repository:

```sh
dsh plugin --profile desktop add github:M1zukiqwq/dsh-commandcode-provider-optimized
```

Or add the dependency and bundle name to the profile manifest:

```json
{
  "dependencies": {
    "@m1zukiqwq/dsh-commandcode-provider-optimized": "github:M1zukiqwq/dsh-commandcode-provider-optimized"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@m1zukiqwq/dsh-commandcode-provider-optimized"
      ]
    }
  }
}
```

## After installing

Store the API key through DSH's credentials service (the web Models page), or in `~/.dsh/.credentials.yaml`:

```sh
echo 'COMMANDCODE_API_KEY: user_xxxx' >> ~/.dsh/.credentials.yaml
```

No model config is needed. Pick the **Command Code Go** provider and a model in the Models page.

### Configuration

```yaml
- id: commandcode-go-provider
  name: '@m1zukiqwq/dsh-commandcode-provider-optimized'
  config:
    apiKeyEnv: COMMANDCODE_API_KEY
    baseURL: https://api.commandcode.ai
    plans: individual-go,individual-goat
    maxTokens: 64000
    defaultContextWindow: 1000000
    maxRequestImageBytes: 2097152
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"COMMANDCODE_API_KEY"` | Credential ref (or env var name) holding the API key |
| `baseURL` | `string` | `"https://api.commandcode.ai"` | Gateway base URL; `/alpha/generate` is appended |
| `plans` | `string` | `"individual-go,individual-goat"` | Comma-separated client-catalog plan ids to serve; order Go < GOAT < Pro < Max |
| `maxTokens` | `number` | `64000` | Per-request output token cap |
| `defaultContextWindow` | `number` | `1000000` | Fallback context capacity |
| `maxRequestImageBytes` | `number` | `2097152` (2 MiB) | Inline base64 image budget for one request |
| `accounts` | `object` | `{}` | Multi-account dictionary: each key is an independent provider route |
| `http1` | `boolean` | `false` | Send gateway traffic over HTTP/1.1 (avoids HTTP/2 edge resets) |

### Multiple accounts

`accounts` exposes several accounts as independent providers (each with its own picker entry and key). Every account field falls back to the top-level field of the same name:

```yaml
- id: commandcode-go-provider
  name: '@m1zukiqwq/dsh-commandcode-provider-optimized'
  config:
    accounts:
      commandcode-1:
        displayName: Command Code Go 1
        apiKeyEnv: COMMANDCODE_API_KEY
      commandcode-2:
        displayName: Command Code Go 2
        apiKeyEnv: COMMANDCODE_API_KEY_2
    baseURL: https://api.commandcode.ai
```

| Account field | Type | Default | Description |
| --- | --- | --- | --- |
| `displayName` | `string` | account key | Label in the model picker |
| `apiKeyEnv` | `string` | top-level `apiKeyEnv` | Credential ref for this account |
| `baseURL` | `string` | top-level `baseURL` | Per-account gateway override |
| `maxTokens` | `number` | top-level `maxTokens` | Per-account output cap |
| `defaultContextWindow` | `number` | top-level `defaultContextWindow` | Per-account fallback capacity |
| `maxRequestImageBytes` | `number` | top-level `maxRequestImageBytes` | Per-account image budget |
| `retryPolicy` | `object` | top-level `retryPolicy` | Per-account retry policy |

The scanned catalog is shared by every account.

### Reasoning effort

Levels come from the client catalog's `reasoningEfforts`; a model exposes exactly the levels it accepts (`low` / `medium` / `high` / `xhigh` / `max`) plus an explicit `Off`. **Default** means "do not send `reasoning_effort`". A model without disclosed levels shows no selector.

## Images

`/alpha/generate` is stateless: no stored images and no upload endpoint (the official CLI also re-sends every historical image inline each turn). The plugin follows the DSH route standard:

- Each image is re-encoded to fit 1 MiB (under a 2048×2048 pixel budget).
- When inline base64 images exceed `maxRequestImageBytes` (default 2 MiB), the adapter throws `IMAGE_OFFLOAD_REQUIRED` naming how many occurrences to offload; DSH records the oldest ones and retries with placeholder text.
- Offloaded images are never read, encoded, or uploaded again.

## Diagnostics

Every scan writes `~/.dsh/commandcode-go-provider-status.json`:

```json
{
  "ok": true,
  "source": "client",
  "announced": "ok",
  "count": 69,
  "ids": ["..."]
}
```

- `source: "fallback"`: the client view was unreachable and `models.md` was used.
- `announced` other than `ok`: the refresh event failed to send.
- `ok: false`: carries an `error` field.

## Compatibility

Declared in `package.json` under `dsh.compatibility`: DSH `>=0.2.0-rc.2 <0.3`, Node.js `^22.19.0 || >=24.0.0`, profiles `web` / `headless` / `desktop`.

Verified on DSH `0.2.1-rc.2` (Desktop): mount, client catalog scan, Go + GOAT filtering, and the refresh event all pass, with 69 models (58 Go + 11 GOAT).

## Credit

Upstream: [jiesou/dsh-commandcode-go-provider](https://github.com/jiesou/dsh-commandcode-go-provider), a port of [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider).

## License

[MIT](LICENSE)
