/**
 * Command Code model discovery.
 *
 * The authoritative source is the client view of the model catalog
 * (`/provider/v1/models?view=client`), the same listing the official
 * `command-code` CLI reads. Besides `id` and `context_length` it discloses
 * the facts the bare Provider API withholds:
 *
 * - `minimumPlan`: the lowest plan that includes the model. Plans are ordered
 *   Go < GOAT < Pro < Max and every higher plan includes the models below it,
 *   so serving a plan means keeping every model whose `minimumPlan` is at or
 *   below it.
 * - `hidden`: models the service itself hides from clients.
 * - `reasoningEfforts` / `inputModalities`: the per-model effort selectors and
 *   whether the model accepts image input.
 *
 * The older path — the `Min plan` and effort columns of the CLI's build-time
 * `reference/models.md`, intersected with the plain listing — remains as a
 * fallback only: that reference lags every model the service ships after the
 * CLI release, which hides new models until the next CLI build.
 *
 * @module dsh-commandcode-provider-optimized/models
 */

export interface GoModel {
  id: string
  name: string
  contextWindow: number
  /** Per-request output cap, when the client catalog discloses one. */
  maxTokens?: number
  /** Reasoning-effort ids the gateway accepts for this model, in display order. */
  efforts?: string[]
  /** Whether the model accepts image input; falls back to the CLI's text-only denylist when undisclosed. */
  imageInput: boolean
}

/**
 * Model ids the official `command-code` CLI classifies as text-only (its
 * bundled `isKnownTextOnlyModel` denylist). Every id outside this set is
 * image-capable: the CLI's own fallback for models its bundled registry does
 * not explicitly declare is "vision capable unless known text-only", and the
 * Go catalog carries no modality column of its own.
 */
const TEXT_ONLY_MODELS: ReadonlySet<string> = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-fast',
  'zai-org/glm-5.3',
  'zai-org/glm-5.2',
  'zai-org/glm-5.2-fast',
  'zai-org/glm-5.1',
  'zai-org/glm-5',
  'minimaxai/minimax-m2.7',
  'minimax/minimax-m2.7-free',
  'minimaxai/minimax-m2.5',
  'xiaomi/mimo-v2.5-pro',
  'qwen/qwen3.6-max-preview',
  'qwen/qwen3.7-max',
  'stepfun/step-3.5-flash',
  'tencent/hy4-preview',
  'tencent/hy3',
  'tencent/hy3-paid',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'poolside/laguna-s-2.1-free',
  'inclusionai/ling-3.0-flash-free',
  'xai/grok-4.6',
])

/** The CLI additionally ignores a trailing `-YYYYMMDD` deployment suffix when matching. */
function canonicalModelId(id: string): string {
  return id.toLowerCase().replace(/-\d{8}$/, '')
}

/** Whether a model id accepts image input under the official CLI's classification. */
export function imageCapable(id: string): boolean {
  return !TEXT_ONLY_MODELS.has(canonicalModelId(id))
}

/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262_144

/** One row of the official CLI catalog (`reference/models.md`). */
export interface CatalogEntry {
  /** Lowest plan that includes the model, verbatim (`Go and above`, `Max`, …). */
  minPlan: string
  /** Reasoning-effort ids the gateway accepts, in catalog order; absent when the model decides. */
  efforts?: string[]
}

/** Whether a catalog row's `Min plan` column includes the Go plan. */
export function isGoPlan(entry: CatalogEntry | undefined): boolean {
  return entry?.minPlan.split(/\s+/)[0] === 'Go'
}

/**
 * The listing reuses one display name across the paid and free tier of the
 * same model (`MiniMaxAI/MiniMax-M3` and `minimax/minimax-m3.1-flash:free`
 * are both "MiniMax M3.1 Flash"). Free tiers are marked by a `:free` (client
 * catalog) or `-free` id suffix, so surface that in the name to keep the two
 * apart.
 */
export function displayName(id: string, name: string): string {
  const freeTier = id.endsWith(':free') || id.endsWith('-free')
  return freeTier && !/free/i.test(name) ? `${name} (free)` : name
}

/** Plan ids served by default: Go plus GOAT (plans are ordered Go < GOAT < Pro < Max). */
export const DEFAULT_SERVED_PLANS: readonly string[] = ['individual-go', 'individual-goat']

const SERVED_PLANS: ReadonlySet<string> = new Set(DEFAULT_SERVED_PLANS)

/** Whether a client-catalog `minimumPlan` is in the served plan set. */
export function isServedPlan(plan: unknown, plans: ReadonlySet<string> = SERVED_PLANS): boolean {
  return typeof plan === 'string' && plans.has(plan)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse the effort column of the official CLI model catalog
 * (`reference/models.md`). The column is a comma-separated list such as
 * `low, medium, high, xhigh, max`; a dash (`—`) means the model decides its
 * own reasoning depth (no explicit effort selectors).
 */
function parseEfforts(raw: string): string[] | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === '—' || trimmed === '-') return undefined
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Parse `reference/models.md` rows into model id → catalog entry. */
export function parseCatalog(markdown: string): Map<string, CatalogEntry> {
  const byId = new Map<string, CatalogEntry>()
  // Row shape: | `id` | Name | Context | Efforts | $/1M … | Min plan | Best for |
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    // Only data rows quote their id, which skips header and separator rows.
    const id = cells[1]?.startsWith('`') === true ? cells[1].replace(/`/g, '') : undefined
    const minPlan = nonEmptyString(cells[6])
    if (id === undefined || minPlan === undefined) continue
    const efforts = parseEfforts(cells[4] ?? '')
    byId.set(id, { minPlan, ...efforts === undefined ? {} : { efforts } })
  }
  return byId
}

const DEFAULT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models'
/**
 * Official CLI catalog served from npm; `@latest` tracks new releases.
 *
 * unpkg, not jsDelivr: both serve the same file, but jsDelivr pins its
 * `@latest` resolution for hours (measured: still resolving to 1.52.0 while
 * 1.53.0 was out, whose catalog row for `deepseek/deepseek-v4.1-flash` was
 * missing — so the Go filter silently dropped it). unpkg re-resolves the
 * `@latest` redirect within a minute.
 */
const CATALOG_URL = 'https://unpkg.com/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md'
/** Per-request fetch budget for the upstream catalog endpoints. */
const FETCH_TIMEOUT_MS = 30_000

/** Fetch the official CLI catalog: per-model plan membership and reasoning efforts. */
export async function fetchCatalog(
  url: string = CATALOG_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, CatalogEntry>> {
  const response = await fetchImpl(url, {
    headers: { accept: 'text/markdown' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Command Code catalog answered HTTP ${response.status}`)
  }
  return parseCatalog(await response.text())
}

/** Fetch the live listing and keep the models the catalog puts on the Go plan. */
export async function fetchGoModels(
  catalog: ReadonlyMap<string, CatalogEntry>,
  url: string = DEFAULT_MODELS_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<GoModel[]> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Command Code models endpoint answered HTTP ${response.status}`)
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('Command Code models endpoint returned an unexpected shape')
  }
  const models: GoModel[] = []
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue
    const id = nonEmptyString(raw.id)
    const entry = id === undefined ? undefined : catalog.get(id)
    if (id === undefined || !isGoPlan(entry)) continue
    const name = displayName(id, nonEmptyString(raw.name) ?? id.split('/').pop() ?? id)
    const contextWindow = positiveNumber(raw.context_length)
      ?? positiveNumber(raw.context_window)
      ?? FALLBACK_CONTEXT_WINDOW
    models.push({
      id,
      name,
      contextWindow,
      imageInput: imageCapable(id),
      ...entry?.efforts === undefined ? {} : { efforts: entry.efforts },
    })
  }
  // Stable order keeps the diff against a persisted catalog deterministic.
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}

const CLIENT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models?view=client'

/** Narrow one client-catalog row onto the adapter's model shape, or drop it. */
function clientModel(raw: Record<string, unknown>, plans: ReadonlySet<string>): GoModel | undefined {
  // Hidden rows are ones the service itself keeps out of clients, and a row
  // without a served `minimumPlan` cannot be shown to belong to this tier.
  if (raw.hidden === true) return undefined
  const id = nonEmptyString(raw.id)
  if (id === undefined || !isServedPlan(raw.minimumPlan, plans)) return undefined
  const display = isRecord(raw.display) ? raw.display : undefined
  const label = nonEmptyString(display?.label)
  const name = displayName(id, label ?? nonEmptyString(raw.name) ?? id.split('/').pop() ?? id)
  const maxTokens = positiveNumber(raw.maxOutputTokens)
  const efforts = Array.isArray(raw.reasoningEfforts)
    ? raw.reasoningEfforts.filter((part): part is string => typeof part === 'string' && part.length > 0)
    : []
  const modalities = Array.isArray(raw.inputModalities) ? raw.inputModalities : undefined
  return {
    id,
    name,
    contextWindow: positiveNumber(raw.context_length) ?? FALLBACK_CONTEXT_WINDOW,
    imageInput: modalities === undefined ? imageCapable(id) : modalities.includes('image'),
    ...maxTokens === undefined ? {} : { maxTokens },
    ...efforts.length === 0 ? {} : { efforts },
  }
}

/** Options for {@link fetchClientModels}. */
export interface ClientCatalogOptions {
  /** Plan ids to serve; defaults to {@link DEFAULT_SERVED_PLANS}. */
  plans?: readonly string[]
  /** Override the client-view endpoint (tests). */
  url?: string
  /** Override the fetch implementation (tests). */
  fetchImpl?: typeof fetch
}

/**
 * Fetch the client-view catalog and keep every visible model the served plans
 * include. This is the primary scan: it needs no build-time reference and
 * therefore sees a model the moment the service lists it.
 */
export async function fetchClientModels(options: ClientCatalogOptions = {}): Promise<GoModel[]> {
  const { plans = DEFAULT_SERVED_PLANS, url = CLIENT_MODELS_URL, fetchImpl = fetch } = options
  const served = new Set(plans)
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Command Code client catalog answered HTTP ${response.status}`)
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('Command Code client catalog returned an unexpected shape')
  }
  const models: GoModel[] = []
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue
    const model = clientModel(raw, served)
    if (model !== undefined) models.push(model)
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}
