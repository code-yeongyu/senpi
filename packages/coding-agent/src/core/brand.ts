/**
 * Brand profile resolution.
 *
 * A distribution that repackages this engine (for example the `omo-ai` package) injects a
 * single JSON environment variable describing how the product presents itself. The engine
 * parses it once at startup and then REMOVES it from the environment, so nested processes
 * spawned by tools inherit a clean environment and keep the engine's own identity.
 *
 * Absent or malformed input leaves every brand-derived value at its standalone default, so a
 * plain install behaves exactly as it did before this module existed.
 */

/** Environment variable carrying the JSON brand profile. */
export const BRAND_ENV_VAR = "SENPI_BRAND";

/**
 * Where a repackaging distribution publishes itself. Without this the engine keeps checking
 * its own package, which would advertise an update the branded product cannot install.
 */
export interface BrandUpdateChannel {
	/** Registry package that ships the branded product, e.g. `omo-ai`. */
	readonly packageName: string;
	/** Dist-tag the product publishes on, e.g. `beta`. */
	readonly distTag: string;
	/** Command shown to the user, e.g. `npm i -g omo-ai@beta`. */
	readonly command: string;
	/** Release notes URL; `{version}` is replaced with the available version. */
	readonly changelogUrl?: string;
}

export interface BrandProfile {
	/** Product name shown to users and to the model. */
	readonly name: string;
	/** Version shown in the header, terminal titles and `--version`. */
	readonly displayVersion?: string;
	/** Config directory name, e.g. `.omo`. */
	readonly configDir: string;
	/** When true the agent state lives directly under the config directory, with no `agent` segment. */
	readonly flatLayout: boolean;
	/** Prefix for the product's environment variables, e.g. `OMO`. */
	readonly envPrefix: string;
	/** Product token used in the outgoing user agent. */
	readonly userAgent: string;
	/** Product token used as the provider-side originator, when the distribution overrides it. */
	readonly originator?: string;
	/** Update channel of the branded product; absent means the product manages updates itself. */
	readonly update?: BrandUpdateChannel;
}

function readUpdateChannel(source: Record<string, unknown>): BrandUpdateChannel | undefined {
	const update = source.update;
	if (typeof update !== "object" || update === null || Array.isArray(update)) return undefined;

	const channel = update as Record<string, unknown>;
	const packageName = readString(channel, "packageName");
	const command = readString(channel, "command");
	if (!packageName || !command) return undefined;

	return {
		packageName,
		distTag: readString(channel, "distTag") || "latest",
		command,
		changelogUrl: readString(channel, "changelogUrl"),
	};
}

/**
 * A config directory names ONE entry inside the home directory. Anything carrying a separator or
 * a parent reference would move agent state - and the migration that copies into it - somewhere
 * the user never agreed to, so such a profile is rejected rather than sanitised.
 */
function isSafeConfigDirName(value: string): boolean {
	return value !== "." && value !== ".." && !/[\\/]/.test(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Parses a brand profile. Returns undefined for absent, malformed, or nameless input; a
 * malformed profile is reported once on stderr and never throws, because a broken brand
 * must not stop the agent from starting.
 */
export function parseBrandProfile(raw: string | undefined): BrandProfile | undefined {
	if (!raw?.trim()) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		process.stderr.write(`warning: ignoring malformed ${BRAND_ENV_VAR} (expected JSON)\n`);
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		process.stderr.write(`warning: ignoring malformed ${BRAND_ENV_VAR} (expected a JSON object)\n`);
		return undefined;
	}

	const source = parsed as Record<string, unknown>;
	const name = readString(source, "name");
	if (!name) {
		process.stderr.write(`warning: ignoring ${BRAND_ENV_VAR} without a "name"\n`);
		return undefined;
	}

	const configDir = readString(source, "configDir") || `.${name}`;
	if (!isSafeConfigDirName(configDir)) {
		process.stderr.write(`warning: ignoring ${BRAND_ENV_VAR} with an unsafe "configDir"\n`);
		return undefined;
	}

	return {
		name,
		displayVersion: readString(source, "displayVersion"),
		configDir,
		flatLayout: source.flatLayout === true,
		envPrefix: (readString(source, "envPrefix") || name).toUpperCase(),
		userAgent: readString(source, "userAgent") || name,
		originator: readString(source, "originator"),
		update: readUpdateChannel(source),
	};
}

/**
 * Parses the brand profile without touching the environment.
 *
 * The CLI entrypoint re-spawns the real agent as a child process and hands it `process.env`,
 * so the variable has to survive that hop. Scrubbing therefore happens explicitly in the
 * process that actually runs the agent - see `scrubBrandFromEnvironment`.
 */
export function consumeBrandProfile(env: NodeJS.ProcessEnv = process.env): BrandProfile | undefined {
	return parseBrandProfile(env[BRAND_ENV_VAR]);
}

/**
 * Removes the brand variable so tools spawning the engine again inherit a clean environment
 * and keep the engine's own identity. Called once the profile has been resolved by the
 * process that runs the agent loop.
 */
export function scrubBrandFromEnvironment(env: NodeJS.ProcessEnv = process.env): void {
	delete env[BRAND_ENV_VAR];
}

/**
 * Environment prefixes read after the brand's own prefix, so a machine configured before the
 * rebrand keeps working unchanged.
 */
const LEGACY_ENV_PREFIXES = ["SENPI", "PI"] as const;

let cachedProfile: BrandProfile | undefined;
let profileResolved = false;

/**
 * The active brand profile, resolved (and scrubbed from the environment) on first use.
 */
export function brandProfile(): BrandProfile | undefined {
	if (!profileResolved) {
		cachedProfile = consumeBrandProfile();
		profileResolved = true;
	}
	return cachedProfile;
}

/** exported for tests only */
export function resetBrandProfileForTests(): void {
	cachedProfile = undefined;
	profileResolved = false;
}

/** Environment variable names for one setting, most specific first. */
export function brandEnvNames(suffix: string, profile = brandProfile()): string[] {
	const prefixes = [profile?.envPrefix, ...LEGACY_ENV_PREFIXES].filter(
		(prefix): prefix is string => typeof prefix === "string" && prefix.length > 0,
	);
	return [...new Set(prefixes)].map((prefix) => `${prefix}_${suffix}`);
}

/**
 * Reads one setting across the brand's prefix and the legacy prefixes, returning the first
 * DEFINED value so that an explicitly empty value keeps its existing meaning.
 */
export function envValue(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	for (const name of brandEnvNames(suffix)) {
		const value = env[name];
		if (value !== undefined) return value;
	}
	return undefined;
}
