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
/**
 * Model ids the official `command-code` CLI classifies as text-only (its
 * bundled `isKnownTextOnlyModel` denylist). Every id outside this set is
 * image-capable: the CLI's own fallback for models its bundled registry does
 * not explicitly declare is "vision capable unless known text-only", and the
 * Go catalog carries no modality column of its own.
 */
const TEXT_ONLY_MODELS = new Set([
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
]);
/** The CLI additionally ignores a trailing `-YYYYMMDD` deployment suffix when matching. */
function canonicalModelId(id) {
    return id.toLowerCase().replace(/-\d{8}$/, '');
}
/** Whether a model id accepts image input under the official CLI's classification. */
export function imageCapable(id) {
    return !TEXT_ONLY_MODELS.has(canonicalModelId(id));
}
/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262_144;
/** Whether a catalog row's `Min plan` column includes the Go plan. */
export function isGoPlan(entry) {
    return entry?.minPlan.split(/\s+/)[0] === 'Go';
}
/**
 * The listing reuses one display name across the paid and free tier of the
 * same model (`MiniMaxAI/MiniMax-M3` and `minimax/minimax-m3.1-flash:free`
 * are both "MiniMax M3.1 Flash"). Free tiers are marked by a `:free` (client
 * catalog) or `-free` id suffix, so surface that in the name to keep the two
 * apart.
 */
export function displayName(id, name) {
    const freeTier = id.endsWith(':free') || id.endsWith('-free');
    return freeTier && !/free/i.test(name) ? `${name} (free)` : name;
}
/** Plan ids served by default: Go plus GOAT (plans are ordered Go < GOAT < Pro < Max). */
export const DEFAULT_SERVED_PLANS = ['individual-go', 'individual-goat'];
const SERVED_PLANS = new Set(DEFAULT_SERVED_PLANS);
/** Whether a client-catalog `minimumPlan` is in the served plan set. */
export function isServedPlan(plan, plans = SERVED_PLANS) {
    return typeof plan === 'string' && plans.has(plan);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Parse the effort column of the official CLI model catalog
 * (`reference/models.md`). The column is a comma-separated list such as
 * `low, medium, high, xhigh, max`; a dash (`—`) means the model decides its
 * own reasoning depth (no explicit effort selectors).
 */
function parseEfforts(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === '—' || trimmed === '-')
        return undefined;
    return trimmed
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}
/** Parse `reference/models.md` rows into model id → catalog entry. */
export function parseCatalog(markdown) {
    const byId = new Map();
    // Row shape: | `id` | Name | Context | Efforts | $/1M … | Min plan | Best for |
    for (const line of markdown.split('\n')) {
        if (!line.trimStart().startsWith('|'))
            continue;
        const cells = line.split('|').map((cell) => cell.trim());
        // Only data rows quote their id, which skips header and separator rows.
        const id = cells[1]?.startsWith('`') === true ? cells[1].replace(/`/g, '') : undefined;
        const minPlan = nonEmptyString(cells[6]);
        if (id === undefined || minPlan === undefined)
            continue;
        const efforts = parseEfforts(cells[4] ?? '');
        byId.set(id, { minPlan, ...efforts === undefined ? {} : { efforts } });
    }
    return byId;
}
const DEFAULT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models';
/**
 * Official CLI catalog served from npm; `@latest` tracks new releases.
 *
 * unpkg, not jsDelivr: both serve the same file, but jsDelivr pins its
 * `@latest` resolution for hours (measured: still resolving to 1.52.0 while
 * 1.53.0 was out, whose catalog row for `deepseek/deepseek-v4.1-flash` was
 * missing — so the Go filter silently dropped it). unpkg re-resolves the
 * `@latest` redirect within a minute.
 */
const CATALOG_URL = 'https://unpkg.com/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md';
/** Per-request fetch budget for the upstream catalog endpoints. */
const FETCH_TIMEOUT_MS = 30_000;
/** Fetch the official CLI catalog: per-model plan membership and reasoning efforts. */
export async function fetchCatalog(url = CATALOG_URL, fetchImpl = fetch) {
    const response = await fetchImpl(url, {
        headers: { accept: 'text/markdown' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Command Code catalog answered HTTP ${response.status}`);
    }
    return parseCatalog(await response.text());
}
/** Fetch the live listing and keep the models the catalog puts on the Go plan. */
export async function fetchGoModels(catalog, url = DEFAULT_MODELS_URL, fetchImpl = fetch) {
    const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Command Code models endpoint answered HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error('Command Code models endpoint returned an unexpected shape');
    }
    const models = [];
    for (const raw of payload.data) {
        if (!isRecord(raw))
            continue;
        const id = nonEmptyString(raw.id);
        const entry = id === undefined ? undefined : catalog.get(id);
        if (id === undefined || !isGoPlan(entry))
            continue;
        const name = displayName(id, nonEmptyString(raw.name) ?? id.split('/').pop() ?? id);
        const contextWindow = positiveNumber(raw.context_length)
            ?? positiveNumber(raw.context_window)
            ?? FALLBACK_CONTEXT_WINDOW;
        models.push({
            id,
            name,
            contextWindow,
            imageInput: imageCapable(id),
            ...entry?.efforts === undefined ? {} : { efforts: entry.efforts },
        });
    }
    // Stable order keeps the diff against a persisted catalog deterministic.
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
}
const CLIENT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models?view=client';
/** Narrow one client-catalog row onto the adapter's model shape, or drop it. */
function clientModel(raw, plans) {
    // Hidden rows are ones the service itself keeps out of clients, and a row
    // without a served `minimumPlan` cannot be shown to belong to this tier.
    if (raw.hidden === true)
        return undefined;
    const id = nonEmptyString(raw.id);
    if (id === undefined || !isServedPlan(raw.minimumPlan, plans))
        return undefined;
    const display = isRecord(raw.display) ? raw.display : undefined;
    const label = nonEmptyString(display?.label);
    const name = displayName(id, label ?? nonEmptyString(raw.name) ?? id.split('/').pop() ?? id);
    const maxTokens = positiveNumber(raw.maxOutputTokens);
    const efforts = Array.isArray(raw.reasoningEfforts)
        ? raw.reasoningEfforts.filter((part) => typeof part === 'string' && part.length > 0)
        : [];
    const modalities = Array.isArray(raw.inputModalities) ? raw.inputModalities : undefined;
    return {
        id,
        name,
        contextWindow: positiveNumber(raw.context_length) ?? FALLBACK_CONTEXT_WINDOW,
        imageInput: modalities === undefined ? imageCapable(id) : modalities.includes('image'),
        ...maxTokens === undefined ? {} : { maxTokens },
        ...efforts.length === 0 ? {} : { efforts },
    };
}
/**
 * Fetch the client-view catalog and keep every visible model the served plans
 * include. This is the primary scan: it needs no build-time reference and
 * therefore sees a model the moment the service lists it.
 */
export async function fetchClientModels(options = {}) {
    const { plans = DEFAULT_SERVED_PLANS, url = CLIENT_MODELS_URL, fetchImpl = fetch } = options;
    const served = new Set(plans);
    const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Command Code client catalog answered HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error('Command Code client catalog returned an unexpected shape');
    }
    const models = [];
    for (const raw of payload.data) {
        if (!isRecord(raw))
            continue;
        const model = clientModel(raw, served);
        if (model !== undefined)
            models.push(model);
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
}
