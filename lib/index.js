/**
 * dsh-commandcode-go-provider — Command Code Go provider for the dsh harness.
 *
 * A Go-plan subscription has no Provider-API access: the OpenAI-compatible
 * endpoints (`/provider/v1/chat/completions`) answer 403 `upgrade_required`,
 * so every request must go through Command Code's private CLI gateway at
 * `/alpha/generate`. This plugin:
 *
 * 1. Reads the client view of the model catalog
 *    (`/provider/v1/models?view=client`, the same listing the official CLI
 *    reads) and keeps every visible model the configured plans (default Go and
 *    GOAT) include, taking reasoning efforts and input modalities from the same
 *    rows. The CLI's build-time `reference/models.md` is only a fallback, and
 *    the catalog is re-scanned on an interval, so a newly shipped model appears
 *    without a restart.
 * 2. Registers one configurable provider route per configured account (the
 *    `accounts` dictionary; a single default account when it is absent) whose
 *    adapter streams over `/alpha/generate`, so the harness model picker,
 *    tools, and reasoning-effort controls all work against the Go catalog —
 *    once per account, sharing one scanned catalog.
 * 3. Resolves each account's bearer key per request through the credential
 *    seam (default `COMMANDCODE_API_KEY`), failing loud when it is missing.
 *
 * @module dsh-commandcode-go-provider
 */
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { assertUsableApiKey, errorChain, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_REQUEST_IMAGE_BYTES, DEFAULT_MAX_TOKENS } from './adapter.js';
import { DEFAULT_SERVED_PLANS, fetchCatalog, fetchClientModels, fetchGoModels } from './models.js';
export { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_REQUEST_IMAGE_BYTES, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, } from './adapter.js';
export { DEFAULT_SERVED_PLANS, fetchCatalog, fetchClientModels, fetchGoModels, imageCapable, isGoPlan, isServedPlan, parseCatalog, } from './models.js';
export { chunkState } from './protocol.js';
export const name = 'commandcode-go-provider';
export const inject = ['llm'];
const DEFAULT_PROVIDER = 'commandcode';
const DEFAULT_DISPLAY_NAME = 'Command Code Go';
const DEFAULT_SETTINGS_NS = 'commandcode-go-provider';
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY';
/** Default gateway base; `/alpha/generate` is appended. */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai';
export const AccountProfile = z.object({
    displayName: z.string(),
    apiKeyEnv: z.string().role('credential-ref'),
    baseURL: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    defaultContextWindow: z.number().step(1).min(1),
    maxRequestImageBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    retryPolicy: RetryPolicySchema,
});
export const Config = z.object({
    accounts: z.dict(AccountProfile).default({}).volatile(),
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
    baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS).volatile(),
    defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
    maxRequestImageBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).volatile(),
    plans: z.string().default(DEFAULT_SERVED_PLANS.join(',')).volatile(),
    retryPolicy: RetryPolicySchema.volatile(),
    http1: z.boolean().default(false).volatile(),
});
/**
 * The committed configuration as plain mutable values, which is the {@link Config}
 * shape {@link resolveAccounts} and {@link multiAccount} consume. Unwrapping the
 * references yields immutable snapshots; cloning is what makes them workable again.
 */
function liveConfig(config) {
    return structuredClone({
        accounts: config.accounts.get(),
        apiKeyEnv: config.apiKeyEnv.get(),
        baseURL: config.baseURL.get(),
        maxTokens: config.maxTokens.get(),
        defaultContextWindow: config.defaultContextWindow.get(),
        maxRequestImageBytes: config.maxRequestImageBytes.get(),
        plans: config.plans.get(),
        retryPolicy: config.retryPolicy.get(),
        http1: config.http1.get(),
    });
}
/** Whether the config declares named accounts rather than the default single one. */
function multiAccount(config) {
    return Object.keys(config.accounts ?? {}).length > 0;
}
/**
 * The one explicit resolve step from raw config to per-route connection
 * facts. An absent or empty `accounts` dictionary means one synthetic default
 * account on the top-level fields; otherwise every key is a route and the
 * top-level fields are each account's shared defaults. Bounds are the
 * schema's job, so this only maps.
 */
export function resolveAccounts(config, scanned) {
    const declared = Object.entries(config.accounts ?? {});
    const routes = declared.length === 0
        ? [[DEFAULT_PROVIDER, undefined]]
        : declared;
    return new Map(routes.map(([key, profile]) => [key, {
            // The synthetic single account keeps the product label; a declared
            // account falls back to its own key, like the official pi-ai adapter.
            displayName: profile?.displayName ?? (profile === undefined ? DEFAULT_DISPLAY_NAME : key),
            apiKeyEnv: credentialRef(profile?.apiKeyEnv ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
            baseURL: profile?.baseURL ?? config.baseURL ?? DEFAULT_BASE_URL,
            maxTokens: profile?.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
            defaultContextWindow: profile?.defaultContextWindow ?? config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
            maxRequestImageBytes: profile?.maxRequestImageBytes ?? config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
            models: scanned,
            retryPolicy: resolveRetryPolicy(profile?.retryPolicy ?? config.retryPolicy, 'commandcode-go-provider: retryPolicy'),
            http1: config.http1 ?? false,
        }]));
}
export function apply(ctx, config) {
    // The live-scanned catalog lives OUTSIDE the settings-backed config so a
    // scan cannot be clobbered by a settings snapshot; every account reads the
    // merged view through this thunk.
    let scanned = [];
    // The Loader owns this namespace, so the configuration form is addressed by
    // the profile entry id that mounted this plugin.
    const settingsNs = ctx.fiber.entry?.options.id ?? DEFAULT_SETTINGS_NS;
    let lastRaw;
    let lastScanned;
    let memoized;
    const accounts = () => {
        const raw = liveConfig(config);
        // The resolved snapshot must stay identical across operations that observe
        // no change, so it is memoized on the committed configuration plus the scan.
        if (memoized !== undefined && lastScanned === scanned && lastRaw !== undefined
            && deepEqualJson(raw, lastRaw)) {
            return memoized;
        }
        const next = resolveAccounts(raw, scanned);
        lastRaw = raw;
        lastScanned = scanned;
        memoized = next;
        return next;
    };
    const resolveApiKey = async (provider) => {
        const account = accounts().get(provider);
        if (account === undefined) {
            throw new LlmError(`commandcode-go-provider: provider route "${provider}" has no account`, 'INVALID_ADAPTER');
        }
        const ref = account.apiKeyEnv;
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            if (hit !== undefined)
                return assertUsableApiKey(hit.value, 'commandcode-go-provider', ref);
        }
        else {
            const ambient = launchEnvironmentOf(ctx).get(ref);
            if (ambient !== undefined && ambient.value.length > 0) {
                return assertUsableApiKey(ambient.value, 'commandcode-go-provider', ref);
            }
        }
        throw new LlmError(`commandcode-go-provider: no API key for provider route "${provider}"; store ${ref} through the credentials`
            + ` service (the web Models page writes it), or export ${ref} in the launching environment`, 'MISSING_CREDENTIAL');
    };
    const adapter = new CommandCodeGoAdapter({
        account: (provider) => {
            const account = accounts().get(provider);
            if (account === undefined) {
                throw new LlmError(`commandcode-go-provider: provider route "${provider}" has no account`, 'INVALID_ADAPTER');
            }
            return account;
        },
        resolveApiKey,
        // Resolved lazily at request time: the service is present in every web
        // deployment, and a context without one degrades to the adapter's clear
        // image error instead of a raw cordis trap message.
        resolveAttachments: () => {
            try {
                return ctx.get('attachments');
            }
            catch {
                return undefined;
            }
        },
        // Bridges the stored image object into the current tool execution world, so
        // an offloaded occurrence still names a path the model can read.
        resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    });
    /**
     * Directory entries: one configurable provider per account. Sorted by
     * route id, so a settings write that merely reorders keys is not mistaken
     * for a change. The single account addresses the section root (the stored
     * shape it has always had); declared accounts address their own
     * `accounts.<key>` scope, like the official pi-ai adapter.
     */
    const directoryEntries = () => {
        const declared = multiAccount(liveConfig(config));
        return [...accounts().entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([provider, account]) => ({
            provider,
            displayName: account.displayName,
            settingsNs,
            settingsPath: declared ? ['accounts', provider] : [],
        }));
    };
    /**
     * Registration facts: a change here must re-register the adapter routes.
     * Sorted like the directory entries for the same reason.
     */
    const registrationFacts = () => [...accounts().entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, account]) => ({ provider, retryPolicy: account.retryPolicy }));
    let directory;
    let registeredDirectory;
    const ensureDirectory = () => {
        const entries = directoryEntries();
        if (deepEqualJson(entries, registeredDirectory))
            return;
        if (directory === undefined)
            directory = ctx.llm.registerConfigurableProviders(entries);
        else
            directory.replace(entries);
        registeredDirectory = entries;
    };
    let registration;
    let registeredFacts;
    const ensureRegistrationFacts = () => {
        const facts = registrationFacts();
        if (deepEqualJson(facts, registeredFacts))
            return;
        const routes = [...accounts().keys()].sort();
        if (registration === undefined)
            registration = ctx.llm.registerAdapter(routes, adapter);
        else
            registration.replace(routes);
        registeredFacts = facts;
    };
    ensureDirectory();
    ensureRegistrationFacts();
    // Every field is volatile, so the Loader commits a settings write into this
    // fiber and announces it here instead of remounting; re-derive the routes.
    ctx.on('loader/volatile-update', () => {
        try {
            ensureRegistrationFacts();
        }
        catch (error) {
            ctx.logger.error('[commandcode-go-provider] keeping the previously registered routes after a refused update: %s', errorChain(error));
        }
        try {
            ensureDirectory();
        }
        catch (error) {
            ctx.logger.error('[commandcode-go-provider] keeping the previous configurable-provider directory after a refused update: %s', errorChain(error));
        }
    });
    /**
     * Best-effort record of the last scan, so a missing model can be told apart
     * from a catalog that never loaded without attaching a debugger.
     */
    const STATUS_FILE = join(homedir(), '.dsh', 'commandcode-go-provider-status.json');
    const recordStatus = (facts) => {
        try {
            writeFileSync(STATUS_FILE, JSON.stringify(facts, null, 2) + '\n');
        }
        catch {
            // Diagnostics must never break the provider.
        }
    };
    /**
     * Publish a finished scan. The GUI client loads its one model catalog when it
     * mounts and rebuilds it only on `llm/adapters-updated`, so a catalog that
     * arrives after that first load would otherwise stay invisible for the life
     * of the app. Re-registering the same routes is the public way to emit the
     * event: the LLM service announces every commit, even an unchanged set.
     */
    const announce = () => {
        try {
            ensureRegistrationFacts();
            ensureDirectory();
            if (registration !== undefined)
                registration.replace([...accounts().keys()].sort());
            return 'ok';
        }
        catch (error) {
            ctx.logger.warn('[commandcode-go-provider] could not announce the refreshed catalog: %s', errorChain(error));
            return errorChain(error);
        }
    };
    const SCAN_INTERVAL_MS = 30 * 60 * 1000;
    const SCAN_RETRY_MIN_MS = 15 * 1000;
    const SCAN_RETRY_MAX_MS = 5 * 60 * 1000;
    let scanTimer;
    let retryDelay = SCAN_RETRY_MIN_MS;
    const scheduleScan = (delay) => {
        scanTimer = setTimeout(runScan, delay);
        // A pending re-scan must not hold the process open on shutdown.
        scanTimer.unref?.();
    };
    /** Scan the served-plan catalog and swap it into the adapter's view. */
    async function sync() {
        // The client view first: it carries plan membership, efforts, and
        // modalities, so the filter no longer depends on the CLI's build-time
        // reference, which lags every model the service ships after a release.
        let source = 'client';
        let next;
        try {
            const plans = config.plans.get().split(',').map(part => part.trim()).filter(part => part.length > 0);
            next = await fetchClientModels({ plans });
        }
        catch (error) {
            source = 'fallback';
            ctx.logger.warn('[commandcode-go-provider] client catalog unavailable (%s); falling back to the published CLI reference', errorChain(error));
            next = await fetchGoModels(await fetchCatalog());
        }
        if (next.length === 0) {
            throw new Error('no models found; keeping the previous catalog');
        }
        if (deepEqualJson(next, scanned))
            return source;
        scanned = next;
        ctx.logger.info('[commandcode-go-provider] synced %d model(s) via %s: %s', next.length, source, next.map(m => m.id).join(', '));
        return source;
    }
    const runScan = () => {
        scanTimer = undefined;
        void sync().then((source) => {
            retryDelay = SCAN_RETRY_MIN_MS;
            const announced = announce();
            recordStatus({
                at: new Date().toISOString(),
                ok: true,
                source,
                announced,
                count: scanned.length,
                ids: scanned.map(model => model.id),
            });
            // One more poke for a client whose subscription landed just after the event.
            setTimeout(() => announce(), 15_000).unref?.();
            scheduleScan(SCAN_INTERVAL_MS);
        }, (error) => {
            recordStatus({ at: new Date().toISOString(), ok: false, error: errorChain(error), count: scanned.length });
            ctx.logger.warn('[commandcode-go-provider] catalog scan failed; retrying in %dms: %s', retryDelay, errorChain(error));
            scheduleScan(retryDelay);
            retryDelay = Math.min(retryDelay * 2, SCAN_RETRY_MAX_MS);
        });
    };
    // A pending re-scan must not outlive the plugin.
    ctx.effect(() => () => {
        if (scanTimer !== undefined) {
            clearTimeout(scanTimer);
            scanTimer = undefined;
        }
    });
    runScan();
}
