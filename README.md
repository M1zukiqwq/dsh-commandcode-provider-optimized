# dsh-commandcode-provider-optimized

Command Code API provider for dsh — optimized fork of [jiesou/dsh-commandcode-go-provider](https://github.com/jiesou/dsh-commandcode-go-provider).

[English](README.en.md)

## 背景

Command Code 的订阅分两种：

1. **Provider API**：标准 OpenAI 兼容端点，可直接接入任何 agent harness。
2. **Go / GOAT / Pro / Max Plan**：调用 Provider API 会返回 `403 upgrade_required`，只能通过 Command Code 私有的 CLI 网关 `/alpha/generate` 使用。

本插件针对第二种：通过 `/alpha/generate` 流式接入 DSH 原生 `LlmAdapter`。模型列表不写死，读取官方 CLI 同款的 client 目录视图：

```text
GET https://api.commandcode.ai/provider/v1/models?view=client
```

该视图除 `id` / `context_length` 外，直接给出：

- `minimumPlan`：模型所属的最低套餐。计划顺序 **Go < GOAT < Pro < Max**，高套餐包含低套餐。
- `hidden`：服务端对客户端隐藏的模型。
- `reasoningEfforts` / `inputModalities` / `maxOutputTokens`：推理档位、多模态能力、输出上限。

套餐归属和模型能力都来自接口本身；官方 CLI 发版时生成的 `reference/models.md` 仅作兜底。

## 相比上游的改动

- **目录来源改为 `?view=client`**：不再用 build-time `models.md` 做交集。CLI 发版前上线的新模型（如 `minimax/minimax-m3.1-flash`、`reflection/beam:free`）在上游会被静默丢弃，本 fork 上线即可见。
- **默认 Go + GOAT**：`plans` 可配置，默认 `['individual-go', 'individual-goat']`；需要 Pro / Max 时把对应 plan id 加进数组即可。
- **扫描后主动刷新 UI**：GUI 挂载时只加载一次模型目录，且仅在 `llm/adapters-updated` 时重建。上游扫描完成只写日志，启动时目录先于扫描加载会导致模型列表直到重启都不更新；本 fork 在扫描成功后重新注册路由以发出该事件，并在 15s 后再补发一次。
- **失败重试 + 定时重扫**：首次扫描失败按 15s → 5min 指数退避重试；成功后每 30 分钟重扫。
- **多模态 / effort 直接用接口字段**：不再维护 `TEXT_ONLY_MODELS` 名单（兜底路径仍保留）。
- **诊断状态文件**：每次扫描写 `~/.dsh/commandcode-go-provider-status.json`。

## 安装

从本仓库安装：

```sh
dsh plugin --profile desktop add github:M1zukiqwq/dsh-commandcode-provider-optimized
```

或在 profile 的 `package.json` 中加入依赖，并把包名放进 `dsh.profile.bundles`：

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

## 安装之后

把 API Key 写入 DSH 凭据服务（Models 页面），或直接写 `~/.dsh/.credentials.yaml`：

```sh
echo 'COMMANDCODE_API_KEY: user_xxxx' >> ~/.dsh/.credentials.yaml
```

模型无需配置。装好后在 Models 页面选择 **Command Code Go** provider 及模型。

### 配置项

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

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"COMMANDCODE_API_KEY"` | 读取 API Key 的环境变量名（或 credential ref） |
| `baseURL` | `string` | `"https://api.commandcode.ai"` | 网关 base URL，`/alpha/generate` 自动追加 |
| `plans` | `string` | `"individual-go,individual-goat"` | 逗号分隔的 client catalog 套餐 id；顺序 Go < GOAT < Pro < Max |
| `maxTokens` | `number` | `64000` | 单次请求输出 token 上限 |
| `defaultContextWindow` | `number` | `1000000` | 模型无精确 contextWindow 时的兜底值 |
| `maxRequestImageBytes` | `number` | `2097152`（2 MiB） | 单次请求允许内联的 base64 图片字节上限 |
| `accounts` | `object` | `{}` | 多账号字典：每个 key 是独立 provider 路由 |
| `http1` | `boolean` | `false` | 用 HTTP/1.1 发网关请求，避免 HTTP/2 并发被 Cloudflare 重置 |

### 多账号

`accounts` 把同一订阅的多个账号暴露成多个独立 provider（各占一项、各持各的 Key）。每个账号字段缺省时回退到顶层同名字段：

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

| 账号字段 | 类型 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `displayName` | `string` | 账号 key | 模型选择器里的显示名 |
| `apiKeyEnv` | `string` | 顶层 `apiKeyEnv` | 该账号的 credential ref |
| `baseURL` | `string` | 顶层 `baseURL` | 覆盖网关地址 |
| `maxTokens` | `number` | 顶层 `maxTokens` | 覆盖输出上限 |
| `defaultContextWindow` | `number` | 顶层 `defaultContextWindow` | 覆盖兜底容量 |
| `maxRequestImageBytes` | `number` | 顶层 `maxRequestImageBytes` | 覆盖图片字节上限 |
| `retryPolicy` | `object` | 顶层 `retryPolicy` | 覆盖重试策略 |

模型目录共享，所有账号共读一份扫描结果。

### Reasoning effort

档位来自 client catalog 的 `reasoningEfforts`，模型只暴露它真正接受的档位（`low` / `medium` / `high` / `xhigh` / `max`），并额外提供显式 `Off`。**Default** 表示不发送 `reasoning_effort`，由上游决定深度；**Off** 与 Default 的 wire 形态一致，但显式声明不推理的意图。接口未给档位的模型不显示选择器。

## 图片

`/alpha/generate` 是无状态的：网关不保存图片，也没有上传接口（官方 CLI 同样每轮内联重发历史图片）。插件按 DSH 的路由标准处理：

- 单张图片重编码到 1 MiB 以内（2048×2048 像素总预算）。
- 一轮请求内联的 base64 图片总量超过 `maxRequestImageBytes`（默认 2 MiB）时，抛出 `IMAGE_OFFLOAD_REQUIRED` 并报出需要 offload 的张数；DSH 会把最旧的图片记入 `image/offload` 并重试，之后用占位文本代替字节。
- 已 offload 的图片不再读取、编码或上传。

## 诊断

每次扫描结束写 `~/.dsh/commandcode-go-provider-status.json`：

```json
{
  "ok": true,
  "source": "client",
  "announced": "ok",
  "count": 69,
  "ids": ["..."]
}
```

- `source: "fallback"`：client 视图不可达，已回退到 `models.md`。
- `announced` 不是 `ok`：刷新事件发送失败。
- `ok: false`：带 `error` 字段。

## 兼容性

`package.json` 的 `dsh.compatibility`：DSH `>=0.2.0-rc.2 <0.3`，Node.js `^22.19.0 || >=24.0.0`，Profile `web` / `headless` / `desktop`。

在 DSH `0.2.1-rc.2`（Desktop）实测：挂载、client 目录扫描、Go + GOAT 过滤、刷新事件均通过，共 69 个模型（58 Go + 11 GOAT）。

## Credit

上游：[jiesou/dsh-commandcode-go-provider](https://github.com/jiesou/dsh-commandcode-go-provider)，移植自 [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider)。

## License

[MIT](LICENSE)
