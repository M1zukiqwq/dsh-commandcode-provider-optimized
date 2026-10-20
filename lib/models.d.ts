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
    id: string;
    name: string;
    contextWindow: number;
    /** Per-request output cap, when the client catalog discloses one. */
    maxTokens?: number;
    /** Reasoning-effort ids the gateway accepts for this model, in display order. */
    efforts?: string[];
    /** Whether the model accepts image input; falls back to the CLI's text-only denylist when undisclosed. */
    imageInput: boolean;
}
/** Whether a model id accepts image input under the official CLI's classification. */
export declare function imageCapable(id: string): boolean;
/** One row of the official CLI catalog (`reference/models.md`). */
export interface CatalogEntry {
    /** Lowest plan that includes the model, verbatim (`Go and above`, `Max`, …). */
    minPlan: string;
    /** Reasoning-effort ids the gateway accepts, in catalog order; absent when the model decides. */
    efforts?: string[];
}
/** Whether a catalog row's `Min plan` column includes the Go plan. */
export declare function isGoPlan(entry: CatalogEntry | undefined): boolean;
/**
 * The listing reuses one display name across the paid and free tier of the
 * same model (`MiniMaxAI/MiniMax-M3` and `minimax/minimax-m3.1-flash:free`
 * are both "MiniMax M3.1 Flash"). Free tiers are marked by a `:free` (client
 * catalog) or `-free` id suffix, so surface that in the name to keep the two
 * apart.
 */
export declare function displayName(id: string, name: string): string;
/** Plan ids served by default: Go plus GOAT (plans are ordered Go < GOAT < Pro < Max). */
export declare const DEFAULT_SERVED_PLANS: readonly string[];
/** Whether a client-catalog `minimumPlan` is in the served plan set. */
export declare function isServedPlan(plan: unknown, plans?: ReadonlySet<string>): boolean;
/** Parse `reference/models.md` rows into model id → catalog entry. */
export declare function parseCatalog(markdown: string): Map<string, CatalogEntry>;
/** Fetch the official CLI catalog: per-model plan membership and reasoning efforts. */
export declare function fetchCatalog(url?: string, fetchImpl?: typeof fetch): Promise<Map<string, CatalogEntry>>;
/** Fetch the live listing and keep the models the catalog puts on the Go plan. */
export declare function fetchGoModels(catalog: ReadonlyMap<string, CatalogEntry>, url?: string, fetchImpl?: typeof fetch): Promise<GoModel[]>;
/** Options for {@link fetchClientModels}. */
export interface ClientCatalogOptions {
    /** Plan ids to serve; defaults to {@link DEFAULT_SERVED_PLANS}. */
    plans?: readonly string[];
    /** Override the client-view endpoint (tests). */
    url?: string;
    /** Override the fetch implementation (tests). */
    fetchImpl?: typeof fetch;
}
/**
 * Fetch the client-view catalog and keep every visible model the served plans
 * include. This is the primary scan: it needs no build-time reference and
 * therefore sees a model the moment the service lists it.
 */
export declare function fetchClientModels(options?: ClientCatalogOptions): Promise<GoModel[]>;
