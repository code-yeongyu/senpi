/**
 * Claude Code version the Anthropic OAuth `claude-cli/<version>` fingerprint advertises.
 *
 * Anthropic gates new models behind a minimum Claude Code version and answers an older
 * fingerprint with HTTP 400 `claude_code_version_too_old`. A build-time constant goes stale
 * between releases, so the fingerprint is the higher of the bundled floor and the latest
 * published Claude Code release, resolved in the background and cached by the host through
 * `ClaudeCodeVersionStore`. A request never waits on the lookup: it signs with whatever is
 * known at that instant, and a too-old rejection raises the version at once.
 */
import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

/** Exact `X.Y.Z` pins the fingerprint and skips the network lookup. */
export const CLAUDE_CODE_VERSION_PIN_ENV = "PI_CLAUDE_CODE_VERSION";

/**
 * Anthropic's native-installer release channel. `stable` lags the npm package during a staged
 * rollout, so `latest` is the channel that matches what a freshly updated Claude Code reports.
 */
export const CLAUDE_RELEASE_CHANNEL_URL =
	"https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest";
export const CLAUDE_NPM_DIST_TAG_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const EXACT_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const EMBEDDED_SEMVER = /(\d+\.\d+\.\d+)/;
const TOO_OLD_REJECTION = /claude_code_version_too_old|does not support this model; version (\d+\.\d+\.\d+) or newer/i;

export interface CachedClaudeCodeVersion {
	readonly version: string;
	readonly checkedAt: number;
}

export interface ClaudeCodeVersionStore {
	load(): CachedClaudeCodeVersion | undefined;
	save(record: CachedClaudeCodeVersion): void;
}

export interface ClaudeCodeVersionResolverOptions {
	readonly floor: string;
	readonly pinned?: string | undefined;
	/** `null` disables caching and network resolution: the resolver answers the floor or a raised version. */
	readonly store: ClaudeCodeVersionStore | null;
	/** Serve the cache but never fetch (host offline mode). */
	readonly offline?: boolean;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly refreshIntervalMs?: number;
}

export interface ClaudeCodeVersionResolver {
	/** Current fingerprint; schedules one background refresh when the cache is stale. */
	get(): string;
	/** Refresh now (deduplicated); resolves with the fingerprint afterwards. */
	refresh(): Promise<string>;
	/** Adopt `version` at once when it is newer than the current fingerprint; returns the fingerprint. */
	raise(version: string): string;
}

export function compareClaudeCodeVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function isExactSemver(value: unknown): value is string {
	return typeof value === "string" && EXACT_SEMVER.test(value);
}

function highest(candidates: ReadonlyArray<string | undefined>): string | undefined {
	let best: string | undefined;
	for (const candidate of candidates) {
		if (!isExactSemver(candidate)) continue;
		if (best === undefined || compareClaudeCodeVersions(candidate, best) > 0) best = candidate;
	}
	return best;
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string | undefined> {
	try {
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		return response.ok ? await response.text() : undefined;
	} catch {
		// Offline, DNS failure, or timeout: the caller keeps the floor or the cached value.
		return undefined;
	}
}

async function fetchReleaseChannel(fetchImpl: typeof fetch): Promise<string | undefined> {
	const text = await fetchText(fetchImpl, CLAUDE_RELEASE_CHANNEL_URL);
	return text === undefined ? undefined : EMBEDDED_SEMVER.exec(text.trim())?.[1];
}

async function fetchNpmDistTag(fetchImpl: typeof fetch): Promise<string | undefined> {
	const text = await fetchText(fetchImpl, CLAUDE_NPM_DIST_TAG_URL);
	if (text === undefined) return undefined;
	try {
		const data: unknown = JSON.parse(text);
		const version = typeof data === "object" && data !== null && "version" in data ? data.version : undefined;
		return typeof version === "string" ? EMBEDDED_SEMVER.exec(version)?.[1] : undefined;
	} catch {
		// A registry error page is not a dist-tag document.
		return undefined;
	}
}

/**
 * Latest published Claude Code version: the higher of the native-installer `latest` channel and
 * the npm dist-tag, so one lagging or unavailable source cannot hold the fingerprint back.
 */
export async function fetchLatestClaudeCodeVersion(fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
	return highest(await Promise.all([fetchReleaseChannel(fetchImpl), fetchNpmDistTag(fetchImpl)]));
}

export function requiredClaudeCodeVersionFromError(message: string): string | undefined {
	const match = TOO_OLD_REJECTION.exec(message);
	if (!match) return undefined;
	return match[1] ?? /version (\d+\.\d+\.\d+) or newer/i.exec(message)?.[1];
}

export function isClaudeCodeVersionTooOldError(error: unknown): error is Error & { status: 400 } {
	return error instanceof Error && "status" in error && error.status === 400 && TOO_OLD_REJECTION.test(error.message);
}

export function createClaudeCodeVersionResolver(options: ClaudeCodeVersionResolverOptions): ClaudeCodeVersionResolver {
	const { floor, store } = options;
	const offline = options.offline === true;
	const fetchImpl = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
	const pinned = isExactSemver(options.pinned) ? options.pinned : undefined;

	let loaded = false;
	let resolved: string | undefined;
	let checkedAt = 0;
	let inflight: Promise<string> | undefined;

	const current = (): string =>
		resolved !== undefined && compareClaudeCodeVersions(resolved, floor) > 0 ? resolved : floor;

	const loadCache = (): void => {
		if (loaded || store === null) return;
		loaded = true;
		const record = store.load();
		if (record && isExactSemver(record.version) && Number.isFinite(record.checkedAt)) {
			resolved = record.version;
			checkedAt = record.checkedAt;
		}
	};

	const persist = (): void => {
		if (store !== null && resolved !== undefined) store.save({ version: resolved, checkedAt });
	};

	const refresh = (): Promise<string> => {
		if (pinned !== undefined || store === null) return Promise.resolve(pinned ?? current());
		loadCache();
		if (offline) return Promise.resolve(current());
		inflight ??= (async () => {
			try {
				const latest = await fetchLatestClaudeCodeVersion(fetchImpl);
				// A failed lookup still counts as a check: an offline host waits a full interval
				// before trying again instead of retrying on every request.
				checkedAt = now();
				if (latest !== undefined && (resolved === undefined || compareClaudeCodeVersions(latest, resolved) > 0)) {
					resolved = latest;
				}
				persist();
			} finally {
				inflight = undefined;
			}
			return current();
		})();
		return inflight;
	};

	return {
		get() {
			if (pinned !== undefined) return pinned;
			if (store === null) return current();
			loadCache();
			if (!offline && inflight === undefined && now() - checkedAt >= refreshIntervalMs) void refresh();
			return current();
		},
		refresh,
		raise(version) {
			if (pinned !== undefined) return pinned;
			loadCache();
			if (isExactSemver(version) && compareClaudeCodeVersions(version, current()) > 0) {
				resolved = version;
				persist();
			}
			return current();
		},
	};
}

let installedStore: ClaudeCodeVersionStore | null = null;
let installedOffline = false;
let defaultResolver: ClaudeCodeVersionResolver | undefined;
let defaultFloor: string | undefined;

/**
 * Hosts with a filesystem install their cache here once at startup (see
 * `utils/claude-code-version-cache.ts`); until then, and in browsers, the resolver answers
 * the floor without touching the network.
 */
export function installClaudeCodeVersionStore(
	store: ClaudeCodeVersionStore | null,
	options: { readonly offline?: boolean } = {},
): void {
	installedStore = store;
	installedOffline = options.offline === true;
	defaultResolver = undefined;
}

function resolver(floor: string): ClaudeCodeVersionResolver {
	if (defaultResolver === undefined || defaultFloor !== floor) {
		defaultFloor = floor;
		defaultResolver = createClaudeCodeVersionResolver({ floor, store: installedStore, offline: installedOffline });
	}
	return defaultResolver;
}

function pinnedClaudeCodeVersion(env?: ProviderEnv): string | undefined {
	const pin = getProviderEnvValue(CLAUDE_CODE_VERSION_PIN_ENV, env)?.trim();
	return isExactSemver(pin) ? pin : undefined;
}

/**
 * The version the next OAuth request signs with. `floor` is the bundled Claude Code version the
 * caller declares (the `claudeCodeVersion` constant in `api/anthropic-messages.ts`).
 */
export function getClaudeCodeVersion(floor: string, env?: ProviderEnv): string {
	return pinnedClaudeCodeVersion(env) ?? resolver(floor).get();
}

/**
 * After a `claude_code_version_too_old` rejection: adopt the version the error names, or the
 * latest published one, and report the fingerprint to retry with; `undefined` when nothing
 * newer is available (pinned, or already at the required version).
 */
export async function recoverClaudeCodeVersion(
	error: Error,
	floor: string,
	advertised: string,
	env?: ProviderEnv,
): Promise<string | undefined> {
	if (pinnedClaudeCodeVersion(env) !== undefined) return undefined;
	const required = requiredClaudeCodeVersionFromError(error.message);
	const next = required === undefined ? await resolver(floor).refresh() : resolver(floor).raise(required);
	return compareClaudeCodeVersions(next, advertised) > 0 ? next : undefined;
}

export function claudeCodeVersionTooOldHint(advertised: string): string {
	return `senpi advertised claude-cli/${advertised}; Anthropic requires a newer Claude Code for this model. senpi refreshes the version automatically when online; set ${CLAUDE_CODE_VERSION_PIN_ENV}=X.Y.Z to advertise a specific one.`;
}
